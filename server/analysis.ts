/**
 * Node adapter over the shared analysis core.
 *
 * The deployed app runs on Cloudflare Workers (see worker/). This module now
 * exists so the local research tooling — scripts/test-single-photo-pipeline.ts
 * and the Nutrition5k benchmark — exercises the exact same prompt and maths as
 * production, backed by the local SQLite database instead of D1.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, getOpenRouterApiKey, getOpenRouterKeySource, getSettings, rootDir } from "./db.js";
import { getTimeContext } from "../shared/time.js";
import {
  analysisJsonSchema,
  analyzeDescription as analyzeDescriptionCore,
  buildSinglePhotoPrompt,
  calculate,
  calculateEstimateRange,
  calibrateAnalysisConfidence,
  clean,
  fallbackMeasurement,
  matchFood as matchFoodCore,
  normalizeItem as normalizeItemCore,
  normalizeMealTypeSuggestion,
  normalizeMeasurement,
  normalizeScaleReference,
  refinementJsonSchema,
  refinementPrompt,
  suggestArgentineMealType,
  type CaptureMetadata,
  type FoodRow,
  type MealAnalysis,
  type MeasurementAssessment,
  type OpenRouterItem,
  type OpenRouterMealTypeSuggestion,
  type OpenRouterMeasurement,
  type ScaleReference
} from "../shared/analysis-core.js";

export { buildSinglePhotoPrompt, calculateEstimateRange, calibrateAnalysisConfidence, suggestArgentineMealType };
export type {
  AnalysisItem, CaptureMetadata, EstimateRange, FoodRow, MealAnalysis, MealType,
  MealTypeSuggestion, MeasurementAssessment, ScaleReference
} from "../shared/analysis-core.js";

const foodRows = () => db.prepare("SELECT * FROM foods ORDER BY name").all() as unknown as FoodRow[];

export const matchFood = (name: string) => matchFoodCore(foodRows(), name);

const normalizeItem = (item: OpenRouterItem, measurement: MeasurementAssessment, allowTightRange: boolean) =>
  normalizeItemCore(foodRows(), item, measurement, allowTightRange);

function resolveStoredImagePath(relativeImagePath: string) {
  const normalized = relativeImagePath.replace(/^\/+/, "");
  if (normalized.startsWith("uploads/") || normalized.startsWith("benchmark/")) return path.join(rootDir, "data", normalized);
  return path.join(rootDir, normalized);
}

export function analyzeDescription(description: string, options?: { scaleReference?: ScaleReference; localTime?: string }): MealAnalysis {
  const settings = getSettings();
  const scaleReference = normalizeScaleReference(options?.scaleReference, settings.plate_diameter_cm);
  const localTime = options?.localTime || getTimeContext(settings.timezone).localTime;
  return analyzeDescriptionCore(foodRows(), description, { scaleReference, localTime });
}

export async function analyzeWithConfiguredProvider(description: string, relativeImagePaths: string[] = [], capture?: CaptureMetadata, requestedReference?: ScaleReference, loggedDate?: string): Promise<MealAnalysis> {
  const settings = getSettings();
  const reference = normalizeScaleReference(requestedReference, settings.plate_diameter_cm);
  const time = getTimeContext(settings.timezone);
  const localTime = loggedDate && loggedDate !== time.today ? "unknown" : time.localTime;
  const imagePath = relativeImagePaths[0];
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    const result = analyzeDescription(description, { scaleReference: reference, localTime });
    if (imagePath) {
      result.imagePath = imagePath;
      result.imagePaths = [imagePath];
    }
    result.capture = capture;
    result.measurement = fallbackMeasurement(reference, capture);
    result.warnings.unshift("OpenRouter is not configured. Add the API key in Settings to analyze the photo; the text matcher was used.");
    return result;
  }

  try {
    const content: Array<Record<string, unknown>> = [];
    const memories = db.prepare("SELECT id, subject, note FROM meal_memories ORDER BY updated_at DESC LIMIT 30").all() as Array<{ id: string; subject: string; note: string }>;
    content.push({ type: "text", text: buildSinglePhotoPrompt(reference, description, memories, capture, { localTime, timezone: settings.timezone, loggedDate }) });
    if (imagePath) {
      const absoluteImagePath = resolveStoredImagePath(imagePath);
      const image = fs.readFileSync(absoluteImagePath).toString("base64");
      const mime = path.extname(absoluteImagePath).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
      content.push({ type: "image_url", image_url: { url: `data:${mime};base64,${image}` } });
    }
    const startedAt = Date.now();
    const model = process.env.OPENROUTER_MODEL || settings.openrouter_model;
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.APP_URL || "http://localhost:8787",
        "X-OpenRouter-Title": "Jamtytrack Local"
      },
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
      .map((item) => normalizeItem(item, measurement, allowTightRange));

    const appliedIds = (parsed.appliedMemoryIds ?? []).filter((id) => memories.some((memory) => memory.id === id));
    for (const id of appliedIds) db.prepare("UPDATE meal_memories SET times_used = times_used + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(id);
    return {
      title: parsed.title || items.slice(0, 2).map((item) => item.name).join(" + ") || "Meal scan",
      confidence: calibrateAnalysisConfidence(Number(parsed.confidence ?? 0.6), measurement, appliedIds.length),
      provider: "openrouter",
      imagePath,
      imagePaths: imagePath ? [imagePath] : [],
      items,
      assumptions: parsed.assumptions ?? [],
      warnings: [
        "One-photo estimate: review portions before saving.",
        ...(capture?.issues.length ? [`Photo check: ${capture.issues.join(", ")}.`] : []),
        ...(measurement.plateUsedAsScale ? [] : ["The complete plate rim was not usable as scale, so portion uncertainty is wider."]),
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
        ? "I used a relevant meal memory and the one-photo plate estimate. Confirm what changed today."
        : "I used the visible plate when reliable and kept a realistic uncertainty range. Tell me what the camera cannot see.",
      appliedMemories: memories.filter((memory) => appliedIds.includes(memory.id)).map((memory) => `${memory.subject}: ${memory.note}`)
    };
  } catch (error) {
    const fallback = analyzeDescription(description, { scaleReference: reference, localTime });
    fallback.imagePath = imagePath;
    fallback.imagePaths = imagePath ? [imagePath] : [];
    fallback.capture = capture;
    fallback.measurement = fallbackMeasurement(reference, capture);
    fallback.warnings.unshift(`OpenRouter analysis failed (${error instanceof Error ? error.message : "unknown error"}). Used the text matcher instead.`);
    return fallback;
  }
}

function rememberMeal(subject: string, note: string) {
  const existing = db.prepare("SELECT id FROM meal_memories WHERE lower(subject) = lower(?)").get(subject) as { id: string } | undefined;
  if (existing) db.prepare("UPDATE meal_memories SET note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(note, existing.id);
  else db.prepare("INSERT INTO meal_memories (id, subject, note) VALUES (?, ?, ?)").run(randomUUID(), subject, note);
  return `${subject}: ${note}`;
}

function refineLocally(current: MealAnalysis, message: string, reason?: string): MealAnalysis {
  const normalized = clean(message);
  let items = [...current.items];
  const mentionsNoOil = /\b(no oil|without oil|sin aceite)\b/.test(normalized);
  const requestedOil = /aceite de girasol|sunflower oil/.test(normalized)
    ? matchFood("sunflower oil")
    : /aceite de oliva|olive oil/.test(normalized)
      ? matchFood("olive oil")
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
  const memorySaved = repeatable && subject && note ? rememberMeal(subject, note) : undefined;
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

export async function refineAnalysis(current: MealAnalysis, message: string): Promise<MealAnalysis> {
  const settings = getSettings();
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) return refineLocally(current, message, "OpenRouter is not configured, so the local correction parser was used.");
  try {
    const existingMemories = db.prepare("SELECT subject, note FROM meal_memories ORDER BY updated_at DESC LIMIT 30").all();
    const content: Array<Record<string, unknown>> = [{
      type: "text",
      text: `${refinementPrompt}

CURRENT ESTIMATE: ${JSON.stringify(current)}
USER MESSAGE: ${message}
EXISTING PERSONAL MEMORIES: ${JSON.stringify(existingMemories)}`
    }];
    for (const relativeImagePath of current.imagePaths?.length ? current.imagePaths : current.imagePath ? [current.imagePath] : []) {
      const absoluteImagePath = resolveStoredImagePath(relativeImagePath);
      if (fs.existsSync(absoluteImagePath)) {
        const image = fs.readFileSync(absoluteImagePath).toString("base64");
        const mime = path.extname(absoluteImagePath).toLowerCase() === ".png" ? "image/png" : "image/jpeg";
        content.push({ type: "image_url", image_url: { url: `data:${mime};base64,${image}` } });
      }
    }
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.APP_URL || "http://localhost:5173",
        "X-OpenRouter-Title": "Jamtytrack Local"
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || settings.openrouter_model,
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
    const measurement = current.measurement ?? fallbackMeasurement(fallbackReference, current.capture);
    const explicitQuantity = /\b\d+(?:[.,]\d+)?\s*(?:g|gr|gram|grams|gramos)\b/i.test(message);
    const items = parsed.items.filter((item) => item.name && item.grams).map((item) => normalizeItem(item, measurement, explicitQuantity));
    let memorySaved: string | undefined;
    if (parsed.shouldRemember && parsed.memory.subject.trim() && parsed.memory.note.trim()) {
      memorySaved = rememberMeal(parsed.memory.subject, parsed.memory.note);
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
    return refineLocally(current, message, `OpenRouter refinement failed (${error instanceof Error ? error.message : "unknown error"}), so the local correction parser was used.`);
  }
}

export async function getAiStatus() {
  const settings = getSettings();
  const keySource = getOpenRouterKeySource();
  return {
    provider: "openrouter",
    available: keySource !== "none",
    model: process.env.OPENROUTER_MODEL || settings.openrouter_model,
    configuredFromEnvironment: keySource === "environment",
    keySource
  };
}
