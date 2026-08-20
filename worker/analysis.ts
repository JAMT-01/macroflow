import {
  analysisJsonSchema,
  analyzeDescription as analyzeDescriptionCore,
  buildDescriptionPrompt,
  buildSinglePhotoPrompt,
  calculate,
  calculateEstimateRange,
  calibrateAnalysisConfidence,
  clean,
  fallbackMeasurement,
  matchFood,
  normalizeItem,
  normalizeMealTypeSuggestion,
  normalizeMeasurement,
  normalizeScaleReference,
  refinementJsonSchema,
  refinementPrompt,
  suggestArgentineMealType,
  type AnalysisItem,
  type CaptureMetadata,
  type FoodRow,
  type MealAnalysis,
  type MeasurementAssessment,
  type OpenRouterItem,
  type OpenRouterMealTypeSuggestion,
  type OpenRouterMeasurement,
  type ScaleReference
} from "../shared/analysis-core.js";
import { getTimeContext } from "../shared/time.js";
import { getOpenRouterApiKey, getOpenRouterKeySource, getPhoto, getSettings, listFoods, photoKey, type Env } from "./db.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function openRouterHeaders(apiKey: string, env: Env) {
  return {
    "content-type": "application/json",
    "authorization": `Bearer ${apiKey}`,
    "HTTP-Referer": env.APP_URL || "https://jamtytrack.montagnertudor.org",
    "X-OpenRouter-Title": "Jamtytrack"
  };
}

/**
 * Base64 for the OpenRouter data URL. The browser already downscales photos to
 * 1600px / q0.88 before upload, which keeps this inside the 10 ms CPU budget of
 * the Workers free plan; `nodejs_compat` gives us the native Buffer encoder
 * rather than a hand-rolled loop.
 */
function toBase64(bytes: ArrayBuffer) {
  return Buffer.from(bytes).toString("base64");
}

async function imageContent(env: Env, imagePath: string) {
  const photo = await getPhoto(env, photoKey(imagePath));
  if (!photo) return null;
  return { type: "image_url", image_url: { url: `data:${photo.contentType};base64,${toBase64(photo.bytes)}` } };
}

/**
 * Nothing was seen, so the honest range is wider than the model tends to give.
 * Floors the spread at 40% either side unless the user stated a weight.
 */
function widenForDescriptionOnly(item: AnalysisItem, statedWeight: boolean): AnalysisItem {
  if (statedWeight) return item;
  const spread = 0.4;
  return {
    ...item,
    gramsLow: Math.round(Math.min(item.gramsLow, item.grams * (1 - spread))),
    gramsHigh: Math.round(Math.max(item.gramsHigh, item.grams * (1 + spread))),
    uncertaintyReasons: item.uncertaintyReasons.length
      ? item.uncertaintyReasons
      : ["Estimated from your description alone, with no photo to judge the portion."]
  };
}

export async function analyzeWithConfiguredProvider(
  env: Env,
  description: string,
  imagePath: string | undefined,
  capture?: CaptureMetadata,
  requestedReference?: ScaleReference,
  loggedDate?: string
): Promise<MealAnalysis> {
  const settings = await getSettings(env);
  const foods = await listFoods(env);
  const reference = normalizeScaleReference(requestedReference, settings.plate_diameter_cm);
  const time = getTimeContext(settings.timezone);
  const localTime = loggedDate && loggedDate !== time.today ? "unknown" : time.localTime;

  const textOnly = () => analyzeDescriptionCore(foods, description, { scaleReference: reference, localTime });

  const apiKey = await getOpenRouterApiKey(env);
  if (!apiKey) {
    const result = textOnly();
    if (imagePath) {
      result.imagePath = imagePath;
      result.imagePaths = [imagePath];
    }
    result.capture = capture;
    result.measurement = fallbackMeasurement(reference, capture);
    result.warnings.unshift(imagePath
      ? "OpenRouter is not configured. Add the API key in Settings to analyze the photo; the text matcher was used."
      : "OpenRouter is not configured, so your description was matched against the food list instead of being estimated by the model.");
    return result;
  }

  try {
    const memoryRows = await env.DB.prepare("SELECT id, subject, note FROM meal_memories ORDER BY updated_at DESC LIMIT 30").all<{ id: string; subject: string; note: string }>();
    const memories = memoryRows.results ?? [];
    const image = imagePath ? await imageContent(env, imagePath) : null;
    // No photo means a different job entirely, so it gets its own prompt rather
    // than one that opens by describing an image the model was never given.
    const prompt = image
      ? buildSinglePhotoPrompt(reference, description, memories, capture, { localTime, timezone: settings.timezone, loggedDate })
      : buildDescriptionPrompt(description, memories, { localTime, timezone: settings.timezone, loggedDate });
    const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    if (image) content.push(image);

    const startedAt = Date.now();
    const model = env.OPENROUTER_MODEL || settings.openrouter_model;
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: openRouterHeaders(apiKey, env),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        temperature: 0.1,
        max_tokens: 3500,
        reasoning: { effort: "low", exclude: true },
        response_format: { type: "json_schema", json_schema: analysisJsonSchema },
        provider: { require_parameters: true }
      }),
      signal: AbortSignal.timeout(120_000)
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { cost?: number }; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message || `OpenRouter returned ${response.status}`);
    const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}") as {
      title?: string;
      confidence?: number;
      measurement?: OpenRouterMeasurement;
      mealTypeSuggestion?: OpenRouterMealTypeSuggestion;
      items?: OpenRouterItem[];
      assumptions?: string[];
      warnings?: string[];
      highImpactQuestion?: string;
      appliedMemoryIds?: string[];
    };

    const measurement = normalizeMeasurement(parsed.measurement, reference, capture);
    const mealTypeSuggestion = normalizeMealTypeSuggestion(parsed.mealTypeSuggestion, description, localTime);
    const allowTightRange = /\b\d+(?:[.,]\d+)?\s*(?:g|gr|gram|grams|gramos)\b/i.test(description);
    const items = (parsed.items ?? [])
      .filter((item) => item.name && Number(item.grams) > 0)
      .map((item) => normalizeItem(foods, item, measurement, allowTightRange))
      .map((item) => (image ? item : widenForDescriptionOnly(item, allowTightRange)));

    const appliedIds = (parsed.appliedMemoryIds ?? []).filter((id) => memories.some((memory) => memory.id === id));
    if (appliedIds.length) {
      await env.DB.batch(appliedIds.map((id) =>
        env.DB.prepare("UPDATE meal_memories SET times_used = times_used + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id)
      ));
    }

    return {
      title: parsed.title || items.slice(0, 2).map((item) => item.name).join(" + ") || "Meal scan",
      confidence: calibrateAnalysisConfidence(Number(parsed.confidence ?? 0.6), measurement, appliedIds.length),
      provider: "openrouter",
      imagePath,
      imagePaths: imagePath ? [imagePath] : [],
      items,
      assumptions: parsed.assumptions ?? [],
      warnings: [
        image
          ? "One-photo estimate: review portions before saving."
          : "Estimated from your description alone, with no photo. Check the portions before saving.",
        ...(capture?.issues.length ? [`Photo check: ${capture.issues.join(", ")}.`] : []),
        ...(image && !measurement.plateUsedAsScale ? ["The complete plate rim was not usable as scale, so portion uncertainty is wider."] : []),
        ...(parsed.warnings ?? [])
      ],
      range: calculateEstimateRange(items),
      measurement,
      mealTypeSuggestion,
      highImpactQuestion: parsed.highImpactQuestion?.trim() || undefined,
      pipelineVersion: "single-photo-v2",
      capture,
      usage: { model, costUsd: Number(payload.usage?.cost ?? 0), latencyMs: Date.now() - startedAt },
      assistantReply: appliedIds.length
        ? "I used a relevant meal memory alongside your description. Confirm what changed today."
        : image
          ? "I used the visible plate when reliable and kept a realistic uncertainty range. Tell me what the camera cannot see."
          : "I estimated this from your words, so the range is wide. Tell me quantities or how it was cooked and I will tighten it.",
      appliedMemories: memories.filter((memory) => appliedIds.includes(memory.id)).map((memory) => `${memory.subject}: ${memory.note}`)
    };
  } catch (error) {
    const fallback = textOnly();
    fallback.imagePath = imagePath;
    fallback.imagePaths = imagePath ? [imagePath] : [];
    fallback.capture = capture;
    fallback.measurement = fallbackMeasurement(reference, capture);
    fallback.warnings.unshift(`OpenRouter analysis failed (${error instanceof Error ? error.message : "unknown error"}). Used the text matcher instead.`);
    return fallback;
  }
}

async function rememberMeal(env: Env, subject: string, note: string) {
  const existing = await env.DB.prepare("SELECT id FROM meal_memories WHERE lower(subject) = lower(?)").bind(subject).first<{ id: string }>();
  if (existing) await env.DB.prepare("UPDATE meal_memories SET note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(note, existing.id).run();
  else await env.DB.prepare("INSERT INTO meal_memories (id, subject, note) VALUES (?, ?, ?)").bind(crypto.randomUUID(), subject, note).run();
  return `${subject}: ${note}`;
}

async function refineLocally(env: Env, foods: FoodRow[], current: MealAnalysis, message: string, reason?: string): Promise<MealAnalysis> {
  const normalized = clean(message);
  let items = [...current.items];
  const mentionsNoOil = /\b(no oil|without oil|sin aceite)\b/.test(normalized);
  const requestedOil = /aceite de girasol|sunflower oil/.test(normalized)
    ? matchFood(foods, "sunflower oil")
    : /aceite de oliva|olive oil/.test(normalized)
      ? matchFood(foods, "olive oil")
      : undefined;

  if (mentionsNoOil) items = items.filter((item) => !/oil|aceite/i.test(item.name));
  if (requestedOil && !items.some((item) => item.foodId === requestedOil.id)) {
    const statedGrams = message.match(/(\d+(?:[.,]\d+)?)\s*(?:g|gr|gram|grams|gramos)\b/i);
    const tablespoon = /(?:1|one|una?)\s*(?:tbsp|tablespoon|cucharada)/i.test(message);
    items.push(calculate(requestedOil, statedGrams ? Number(statedGrams[1].replace(",", ".")) : tablespoon ? 14 : 10, 0.72));
  }

  const repeatable = /\b(remember|save this|from now on|always|usually|normally|siempre|recorda|recuerda|guarda|normalmente|usualmente|suelo)\b/.test(normalized);
  const subject = current.items.find((item) => !/oil|aceite/i.test(item.name))?.name || current.title;
  const note = message.trim().replace(/\s+/g, " ");
  const memorySaved = repeatable && subject && note ? await rememberMeal(env, subject, note) : undefined;
  const assistantReply = memorySaved
    ? `I saved that preparation detail for future meals matching ${subject}.`
    : "I kept this correction on the current estimate. Say “I always…” if you want it saved as a reusable meal memory.";

  return {
    ...current,
    items,
    range: calculateEstimateRange(items),
    warnings: [assistantReply, ...(reason ? [reason] : []), ...current.warnings],
    assistantReply,
    memorySaved
  };
}

export async function refineAnalysis(env: Env, current: MealAnalysis, message: string): Promise<MealAnalysis> {
  const settings = await getSettings(env);
  const foods = await listFoods(env);
  const apiKey = await getOpenRouterApiKey(env);
  if (!apiKey) return refineLocally(env, foods, current, message, "OpenRouter is not configured, so the local correction parser was used.");

  try {
    const existing = await env.DB.prepare("SELECT subject, note FROM meal_memories ORDER BY updated_at DESC LIMIT 30").all<{ subject: string; note: string }>();
    const content: Array<Record<string, unknown>> = [{
      type: "text",
      text: `${refinementPrompt}

CURRENT ESTIMATE: ${JSON.stringify(current)}
USER MESSAGE: ${message}
EXISTING PERSONAL MEMORIES: ${JSON.stringify(existing.results ?? [])}`
    }];
    for (const relativeImagePath of current.imagePaths?.length ? current.imagePaths : current.imagePath ? [current.imagePath] : []) {
      const image = await imageContent(env, relativeImagePath);
      if (image) content.push(image);
    }

    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: openRouterHeaders(apiKey, env),
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL || settings.openrouter_model,
        messages: [{ role: "user", content }],
        temperature: 0.1,
        max_tokens: 1800,
        response_format: { type: "json_schema", json_schema: refinementJsonSchema },
        provider: { require_parameters: true }
      }),
      signal: AbortSignal.timeout(120_000)
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message || `OpenRouter returned ${response.status}`);
    const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}") as {
      title: string; confidence: number; items: OpenRouterItem[]; assumptions: string[]; warnings: string[]; assistantReply: string;
      shouldRemember: boolean; memory: { subject: string; note: string };
    };

    const fallbackReference = normalizeScaleReference(undefined, settings.plate_diameter_cm);
    const measurement: MeasurementAssessment = current.measurement ?? fallbackMeasurement(fallbackReference, current.capture);
    const explicitQuantity = /\b\d+(?:[.,]\d+)?\s*(?:g|gr|gram|grams|gramos)\b/i.test(message);
    const items = parsed.items.filter((item) => item.name && item.grams).map((item) => normalizeItem(foods, item, measurement, explicitQuantity));
    let memorySaved: string | undefined;
    if (parsed.shouldRemember && parsed.memory?.subject?.trim() && parsed.memory?.note?.trim()) {
      memorySaved = await rememberMeal(env, parsed.memory.subject, parsed.memory.note);
    }

    return {
      title: parsed.title, confidence: parsed.confidence, provider: "openrouter",
      imagePath: current.imagePath, imagePaths: current.imagePaths, items,
      assumptions: parsed.assumptions, warnings: parsed.warnings, assistantReply: parsed.assistantReply,
      range: calculateEstimateRange(items), measurement,
      mealTypeSuggestion: current.mealTypeSuggestion ?? suggestArgentineMealType(message, getTimeContext(settings.timezone).localTime),
      highImpactQuestion: current.highImpactQuestion,
      pipelineVersion: "single-photo-v2", capture: current.capture,
      usage: current.usage,
      appliedMemories: current.appliedMemories, memorySaved
    };
  } catch (error) {
    return refineLocally(env, foods, current, message, `OpenRouter refinement failed (${error instanceof Error ? error.message : "unknown error"}), so the local correction parser was used.`);
  }
}

export async function getAiStatus(env: Env) {
  const settings = await getSettings(env);
  const keySource = await getOpenRouterKeySource(env);
  return {
    provider: "openrouter",
    available: keySource !== "none",
    model: env.OPENROUTER_MODEL || settings.openrouter_model,
    configuredFromEnvironment: keySource === "environment",
    keySource
  };
}

export async function analyzeTextOnly(env: Env, description: string) {
  const settings = await getSettings(env);
  const foods = await listFoods(env);
  return analyzeDescriptionCore(foods, description, {
    scaleReference: normalizeScaleReference(undefined, settings.plate_diameter_cm),
    localTime: getTimeContext(settings.timezone).localTime
  });
}
