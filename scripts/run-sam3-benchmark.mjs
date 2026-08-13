import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = path.join(root, "data", "benchmark", "nutrition5k");
const falKey = process.env.FAL_KEY;
const endpoint = "https://queue.fal.run/fal-ai/sam-3/image";

if (!falKey) throw new Error("Set FAL_KEY for this process before running the SAM 3 benchmark.");

const requestedDish = process.argv[2];
const files = (await fs.readdir(dataDir))
  .filter((name) => /^dish_\d+-rgb\.png$/.test(name))
  .filter((name) => !requestedDish || name.includes(requestedDish))
  .sort();

if (!files.length) throw new Error(`No benchmark image matched ${requestedDish || "the Nutrition5k directory"}.`);

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Key ${falKey}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(120_000)
  });
  const body = await response.text();
  let payload;
  try { payload = body ? JSON.parse(body) : {}; }
  catch { throw new Error(`fal returned non-JSON (${response.status}): ${body.slice(0, 300)}`); }
  if (!response.ok) throw new Error(`fal returned ${response.status}: ${JSON.stringify(payload)}`);
  return { payload, headers: Object.fromEntries(response.headers.entries()) };
}

async function run(fileName) {
  const dishId = fileName.match(/dish_(\d+)-rgb\.png/)?.[1];
  const imageBytes = await fs.readFile(path.join(dataDir, fileName));
  const imageUrl = `data:image/png;base64,${imageBytes.toString("base64")}`;
  const started = performance.now();
  const submitted = await jsonFetch(endpoint, {
    method: "POST",
    headers: { "X-Fal-Store-IO": "0" },
    body: JSON.stringify({
      image_url: imageUrl,
      prompt: "food",
      apply_mask: false,
      output_format: "png",
      return_multiple_masks: true,
      max_masks: 10,
      include_scores: true,
      include_boxes: true
    })
  });

  const statusUrl = submitted.payload.status_url;
  const responseUrl = submitted.payload.response_url;
  if (!statusUrl || !responseUrl) throw new Error(`fal queue response omitted tracking URLs: ${JSON.stringify(submitted.payload)}`);

  let status;
  do {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    status = (await jsonFetch(`${statusUrl}?logs=1`)).payload;
    process.stdout.write(`${dishId}: ${status.status}${status.queue_position != null ? ` (${status.queue_position} ahead)` : ""}\n`);
  } while (status.status === "IN_QUEUE" || status.status === "IN_PROGRESS");

  if (status.status !== "COMPLETED" || status.error) {
    throw new Error(`SAM 3 failed for ${dishId}: ${status.error || JSON.stringify(status)}`);
  }

  const resultResponse = await jsonFetch(responseUrl);
  const result = resultResponse.payload;
  const prefix = `dish_${dishId}-sam3-food`;
  const masks = Array.isArray(result.masks) ? result.masks : [];
  for (let index = 0; index < masks.length; index += 1) {
    const maskResponse = await fetch(masks[index].url, { signal: AbortSignal.timeout(60_000) });
    if (!maskResponse.ok) throw new Error(`Could not download SAM mask ${index} for ${dishId}.`);
    await fs.writeFile(path.join(dataDir, `${prefix}-mask-${index}.png`), Buffer.from(await maskResponse.arrayBuffer()));
  }

  const summary = {
    dishId,
    endpoint: "fal-ai/sam-3/image",
    prompt: "food",
    requestId: submitted.payload.request_id,
    latencySeconds: (performance.now() - started) / 1000,
    inferenceSeconds: Number(status.metrics?.inference_time || 0),
    billableUnits: resultResponse.headers["x-fal-billable-units"] || submitted.headers["x-fal-billable-units"] || null,
    costUsd: 0.005,
    masks: masks.map((mask, index) => ({
      localPath: `/benchmark/nutrition5k/${prefix}-mask-${index}.png`,
      width: mask.width,
      height: mask.height,
      score: result.scores?.[index] ?? result.metadata?.[index]?.score ?? null,
      box: result.boxes?.[index] ?? result.metadata?.[index]?.box ?? null
    }))
  };
  await fs.writeFile(path.join(dataDir, `${prefix}-result.json`), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const results = [];
for (const file of files) results.push(await run(file));
await fs.writeFile(path.join(dataDir, "sam3-food-summary.json"), `${JSON.stringify({
  model: "fal-ai/sam-3/image",
  prompt: "food",
  cases: results.length,
  totalCostUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
  meanLatencySeconds: results.reduce((sum, result) => sum + result.latencySeconds, 0) / results.length,
  results
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
