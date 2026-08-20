import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, getOpenRouterApiKey, getSettings, rootDir } from "./db.js";

export type BenchmarkStrategy = "one-step" | "one-step-depth" | "one-step-predicted-depth" | "two-step" | "two-step-depth" | "two-step-predicted-depth";

type Prediction = {
  dishName: string;
  totalMass: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  confidence: number;
  assumptions: string[];
};

type CaseRow = {
  id: string;
  name: string;
  image_path: string;
  depth_path: string | null;
  source: string;
  source_id: string | null;
  source_url: string | null;
  ingredients_json: string;
  truth_mass: number;
  truth_calories: number;
  truth_protein: number;
  truth_carbs: number;
  truth_fat: number;
};

const promptVersion = "cvpr-two-step-v2-reasoning-controlled";

type OpenRouterUsage = {
  cost?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
};

type ModelReasoning = {
  mandatory?: boolean;
  supported_efforts?: string[];
};

let modelDirectoryPromise: Promise<Array<Record<string, unknown>>> | undefined;

async function modelReasoningSettings(model: string) {
  modelDirectoryPromise ??= fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15_000) })
    .then(async (response) => response.ok ? ((await response.json()) as { data?: Array<Record<string, unknown>> }).data ?? [] : [])
    .catch(() => []);
  const metadata = (await modelDirectoryPromise).find((item) => item.id === model);
  const reasoning = metadata?.reasoning as ModelReasoning | undefined;
  if (!reasoning) return { maxTokens: 1024 };
  if (reasoning.mandatory) {
    const effort = reasoning.supported_efforts?.includes("minimal") ? "minimal" : "low";
    return { maxTokens: 2048, reasoning: { effort, exclude: true } };
  }
  return { maxTokens: 1024, reasoning: { effort: "none", exclude: true } };
}

function localAsset(relativePath: string) {
  const relative = relativePath.replace(/^\//, "");
  const absolute = path.resolve(rootDir, relative.startsWith("benchmark/") ? path.join("data", relative) : path.join("data", relative));
  const dataRoot = path.resolve(rootDir, "data") + path.sep;
  if (!absolute.startsWith(dataRoot) || !fs.existsSync(absolute)) throw new Error(`Benchmark image is missing: ${relativePath}`);
  return absolute;
}

function imagePart(relativePath: string, label?: string) {
  const absolute = localAsset(relativePath);
  const extension = path.extname(absolute).toLowerCase();
  const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
  return {
    label,
    part: { type: "image_url", image_url: { url: `data:${mime};base64,${fs.readFileSync(absolute).toString("base64")}` } }
  };
}

function predictedDepthPath(benchmarkCase: CaseRow) {
  const candidate = benchmarkCase.image_path.replace(/-rgb\.(png|jpe?g|webp)$/i, "-depth-predicted.png");
  if (candidate === benchmarkCase.image_path) return null;
  try { localAsset(candidate); return candidate; } catch { return null; }
}

async function structuredOpenRouter(model: string, prompt: string, images: string[], schemaName: string, schema: Record<string, unknown>) {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) throw new Error("OpenRouter is not configured. Save an API key in Settings.");
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const image of images) content.push(imagePart(image).part);
  const reasoningSettings = await modelReasoningSettings(model);
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
      "HTTP-Referer": process.env.APP_URL || "http://localhost:8787",
      "X-OpenRouter-Title": "Jamtytrack Nutrition Benchmark"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      temperature: 0.5,
      max_tokens: reasoningSettings.maxTokens,
      ...(reasoningSettings.reasoning ? { reasoning: reasoningSettings.reasoning } : {}),
      response_format: { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } },
      provider: { require_parameters: true }
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const payload = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string } }>; error?: { message?: string }; usage?: OpenRouterUsage };
  if (!response.ok) throw new Error(payload.error?.message || `OpenRouter returned ${response.status}`);
  const raw = payload.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    const finishReason = payload.choices?.[0]?.finish_reason || "unknown";
    throw new Error(`${model} returned no structured answer (finish reason: ${finishReason}).`);
  }
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; }
  catch { throw new Error(`${model} returned invalid structured JSON.`); }
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) throw new Error(`${model} omitted required result fields: ${missing.join(", ")}.`);
  return { value, usage: payload.usage };
}

const predictionProperties = {
  dishName: { type: "string", description: "Concise name for the complete dish." },
  totalMass: { type: "number", minimum: 0, description: "Estimated total edible mass in grams." },
  calories: { type: "number", minimum: 0, description: "Total energy in kilocalories for all visible edible food." },
  protein: { type: "number", minimum: 0, description: "Total protein in grams." },
  carbs: { type: "number", minimum: 0, description: "Total carbohydrates in grams." },
  fat: { type: "number", minimum: 0, description: "Total fat in grams, including cooking oil." },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  assumptions: { type: "array", items: { type: "string" }, description: "Material uncertainties such as hidden oil or ambiguous foods." }
};

const predictionSchema = {
  type: "object",
  additionalProperties: false,
  required: Object.keys(predictionProperties),
  properties: predictionProperties
};

const foodAnalysisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["dishName", "totalEstimatedMass", "components", "uncertainties"],
  properties: {
    dishName: { type: "string" },
    totalEstimatedMass: { type: "number", minimum: 0 },
    components: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "estimatedGrams", "ediblePercentage", "oilGrams", "cookingMethod", "visualEvidence"],
        properties: {
          name: { type: "string" },
          estimatedGrams: { type: "number", minimum: 0 },
          ediblePercentage: { type: "number", minimum: 0, maximum: 100 },
          oilGrams: { type: "number", minimum: 0 },
          cookingMethod: { type: "string" },
          visualEvidence: { type: "string" }
        }
      }
    },
    uncertainties: { type: "array", items: { type: "string" } }
  }
};

function asPrediction(value: Record<string, unknown>): Prediction {
  return {
    dishName: String(value.dishName || "Unknown dish"),
    totalMass: Number(value.totalMass || 0), calories: Number(value.calories || 0),
    protein: Number(value.protein || 0), carbs: Number(value.carbs || 0), fat: Number(value.fat || 0),
    confidence: Number(value.confidence || 0), assumptions: Array.isArray(value.assumptions) ? value.assumptions.map(String) : []
  };
}

export async function runBenchmark(caseId: string, model: string, strategy: BenchmarkStrategy) {
  const benchmarkCase = db.prepare("SELECT * FROM benchmark_cases WHERE id = ?").get(caseId) as unknown as CaseRow | undefined;
  if (!benchmarkCase) throw new Error("Benchmark case not found");
  if (!model.trim()) throw new Error("Choose an OpenRouter model");
  if (!(["one-step", "one-step-depth", "one-step-predicted-depth", "two-step", "two-step-depth", "two-step-predicted-depth"] as string[]).includes(strategy)) throw new Error("Unknown benchmark strategy");
  const usesSensorDepth = strategy.endsWith("-depth") && !strategy.endsWith("predicted-depth");
  const usesPredictedDepth = strategy.endsWith("predicted-depth");
  const usesOneStep = strategy.startsWith("one-step");
  if (usesSensorDepth && !benchmarkCase.depth_path) throw new Error("This case has no depth image");
  const predictedDepth = predictedDepthPath(benchmarkCase);
  if (usesPredictedDepth && !predictedDepth) throw new Error("This case has no photo-predicted depth image");

  const started = Date.now();
  let prediction: Prediction;
  let trace: Record<string, unknown>;
  const depthInstruction = usesSensorDepth
    ? "The second image is the aligned Nutrition5k colorized RealSense sensor-depth map: nearer pixels are blue and farther pixels are red. Use it only as supporting evidence for relative height and portion volume."
    : usesPredictedDepth
      ? "The second image is a scale-free depth visualization predicted from the RGB photo by Depth Anything V2: nearer pixels are blue and farther pixels are red. It is not a physical measurement and its absolute scale is uncalibrated. Use only relative food height, boundaries, and plate geometry as supporting evidence."
      : "";
  const images = [
    benchmarkCase.image_path,
    ...(usesSensorDepth && benchmarkCase.depth_path ? [benchmarkCase.depth_path] : []),
    ...(usesPredictedDepth && predictedDepth ? [predictedDepth] : [])
  ];

  if (usesOneStep) {
    const prompt = `Estimate nutrition for every edible food in this meal image. Identify ingredients, infer edible grams and cooking oil, then return totals. Use visible plate/utensil geometry as scale evidence. Base nutrient density on reliable references consistent with USDA FoodData Central. Do not assume access to ground truth or metadata. Explicitly list material uncertainty. ${depthInstruction}`;
    const result = await structuredOpenRouter(model, prompt, images, "nutrition_direct", predictionSchema);
    prediction = asPrediction(result.value);
    trace = { direct: result.value, usage: result.usage };
  } else {
    const step1Prompt = `Step 1 - food analysis. Examine the meal before calculating nutrition. Decompose it into all major components. Estimate edible portion grams, edible percentage, absorbed oil, cooking method, and the visual evidence used for scale. Distinguish visually similar foods and name uncertainties. ${depthInstruction}`;
    const step1 = await structuredOpenRouter(model, step1Prompt, images, "food_analysis", foodAnalysisSchema);
    const step2Prompt = `Step 2 - nutrition calculation. Re-check the attached meal image and calculate totals from the structured food analysis below. Sum ingredient-level calories, protein, carbohydrates, and fat using nutrient densities consistent with reliable sources such as USDA FoodData Central. Include absorbed cooking oil. Keep the final edible mass aligned with the component estimates. Do not use benchmark labels or infer that this is a known dataset sample.\n\nFOOD ANALYSIS:\n${JSON.stringify(step1.value)}`;
    const step2 = await structuredOpenRouter(model, step2Prompt, images, "nutrition_two_step", predictionSchema);
    prediction = asPrediction(step2.value);
    trace = { foodAnalysis: step1.value, prediction: step2.value, usage: [step1.usage, step2.usage] };
  }

  const id = randomUUID();
  db.prepare(`INSERT INTO benchmark_runs
    (id, case_id, model, strategy, prompt_version, predicted_mass, predicted_calories, predicted_protein, predicted_carbs, predicted_fat, response_json, latency_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, caseId, model, strategy, promptVersion, prediction.totalMass, prediction.calories, prediction.protein, prediction.carbs, prediction.fat, JSON.stringify(trace), Date.now() - started);
  return getBenchmarkRun(id);
}

function metric(predicted: number, truth: number) {
  const absolute = Math.abs(predicted - truth);
  return { predicted, truth, absolute, absolutePercent: truth ? absolute / truth * 100 : 0 };
}

export function getBenchmarkRun(id: string) {
  const row = db.prepare(`SELECT r.*, c.truth_mass, c.truth_calories, c.truth_protein, c.truth_carbs, c.truth_fat
    FROM benchmark_runs r JOIN benchmark_cases c ON c.id = r.case_id WHERE r.id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const metrics = {
    mass: metric(Number(row.predicted_mass), Number(row.truth_mass)),
    calories: metric(Number(row.predicted_calories), Number(row.truth_calories)),
    protein: metric(Number(row.predicted_protein), Number(row.truth_protein)),
    carbs: metric(Number(row.predicted_carbs), Number(row.truth_carbs)),
    fat: metric(Number(row.predicted_fat), Number(row.truth_fat))
  };
  let usages: OpenRouterUsage[] = [];
  try {
    const trace = JSON.parse(String(row.response_json)) as { usage?: OpenRouterUsage | OpenRouterUsage[] };
    usages = Array.isArray(trace.usage) ? trace.usage : trace.usage ? [trace.usage] : [];
  } catch { /* Older imported runs can omit trace metadata. */ }
  const usage = {
    costUsd: usages.reduce((sum, item) => sum + Number(item.cost || 0), 0),
    inputTokens: usages.reduce((sum, item) => sum + Number(item.prompt_tokens || 0), 0),
    outputTokens: usages.reduce((sum, item) => sum + Number(item.completion_tokens || 0), 0),
    reasoningTokens: usages.reduce((sum, item) => sum + Number(item.completion_tokens_details?.reasoning_tokens || 0), 0)
  };
  return {
    id: row.id, caseId: row.case_id, model: row.model, strategy: row.strategy, promptVersion: row.prompt_version,
    latencyMs: row.latency_ms, createdAt: row.created_at, metrics, usage,
    macroAbsoluteError: (metrics.protein.absolute + metrics.carbs.absolute + metrics.fat.absolute) / 3
  };
}

export function listBenchmarkCases() {
  const cases = db.prepare("SELECT * FROM benchmark_cases ORDER BY created_at, id").all() as unknown as CaseRow[];
  const runIds = db.prepare("SELECT id, case_id FROM benchmark_runs ORDER BY created_at DESC").all() as Array<{ id: string; case_id: string }>;
  return cases.map((item) => ({
    id: item.id, name: item.name, imagePath: item.image_path, depthPath: item.depth_path, predictedDepthPath: predictedDepthPath(item),
    source: item.source, sourceId: item.source_id, sourceUrl: item.source_url,
    ingredients: JSON.parse(item.ingredients_json),
    truth: { mass: item.truth_mass, calories: item.truth_calories, protein: item.truth_protein, carbs: item.truth_carbs, fat: item.truth_fat },
    runs: runIds.filter((run) => run.case_id === item.id).map((run) => getBenchmarkRun(run.id))
  }));
}

export async function listVisionModels() {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models?input_modalities=image&supported_parameters=structured_outputs&sort=most-popular", { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("model directory unavailable");
    const payload = await response.json() as { data?: Array<Record<string, unknown>> };
    return (payload.data ?? []).filter((model) => {
      const architecture = model.architecture as { output_modalities?: string[] } | undefined;
      return architecture?.output_modalities?.includes("text");
    }).slice(0, 40).map((model) => ({
      id: model.id, name: model.name, contextLength: model.context_length,
      pricing: model.pricing, supportedParameters: model.supported_parameters
    }));
  } catch {
    const configured = process.env.OPENROUTER_MODEL || getSettings().openrouter_model;
    return [{ id: configured, name: configured, contextLength: null, pricing: null, supportedParameters: ["structured_outputs"] }];
  }
}
