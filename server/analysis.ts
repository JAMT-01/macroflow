import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, getOpenRouterApiKey, getOpenRouterKeySource, getSettings, rootDir } from "./db.js";
import { getTimeContext } from "./time.js";

export type MealType = "Breakfast" | "Lunch" | "Merienda" | "Dinner" | "Treat";

export type ScaleReference = {
  mode: "default-plate" | "custom-plate" | "none";
  diameterCm: number | null;
};

export type MealTypeSuggestion = {
  type: MealType;
  confidence: number;
  explanation: string;
};

export type FoodRow = {
  id: number;
  name: string;
  brand: string;
  category: string;
  emoji: string;
  serving_label: string;
  serving_grams: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  aliases: string;
};

export type AnalysisItem = {
  foodId: number | null;
  name: string;
  emoji: string;
  grams: number;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  confidence: number;
  visualEvidence: string;
  portionBasis: string;
  gramsLow: number;
  gramsHigh: number;
  uncertaintyReasons: string[];
};

export type CaptureMetadata = {
  width: number;
  height: number;
  brightness: number;
  contrast: number;
  sharpness: number;
  qualityScore: number;
  issues: string[];
};

export type MeasurementAssessment = {
  referenceMode: ScaleReference["mode"];
  plateDiameterCm: number | null;
  plateProfile: "round-flat" | null;
  plateVisible: boolean;
  wholePlateVisible: boolean;
  plateUsedAsScale: boolean;
  viewAngleDeg: number | null;
  scaleConfidence: "high" | "medium" | "low" | "none";
  captureQuality: "good" | "usable" | "poor";
  explanation: string;
};

export type EstimateRange = {
  calories: { low: number; high: number };
  protein: { low: number; high: number };
  carbs: { low: number; high: number };
  fat: { low: number; high: number };
};

export type MealAnalysis = {
  title: string;
  confidence: number;
  provider: "rules" | "openrouter";
  imagePath?: string;
  imagePaths?: string[];
  items: AnalysisItem[];
  assumptions: string[];
  warnings: string[];
  range: EstimateRange;
  measurement: MeasurementAssessment;
  mealTypeSuggestion: MealTypeSuggestion;
  highImpactQuestion?: string;
  pipelineVersion: "single-photo-v2";
  capture?: CaptureMetadata;
  usage?: { model: string; costUsd: number; latencyMs: number };
  assistantReply?: string;
  appliedMemories?: string[];
  memorySaved?: string;
};

const foodRows = () => db.prepare("SELECT * FROM foods ORDER BY name").all() as unknown as FoodRow[];

function resolveStoredImagePath(relativeImagePath: string) {
  const normalized = relativeImagePath.replace(/^\/+/, "");
  if (normalized.startsWith("uploads/") || normalized.startsWith("benchmark/")) return path.join(rootDir, "data", normalized);
  return path.join(rootDir, normalized);
}

function clean(value: string) {
  return value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeScaleReference(reference: ScaleReference | undefined, defaultDiameterCm: number): ScaleReference {
  if (reference?.mode === "none") return { mode: "none", diameterCm: null };
  const mode = reference?.mode === "custom-plate" ? "custom-plate" : "default-plate";
  const requested = Number(reference?.diameterCm ?? defaultDiameterCm);
  return { mode, diameterCm: Number.isFinite(requested) ? Math.max(15, Math.min(40, requested)) : defaultDiameterCm };
}

export function suggestArgentineMealType(description: string, localTime: string): MealTypeSuggestion {
  const hourMatch = localTime.match(/^(\d{2}):(\d{2})$/);
  const minutes = hourMatch ? Number(hourMatch[1]) * 60 + Number(hourMatch[2]) : 12 * 60;
  const text = clean(description);
  const looksLikeTreat = /\b(helado|golosina|caramelo|chocolate|alfajor|torta|cake|postre|dessert|brownie|cookie|donut|factura|medialuna|papitas|chips)\b/.test(text);
  const looksLikeLightMeal = /\b(mate|cafe|coffee|te|tea|leche|milk|yogur|yogurt|tostada|toast|cereal|avena|oat|galletita|cracker|fruta|fruit|medialuna|factura)\b/.test(text);
  const looksLikeMainMeal = /\b(milanesa|carne|beef|pollo|chicken|pescado|fish|arroz|rice|pasta|fideos|pure|papas|potato|ensalada|salad|empanada|pizza|guiso|stew|hamburguesa|burger)\b/.test(text);
  const timeType: MealType = minutes >= 5 * 60 && minutes < 11 * 60 ? "Breakfast"
    : minutes >= 11 * 60 && minutes < 15 * 60 + 30 ? "Lunch"
      : minutes >= 15 * 60 + 30 && minutes < 19 * 60 + 30 ? "Merienda"
        : minutes >= 19 * 60 + 30 || minutes < 2 * 60 ? "Dinner" : "Treat";

  if (looksLikeTreat && !looksLikeMainMeal && !/\b(mate|cafe|coffee|te|tea|leche|milk|yogur|yogurt)\b/.test(text)) {
    return { type: "Treat", confidence: 0.72, explanation: "It looks like a standalone sweet or discretionary snack; time is only a supporting clue." };
  }
  if (looksLikeMainMeal) {
    const type: MealType = minutes >= 18 * 60 || minutes < 3 * 60 ? "Dinner" : "Lunch";
    return { type, confidence: 0.7, explanation: `The savory plated-food context fits an Argentine ${type === "Dinner" ? "cena" : "almuerzo"}; local time supports the choice.` };
  }
  if (looksLikeLightMeal) {
    const type: MealType = minutes < 12 * 60 ? "Breakfast" : "Merienda";
    return { type, confidence: 0.68, explanation: `The light food or infusion context fits an Argentine ${type === "Breakfast" ? "desayuno" : "merienda"}.` };
  }
  return { type: timeType, confidence: 0.52, explanation: "No strong food-pattern clue was available, so Argentine local meal timing is the main prior." };
}

function defaultGramRange(grams: number, confidence: number) {
  const spread = confidence >= 0.8 ? 0.18 : confidence >= 0.65 ? 0.28 : 0.4;
  return { low: Math.max(0, grams * (1 - spread)), high: grams * (1 + spread) };
}

function calculate(food: FoodRow, grams: number, confidence = 0.86, evidence?: { visualEvidence?: string; portionBasis?: string; gramsLow?: number; gramsHigh?: number; uncertaintyReasons?: string[] }): AnalysisItem {
  const factor = grams / 100;
  const fallbackRange = defaultGramRange(grams, confidence);
  return {
    foodId: food.id,
    name: food.name,
    emoji: food.emoji,
    grams: Math.round(grams),
    calories: Math.round(food.calories * factor),
    protein: Math.round(food.protein * factor * 10) / 10,
    carbs: Math.round(food.carbs * factor * 10) / 10,
    fat: Math.round(food.fat * factor * 10) / 10,
    confidence,
    visualEvidence: evidence?.visualEvidence || "Matched from the meal description.",
    portionBasis: evidence?.portionBasis || `Default ${food.serving_label} serving, editable before saving.`,
    gramsLow: Math.round(Math.max(0, Math.min(grams, evidence?.gramsLow ?? fallbackRange.low))),
    gramsHigh: Math.round(Math.max(grams, evidence?.gramsHigh ?? fallbackRange.high)),
    uncertaintyReasons: evidence?.uncertaintyReasons ?? ["The portion was not weighed."]
  };
}

function roundRange(low: number, high: number, precision = 0) {
  const factor = 10 ** precision;
  return { low: Math.round(low * factor) / factor, high: Math.round(high * factor) / factor };
}

export function calculateEstimateRange(items: AnalysisItem[]): EstimateRange {
  const totals = {
    calories: { low: 0, high: 0 }, protein: { low: 0, high: 0 }, carbs: { low: 0, high: 0 }, fat: { low: 0, high: 0 }
  };
  for (const item of items) {
    const pointGrams = Math.max(1, item.grams);
    const lowFactor = item.gramsLow / pointGrams;
    const highFactor = item.gramsHigh / pointGrams;
    for (const nutrient of ["calories", "protein", "carbs", "fat"] as const) {
      totals[nutrient].low += item[nutrient] * lowFactor;
      totals[nutrient].high += item[nutrient] * highFactor;
    }
  }
  return {
    calories: roundRange(totals.calories.low, totals.calories.high),
    protein: roundRange(totals.protein.low, totals.protein.high, 1),
    carbs: roundRange(totals.carbs.low, totals.carbs.high, 1),
    fat: roundRange(totals.fat.low, totals.fat.high, 1)
  };
}

function fallbackMeasurement(reference: ScaleReference, capture?: CaptureMetadata): MeasurementAssessment {
  return {
    referenceMode: reference.mode,
    plateDiameterCm: reference.diameterCm,
    plateProfile: reference.mode === "none" ? null : "round-flat",
    plateVisible: false,
    wholePlateVisible: false,
    plateUsedAsScale: false,
    viewAngleDeg: null,
    scaleConfidence: "none",
    captureQuality: capture && capture.qualityScore < 45 ? "poor" : capture && capture.qualityScore < 70 ? "usable" : "good",
    explanation: reference.mode === "none"
      ? "No known-size reference was selected, so familiar serving sizes and a wider uncertainty range were used."
      : "No reliable complete plate rim was available, so familiar serving sizes were used."
  };
}

export function matchFood(name: string): FoodRow | undefined {
  const target = clean(name);
  let best: { food: FoodRow; score: number } | undefined;
  for (const food of foodRows()) {
    const aliases = [food.name, ...(JSON.parse(food.aliases) as string[])].map(clean);
    for (const alias of aliases) {
      let score = 0;
      if (target === alias) score = 1000 + alias.length;
      else if (target.includes(alias)) score = 500 + alias.length;
      else if (alias.includes(target) && target.length >= 4) score = 100 + target.length;
      if (score > (best?.score ?? 0)) best = { food, score };
    }
  }
  return best?.food;
}

function gramsFromText(segment: string, food: FoodRow): number {
  const metric = segment.match(/(\d+(?:[.,]\d+)?)\s*(?:g|gr|gram|grams|gramos)\b/i);
  if (metric) return Number(metric[1].replace(",", "."));
  const count = segment.match(/\b(\d+(?:[.,]\d+)?)\s*(?:x\s*)?(?:large\s+|medium\s+|small\s+)?[a-záéíóúñ]/i);
  if (count && /(egg|huevo|empanada|banana|apple|manzana|tortilla|slice|rebanada)/i.test(segment)) {
    return Number(count[1].replace(",", ".")) * food.serving_grams;
  }
  if (/\bhalf|\bmedio|\bmedia|1\/2/i.test(segment)) return food.serving_grams * 0.5;
  if (/\bdouble|\bdoble/i.test(segment)) return food.serving_grams * 2;
  return food.serving_grams;
}

export function analyzeDescription(description: string, options?: { scaleReference?: ScaleReference; localTime?: string }): MealAnalysis {
  const normalized = description.trim();
  const segments = normalized
    .split(/,|\+|\n|\s+(?:and|with|y|con)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const items: AnalysisItem[] = [];
  const missed: string[] = [];

  for (const segment of segments) {
    const food = matchFood(segment);
    if (food) items.push(calculate(food, gramsFromText(segment, food)));
    else missed.push(segment);
  }

  if (items.length === 0 && normalized) {
    const food = matchFood(normalized);
    if (food) items.push(calculate(food, gramsFromText(normalized, food)));
  }

  const warnings = [
    "Portions are estimates. Adjust grams before saving.",
    ...(missed.length ? [`Could not match: ${missed.join(", ")}. Add these manually after saving.`] : [])
  ];

  const settings = getSettings();
  const reference = normalizeScaleReference(options?.scaleReference, settings.plate_diameter_cm);
  const localTime = options?.localTime || getTimeContext(settings.timezone).localTime;
  const measurement = fallbackMeasurement(reference);
  return {
    title: items.length ? items.slice(0, 2).map((item) => item.name.split(",")[0]).join(" + ") : "Meal scan",
    confidence: items.length ? Math.max(0.55, 0.9 - missed.length * 0.12) : 0.25,
    provider: "rules",
    items,
    assumptions: ["Default serving sizes were used where you did not provide grams."],
    warnings,
    range: calculateEstimateRange(items),
    measurement,
    mealTypeSuggestion: suggestArgentineMealType(description, localTime),
    highImpactQuestion: items.length ? "Do you know the approximate grams or serving size?" : undefined,
    pipelineVersion: "single-photo-v2"
  };
}

type OpenRouterItem = {
  name?: string;
  grams?: number;
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  confidence?: number;
  visualEvidence?: string;
  portionBasis?: string;
  gramsLow?: number;
  gramsHigh?: number;
  uncertaintyReasons?: string[];
};

type OpenRouterMeasurement = {
  plateVisible?: boolean;
  wholePlateVisible?: boolean;
  plateUsedAsScale?: boolean;
  viewAngleDeg?: number | null;
  scaleConfidence?: "high" | "medium" | "low" | "none";
  captureQuality?: "good" | "usable" | "poor";
  explanation?: string;
};

type OpenRouterMealTypeSuggestion = {
  type?: MealType;
  confidence?: number;
  explanation?: string;
};

export function buildSinglePhotoPrompt(reference: ScaleReference, description: string, memories: Array<{ id: string; subject: string; note: string }>, capture?: CaptureMetadata, mealContext?: { localTime: string; timezone: string; loggedDate?: string }) {
  const scaleInstruction = reference.mode === "none"
    ? "NO known-size plate or reference object is being provided for this photo. Do not convert pixels to centimeters and do not claim that any visible plate has a known diameter. Use familiar serving priors with wider uncertainty."
    : `The selected reference is a flat circular plate with an OUTER EDGE-TO-EDGE DIAMETER of exactly ${reference.diameterCm} cm. This is a diameter, not an area, radius, circumference, or a ${reference.diameterCm} cm by ${reference.diameterCm} cm square. Apply it as scale only when the complete outer rim is visible and plausibly matches the selected ${reference.mode === "default-plate" ? "saved" : "different"} plate.`;
  return `You are estimating one meal from exactly ONE ordinary RGB photograph for a personal nutrition diary. Output only the requested structured data. Do not claim to have LiDAR, depth, a scale, or measurements that are not actually available.

Use this evidence order:
1. Explicit user facts, including stated grams or recipe quantities.
2. A genuinely matching personal meal memory.
3. Visible geometry relative to a known-size reference, but only when one was selected and is fully reliable.
4. Typical serving priors only when the first three are insufficient.

Method:
- First inventory every visibly distinct edible component. Do not merge a coating, sauce, or materially caloric oil into the main food when it can be estimated separately.
- ${scaleInstruction} A circle becomes an ellipse under perspective: use that only to make a conservative perspective-aware footprint estimate. Do not pretend one image uniquely reveals food height.
- Estimate edible grams for every item. Give a realistic low/high gram range; include uncertainty from height, density, overlap, hidden filling, sauce, and absorbed oil. A narrow range is justified only by explicit user quantities.
- Nutrients are TOTALS for the estimated portion, never per 100 g. Cross-check calories against roughly 4 kcal/g protein, 4 kcal/g carbohydrate, and 9 kcal/g fat.
- If one missing fact could move calories by about 10% or more, ask exactly one short high-impact question. Oil amount, recipe yield, and serving count usually matter more than the oil variety.
- Assess the photograph honestly. Scale confidence cannot be high if any plate edge is cropped, obscured, or the image is blurry. Define viewAngleDeg as degrees above the plate plane: 90 is directly overhead and 45 is an angled view.
- Suggest one diary category using Argentine context. The national GAPA pattern has four standard meals: Breakfast/desayuno, Lunch/almuerzo, Merienda, and Dinner/cena. Use Treat only for a standalone discretionary sweet/snack or antojo, not automatically for a normal merienda. Food composition and the user's note are stronger evidence than the clock; local time is a useful prior. Do not add foods merely to make the photo fit a category.
- Return concise observable evidence and assumptions, not hidden reasoning.

ARGENTINE DIARY CONTEXT: ${mealContext ? JSON.stringify(mealContext) : "local time unavailable"}
CLIENT PHOTO CHECK: ${capture ? JSON.stringify(capture) : "not available"}
PERSONAL MEMORIES (apply only matching ones and return their IDs): ${JSON.stringify(memories)}
USER NOTE: ${description.trim() || "none"}`;
}

function normalizeMeasurement(parsed: OpenRouterMeasurement | undefined, reference: ScaleReference, capture?: CaptureMetadata): MeasurementAssessment {
  const captureQuality = capture
    ? capture.qualityScore < 45 ? "poor" : capture.qualityScore < 70 ? "usable" : "good"
    : parsed?.captureQuality ?? "usable";
  const plateVisible = Boolean(parsed?.plateVisible);
  const wholePlateVisible = plateVisible && Boolean(parsed?.wholePlateVisible);
  const plateUsedAsScale = reference.mode !== "none" && wholePlateVisible && Boolean(parsed?.plateUsedAsScale);
  let scaleConfidence = parsed?.scaleConfidence ?? "none";
  if (reference.mode === "none") scaleConfidence = "none";
  else if (!plateUsedAsScale) scaleConfidence = plateVisible ? "low" : "none";
  if (captureQuality === "poor" && (scaleConfidence === "high" || scaleConfidence === "medium")) scaleConfidence = "low";
  return {
    referenceMode: reference.mode,
    plateDiameterCm: reference.diameterCm,
    plateProfile: reference.mode === "none" ? null : "round-flat",
    plateVisible,
    wholePlateVisible,
    plateUsedAsScale,
    viewAngleDeg: Number.isFinite(parsed?.viewAngleDeg) ? Math.max(0, Math.min(90, Number(parsed?.viewAngleDeg))) : null,
    scaleConfidence,
    captureQuality,
    explanation: reference.mode === "none"
      ? "No known-size plate was selected, so the image was not converted to real-world scale."
      : parsed?.explanation?.trim() || (plateUsedAsScale ? "The complete plate rim was used as a scale reference." : "The complete plate rim was not reliable enough to use as a scale reference.")
  };
}

function normalizeMealTypeSuggestion(parsed: OpenRouterMealTypeSuggestion | undefined, description: string, localTime: string): MealTypeSuggestion {
  const fallback = suggestArgentineMealType(description, localTime);
  const allowed: MealType[] = ["Breakfast", "Lunch", "Merienda", "Dinner", "Treat"];
  if (!parsed?.type || !allowed.includes(parsed.type)) return fallback;
  return {
    type: parsed.type,
    confidence: Math.round(Math.max(0.25, Math.min(0.95, Number(parsed.confidence ?? fallback.confidence))) * 100) / 100,
    explanation: parsed.explanation?.trim() || fallback.explanation
  };
}

export function calibrateAnalysisConfidence(reported: number, measurement: MeasurementAssessment, appliedMemoryCount = 0) {
  const cap = measurement.scaleConfidence === "high" ? 0.84
    : measurement.scaleConfidence === "medium" ? 0.74
      : measurement.scaleConfidence === "low" ? 0.64 : 0.56;
  const memoryBonus = appliedMemoryCount ? 0.03 : 0;
  const capturePenalty = measurement.captureQuality === "poor" ? 0.12 : 0;
  return Math.round(Math.max(0.2, Math.min(reported, cap + memoryBonus - capturePenalty)) * 100) / 100;
}

function normalizeItem(item: OpenRouterItem, measurement: MeasurementAssessment, allowTightRange: boolean): AnalysisItem {
  const grams = Math.max(1, Number(item.grams ?? 0));
  const confidence = Math.max(0.2, Math.min(0.92, Number(item.confidence ?? 0.55)));
  const minimumSpread = allowTightRange ? 0.05 : measurement.scaleConfidence === "high" ? 0.15 : measurement.scaleConfidence === "medium" ? 0.22 : 0.3;
  const gramsLow = Math.max(0, Math.min(grams, Number(item.gramsLow ?? grams * (1 - minimumSpread)), grams * (1 - minimumSpread)));
  const gramsHigh = Math.max(grams, Number(item.gramsHigh ?? grams * (1 + minimumSpread)), grams * (1 + minimumSpread));
  const matched = matchFood(item.name ?? "");
  const evidence = {
    visualEvidence: item.visualEvidence,
    portionBasis: item.portionBasis,
    gramsLow,
    gramsHigh,
    uncertaintyReasons: item.uncertaintyReasons?.length ? item.uncertaintyReasons : ["Food height and density are not directly measured in one photo."]
  };
  if (matched) return calculate(matched, grams, confidence, evidence);

  const protein = Math.max(0, Number(item.protein ?? 0));
  const carbs = Math.max(0, Number(item.carbs ?? 0));
  const fat = Math.max(0, Number(item.fat ?? 0));
  const reportedCalories = Math.max(0, Number(item.calories ?? 0));
  const macroCalories = protein * 4 + carbs * 4 + fat * 9;
  const calories = macroCalories > 0 && (reportedCalories < macroCalories * 0.65 || reportedCalories > macroCalories * 1.35) ? macroCalories : reportedCalories;
  return {
    foodId: null,
    name: item.name ?? "Unknown food",
    emoji: "🍽️",
    grams: Math.round(grams),
    calories: Math.round(calories),
    protein: Math.round(protein * 10) / 10,
    carbs: Math.round(carbs * 10) / 10,
    fat: Math.round(fat * 10) / 10,
    confidence,
    visualEvidence: item.visualEvidence || "Identified from the visible meal.",
    portionBasis: item.portionBasis || "Estimated from its footprint relative to the plate and a typical height/density prior.",
    gramsLow: Math.round(gramsLow),
    gramsHigh: Math.round(gramsHigh),
    uncertaintyReasons: evidence.uncertaintyReasons
  };
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
        "X-OpenRouter-Title": "Macroflow Local"
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        temperature: 0.1,
        max_tokens: 3500,
        reasoning: { effort: "low", exclude: true },
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "single_photo_meal_analysis",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["title", "confidence", "measurement", "mealTypeSuggestion", "items", "assumptions", "warnings", "highImpactQuestion", "appliedMemoryIds"],
              properties: {
                title: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                measurement: {
                  type: "object",
                  additionalProperties: false,
                  required: ["plateVisible", "wholePlateVisible", "plateUsedAsScale", "viewAngleDeg", "scaleConfidence", "captureQuality", "explanation"],
                  properties: {
                    plateVisible: { type: "boolean" },
                    wholePlateVisible: { type: "boolean" },
                    plateUsedAsScale: { type: "boolean" },
                    viewAngleDeg: { anyOf: [{ type: "number", minimum: 0, maximum: 90 }, { type: "null" }] },
                    scaleConfidence: { type: "string", enum: ["high", "medium", "low", "none"] },
                    captureQuality: { type: "string", enum: ["good", "usable", "poor"] },
                    explanation: { type: "string" }
                  }
                },
                mealTypeSuggestion: {
                  type: "object",
                  additionalProperties: false,
                  required: ["type", "confidence", "explanation"],
                  properties: {
                    type: { type: "string", enum: ["Breakfast", "Lunch", "Merienda", "Dinner", "Treat"] },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    explanation: { type: "string" }
                  }
                },
                items: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["name", "grams", "gramsLow", "gramsHigh", "calories", "protein", "carbs", "fat", "confidence", "visualEvidence", "portionBasis", "uncertaintyReasons"],
                    properties: {
                      name: { type: "string" },
                      grams: { type: "number", minimum: 0 },
                      gramsLow: { type: "number", minimum: 0 },
                      gramsHigh: { type: "number", minimum: 0 },
                      calories: { type: "number", minimum: 0 },
                      protein: { type: "number", minimum: 0 },
                      carbs: { type: "number", minimum: 0 },
                      fat: { type: "number", minimum: 0 },
                      confidence: { type: "number", minimum: 0, maximum: 1 },
                      visualEvidence: { type: "string" },
                      portionBasis: { type: "string" },
                      uncertaintyReasons: { type: "array", items: { type: "string" } }
                    }
                  }
                },
                assumptions: { type: "array", items: { type: "string" } },
                warnings: { type: "array", items: { type: "string" } },
                highImpactQuestion: { type: "string" },
                appliedMemoryIds: { type: "array", items: { type: "string" } }
              }
            }
          }
        },
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
    text: `You are refining a meal estimate in a chat with its owner. Update the estimate using the correction. Save a reusable memory only when the user explicitly says to remember it or clearly describes what they always/usually do. A preparation detail stated only for today's meal and portion corrections for this plate must not be remembered. Keep visual evidence distinct from facts supplied by the user.

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
      "X-OpenRouter-Title": "Macroflow Local"
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL || settings.openrouter_model,
      messages: [{ role: "user", content }],
      temperature: 0.1,
      max_tokens: 1800,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "meal_refinement",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["title", "confidence", "items", "assumptions", "warnings", "assistantReply", "shouldRemember", "memory"],
            properties: {
              title: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 },
              items: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "grams", "calories", "protein", "carbs", "fat", "confidence", "visualEvidence", "portionBasis"], properties: {
                name: { type: "string" }, grams: { type: "number", minimum: 0 }, calories: { type: "number", minimum: 0 }, protein: { type: "number", minimum: 0 }, carbs: { type: "number", minimum: 0 }, fat: { type: "number", minimum: 0 }, confidence: { type: "number", minimum: 0, maximum: 1 }, visualEvidence: { type: "string" }, portionBasis: { type: "string" }
              } } },
              assumptions: { type: "array", items: { type: "string" } },
              warnings: { type: "array", items: { type: "string" } },
              assistantReply: { type: "string" }, shouldRemember: { type: "boolean" },
              memory: { type: "object", additionalProperties: false, required: ["subject", "note"], properties: { subject: { type: "string" }, note: { type: "string" } } }
            }
          }
        }
      },
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
    range: calculateEstimateRange(items), measurement, mealTypeSuggestion: current.mealTypeSuggestion ?? suggestArgentineMealType(message, getTimeContext(settings.timezone).localTime), highImpactQuestion: current.highImpactQuestion,
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
  const configured = keySource !== "none";
  return {
    provider: "openrouter",
    available: configured,
    model: process.env.OPENROUTER_MODEL || settings.openrouter_model,
    configuredFromEnvironment: keySource === "environment",
    keySource
  };
}
