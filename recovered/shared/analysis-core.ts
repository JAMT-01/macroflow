function clean(value) {
  return value.toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function normalizeScaleReference(reference, defaultDiameterCm) {
  if (reference?.mode === "none") return { mode: "none", diameterCm: null };
  const mode = reference?.mode === "custom-plate" ? "custom-plate" : "default-plate";
  const requested = Number(reference?.diameterCm ?? defaultDiameterCm);
  return { mode, diameterCm: Number.isFinite(requested) ? Math.max(15, Math.min(40, requested)) : defaultDiameterCm };
}
function suggestArgentineMealType(description, localTime) {
  const hourMatch = localTime.match(/^(\d{2}):(\d{2})$/);
  const minutes = hourMatch ? Number(hourMatch[1]) * 60 + Number(hourMatch[2]) : 12 * 60;
  const text = clean(description);
  const looksLikeTreat = /\b(helado|golosina|caramelo|chocolate|alfajor|torta|cake|postre|dessert|brownie|cookie|donut|factura|medialuna|papitas|chips)\b/.test(text);
  const looksLikeLightMeal = /\b(mate|cafe|coffee|te|tea|leche|milk|yogur|yogurt|tostada|toast|cereal|avena|oat|galletita|cracker|fruta|fruit|medialuna|factura)\b/.test(text);
  const looksLikeMainMeal = /\b(milanesa|carne|beef|pollo|chicken|pescado|fish|arroz|rice|pasta|fideos|pure|papas|potato|ensalada|salad|empanada|pizza|guiso|stew|hamburguesa|burger)\b/.test(text);
  const timeType = minutes >= 5 * 60 && minutes < 11 * 60 ? "Breakfast" : minutes >= 11 * 60 && minutes < 15 * 60 + 30 ? "Lunch" : minutes >= 15 * 60 + 30 && minutes < 19 * 60 + 30 ? "Merienda" : minutes >= 19 * 60 + 30 || minutes < 2 * 60 ? "Dinner" : "Treat";
  if (looksLikeTreat && !looksLikeMainMeal && !/\b(mate|cafe|coffee|te|tea|leche|milk|yogur|yogurt)\b/.test(text)) {
    return { type: "Treat", confidence: 0.72, explanation: "It looks like a standalone sweet or discretionary snack; time is only a supporting clue." };
  }
  if (looksLikeMainMeal) {
    const type = minutes >= 18 * 60 || minutes < 3 * 60 ? "Dinner" : "Lunch";
    return { type, confidence: 0.7, explanation: `The savory plated-food context fits an Argentine ${type === "Dinner" ? "cena" : "almuerzo"}; local time supports the choice.` };
  }
  if (looksLikeLightMeal) {
    const type = minutes < 12 * 60 ? "Breakfast" : "Merienda";
    return { type, confidence: 0.68, explanation: `The light food or infusion context fits an Argentine ${type === "Breakfast" ? "desayuno" : "merienda"}.` };
  }
  return { type: timeType, confidence: 0.52, explanation: "No strong food-pattern clue was available, so Argentine local meal timing is the main prior." };
}
function defaultGramRange(grams, confidence) {
  const spread = confidence >= 0.8 ? 0.18 : confidence >= 0.65 ? 0.28 : 0.4;
  return { low: Math.max(0, grams * (1 - spread)), high: grams * (1 + spread) };
}
function calculate(food, grams, confidence = 0.86, evidence) {
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
    fiber: Math.round((food.fiber ?? 0) * factor * 10) / 10,
    fat: Math.round(food.fat * factor * 10) / 10,
    confidence,
    visualEvidence: evidence?.visualEvidence || "Matched from the meal description.",
    portionBasis: evidence?.portionBasis || `Default ${food.serving_label} serving, editable before saving.`,
    gramsLow: Math.round(Math.max(0, Math.min(grams, evidence?.gramsLow ?? fallbackRange.low))),
    gramsHigh: Math.round(Math.max(grams, evidence?.gramsHigh ?? fallbackRange.high)),
    uncertaintyReasons: evidence?.uncertaintyReasons ?? ["The portion was not weighed."]
  };
}
function roundRange(low, high, precision = 0) {
  const factor = 10 ** precision;
  return { low: Math.round(low * factor) / factor, high: Math.round(high * factor) / factor };
}
function calculateEstimateRange(items) {
  const totals = {
    calories: { low: 0, high: 0 },
    protein: { low: 0, high: 0 },
    carbs: { low: 0, high: 0 },
    fiber: { low: 0, high: 0 },
    fat: { low: 0, high: 0 }
  };
  for (const item of items) {
    const pointGrams = Math.max(1, item.grams);
    const lowFactor = item.gramsLow / pointGrams;
    const highFactor = item.gramsHigh / pointGrams;
    for (const nutrient of ["calories", "protein", "carbs", "fiber", "fat"]) {
      totals[nutrient].low += (item[nutrient] ?? 0) * lowFactor;
      totals[nutrient].high += (item[nutrient] ?? 0) * highFactor;
    }
  }
  return {
    calories: roundRange(totals.calories.low, totals.calories.high),
    protein: roundRange(totals.protein.low, totals.protein.high, 1),
    carbs: roundRange(totals.carbs.low, totals.carbs.high, 1),
    fiber: roundRange(totals.fiber.low, totals.fiber.high, 1),
    fat: roundRange(totals.fat.low, totals.fat.high, 1)
  };
}
function fallbackMeasurement(reference, capture) {
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
    explanation: reference.mode === "none" ? "No known-size reference was selected, so familiar serving sizes and a wider uncertainty range were used." : "No reliable complete plate rim was available, so familiar serving sizes were used."
  };
}
function matchFood(foods, name) {
  const target = clean(name);
  let best;
  for (const food of foods) {
    const aliases = [food.name, ...JSON.parse(food.aliases)].map(clean);
    for (const alias of aliases) {
      let score = 0;
      if (target === alias) score = 1e3 + alias.length;
      else if (target.includes(alias)) score = 500 + alias.length;
      else if (alias.includes(target) && target.length >= 4) score = 100 + target.length;
      if (score > (best?.score ?? 0)) best = { food, score };
    }
  }
  return best?.food;
}
function gramsFromText(segment, food) {
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
function analyzeDescription(foods, description, options) {
  const normalized = description.trim();
  const segments = normalized.split(/,|\+|\n|\s+(?:and|with|y|con)\s+/i).map((part) => part.trim()).filter(Boolean);
  const items = [];
  const missed = [];
  for (const segment of segments) {
    const food = matchFood(foods, segment);
    if (food) items.push(calculate(food, gramsFromText(segment, food)));
    else missed.push(segment);
  }
  if (items.length === 0 && normalized) {
    const food = matchFood(foods, normalized);
    if (food) items.push(calculate(food, gramsFromText(normalized, food)));
  }
  const warnings = [
    "Portions are estimates. Adjust grams before saving.",
    ...missed.length ? [`Could not match: ${missed.join(", ")}. Add these manually after saving.`] : []
  ];
  return {
    title: items.length ? items.slice(0, 2).map((item) => item.name.split(",")[0]).join(" + ") : "Meal scan",
    confidence: items.length ? Math.max(0.55, 0.9 - missed.length * 0.12) : 0.25,
    provider: "rules",
    items,
    assumptions: ["Default serving sizes were used where you did not provide grams."],
    warnings,
    range: calculateEstimateRange(items),
    measurement: fallbackMeasurement(options.scaleReference),
    mealTypeSuggestion: suggestArgentineMealType(description, options.localTime),
    highImpactQuestion: items.length ? "Do you know the approximate grams or serving size?" : void 0,
    pipelineVersion: "single-photo-v2"
  };
}
function buildDescriptionPrompt(description, memories, mealContext) {
  return `You are estimating one meal for a personal nutrition diary from a WRITTEN DESCRIPTION ONLY. There is no photograph. Output only the requested structured data. Never claim to have seen the meal, a plate, a portion, or any visual evidence.

Use this evidence order:
1. Quantities the user stated, in grams, millilitres, units, or household measures such as a cup, a plate, a spoonful, "un plato de", "una porci\xF3n".
2. A genuinely matching personal meal memory.
3. Typical serving sizes for how this food is normally eaten in Argentina.

Method:
- Break the description into separately countable edible components, including drinks, oils, dressings, and spreads that carry real calories. If a component is implied by the dish rather than stated, include it and say so in the assumptions.
- Convert vague quantities honestly. "Un plato de fideos" is a normal Argentine plated portion, not a competition serving. When the user gives no quantity at all, assume one ordinary serving for that food and put that assumption in writing.
- Estimate edible grams for every item. Because nothing was seen, ranges must be WIDER than a photo estimate: the gap between gramsLow and gramsHigh should be roughly 40% of the point estimate for anything the user did not weigh or count, and may only be narrow where an exact quantity was stated.
- Nutrients are TOTALS for the estimated portion, never per 100 g. Cross-check calories against roughly 4 kcal/g protein, 4 kcal/g carbohydrate, and 9 kcal/g fat.
- Report dietary fibre for every item. Fibre is a COMPONENT of the carbohydrate figure, not an addition to it: fiber must never exceed carbs, and carbs must not be increased to make room for it. Meat, fish, eggs, dairy, and pure oils are 0 g fibre. Whole grains, legumes, vegetables, fruit with skin, nuts, and seeds carry most of it.
- Cooking method changes calories a lot and is usually unstated. If frying, oil, butter, sugar, or portion count is the one fact that would move calories by about 10% or more, ask exactly one short high-impact question.
- Set visualEvidence for every item to what the user actually wrote, quoting their words. Do not invent colours, plating, or appearance.
- Suggest one diary category using Argentine context. The national GAPA pattern has four standard meals: Breakfast/desayuno, Lunch/almuerzo, Merienda, and Dinner/cena. Use Treat only for a standalone discretionary sweet/snack or antojo, not automatically for a normal merienda. The words the user used are stronger evidence than the clock; local time is a useful prior.
- Return concise observable evidence and assumptions, not hidden reasoning.

ARGENTINE DIARY CONTEXT: ${mealContext ? JSON.stringify(mealContext) : "local time unavailable"}
PERSONAL MEMORIES (apply only matching ones and return their IDs): ${JSON.stringify(memories)}
WHAT THE USER SAYS THEY ATE: ${description.trim() || "nothing written"}`;
}
function buildSinglePhotoPrompt(reference, description, memories, capture, mealContext) {
  const scaleInstruction = reference.mode === "none" ? "NO known-size plate or reference object is being provided for this photo. Do not convert pixels to centimeters and do not claim that any visible plate has a known diameter. Use familiar serving priors with wider uncertainty." : `The selected reference is a flat circular plate with an OUTER EDGE-TO-EDGE DIAMETER of exactly ${reference.diameterCm} cm. This is a diameter, not an area, radius, circumference, or a ${reference.diameterCm} cm by ${reference.diameterCm} cm square. Apply it as scale only when the complete outer rim is visible and plausibly matches the selected ${reference.mode === "default-plate" ? "saved" : "different"} plate.`;
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
- Report dietary fibre for every item. Fibre is a COMPONENT of the carbohydrate figure, not an addition to it: fiber must never exceed carbs, and carbs must not be increased to make room for it. Meat, fish, eggs, dairy, and pure oils are 0 g fibre. Whole grains, legumes, vegetables, fruit with skin, nuts, and seeds carry most of it.
- If one missing fact could move calories by about 10% or more, ask exactly one short high-impact question. Oil amount, recipe yield, and serving count usually matter more than the oil variety.
- Assess the photograph honestly. Scale confidence cannot be high if any plate edge is cropped, obscured, or the image is blurry. Define viewAngleDeg as degrees above the plate plane: 90 is directly overhead and 45 is an angled view.
- Suggest one diary category using Argentine context. The national GAPA pattern has four standard meals: Breakfast/desayuno, Lunch/almuerzo, Merienda, and Dinner/cena. Use Treat only for a standalone discretionary sweet/snack or antojo, not automatically for a normal merienda. Food composition and the user's note are stronger evidence than the clock; local time is a useful prior. Do not add foods merely to make the photo fit a category.
- Return concise observable evidence and assumptions, not hidden reasoning.

ARGENTINE DIARY CONTEXT: ${mealContext ? JSON.stringify(mealContext) : "local time unavailable"}
CLIENT PHOTO CHECK: ${capture ? JSON.stringify(capture) : "not available"}
PERSONAL MEMORIES (apply only matching ones and return their IDs): ${JSON.stringify(memories)}
USER NOTE: ${description.trim() || "none"}`;
}
function normalizeMeasurement(parsed, reference, capture) {
  const captureQuality = capture ? capture.qualityScore < 45 ? "poor" : capture.qualityScore < 70 ? "usable" : "good" : parsed?.captureQuality ?? "usable";
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
    explanation: reference.mode === "none" ? "No known-size plate was selected, so the image was not converted to real-world scale." : parsed?.explanation?.trim() || (plateUsedAsScale ? "The complete plate rim was used as a scale reference." : "The complete plate rim was not reliable enough to use as a scale reference.")
  };
}
function normalizeMealTypeSuggestion(parsed, description, localTime) {
  const fallback = suggestArgentineMealType(description, localTime);
  const allowed = ["Breakfast", "Lunch", "Merienda", "Dinner", "Treat"];
  if (!parsed?.type || !allowed.includes(parsed.type)) return fallback;
  return {
    type: parsed.type,
    confidence: Math.round(Math.max(0.25, Math.min(0.95, Number(parsed.confidence ?? fallback.confidence))) * 100) / 100,
    explanation: parsed.explanation?.trim() || fallback.explanation
  };
}
function calibrateAnalysisConfidence(reported, measurement, appliedMemoryCount = 0) {
  const cap = measurement.scaleConfidence === "high" ? 0.84 : measurement.scaleConfidence === "medium" ? 0.74 : measurement.scaleConfidence === "low" ? 0.64 : 0.56;
  const memoryBonus = appliedMemoryCount ? 0.03 : 0;
  const capturePenalty = measurement.captureQuality === "poor" ? 0.12 : 0;
  return Math.round(Math.max(0.2, Math.min(reported, cap + memoryBonus - capturePenalty)) * 100) / 100;
}
function normalizeItem(foods, item, measurement, allowTightRange) {
  const grams = Math.max(1, Number(item.grams ?? 0));
  const confidence = Math.max(0.2, Math.min(0.92, Number(item.confidence ?? 0.55)));
  const minimumSpread = allowTightRange ? 0.05 : measurement.scaleConfidence === "high" ? 0.15 : measurement.scaleConfidence === "medium" ? 0.22 : 0.3;
  const gramsLow = Math.max(0, Math.min(grams, Number(item.gramsLow ?? grams * (1 - minimumSpread)), grams * (1 - minimumSpread)));
  const gramsHigh = Math.max(grams, Number(item.gramsHigh ?? grams * (1 + minimumSpread)), grams * (1 + minimumSpread));
  const matched = matchFood(foods, item.name ?? "");
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
  const fiber = Math.min(carbs, Math.max(0, Number(item.fiber ?? 0)));
  const fat = Math.max(0, Number(item.fat ?? 0));
  const reportedCalories = Math.max(0, Number(item.calories ?? 0));
  const macroCalories = protein * 4 + carbs * 4 + fat * 9;
  const calories = macroCalories > 0 && (reportedCalories < macroCalories * 0.65 || reportedCalories > macroCalories * 1.35) ? macroCalories : reportedCalories;
  return {
    foodId: null,
    name: item.name ?? "Unknown food",
    emoji: "\u{1F37D}\uFE0F",
    grams: Math.round(grams),
    calories: Math.round(calories),
    protein: Math.round(protein * 10) / 10,
    carbs: Math.round(carbs * 10) / 10,
    fiber: Math.round(fiber * 10) / 10,
    fat: Math.round(fat * 10) / 10,
    confidence,
    visualEvidence: item.visualEvidence || "Identified from the visible meal.",
    portionBasis: item.portionBasis || "Estimated from its footprint relative to the plate and a typical height/density prior.",
    gramsLow: Math.round(gramsLow),
    gramsHigh: Math.round(gramsHigh),
    uncertaintyReasons: evidence.uncertaintyReasons
  };
}
var analysisJsonSchema, refinementJsonSchema, refinementPrompt;
var init_analysis_core = __esm({
  "shared/analysis-core.ts"() {
    "use strict";
    __name(clean, "clean");
    __name(normalizeScaleReference, "normalizeScaleReference");
    __name(suggestArgentineMealType, "suggestArgentineMealType");
    __name(defaultGramRange, "defaultGramRange");
    __name(calculate, "calculate");
    __name(roundRange, "roundRange");
    __name(calculateEstimateRange, "calculateEstimateRange");
    __name(fallbackMeasurement, "fallbackMeasurement");
    __name(matchFood, "matchFood");
    __name(gramsFromText, "gramsFromText");
    __name(analyzeDescription, "analyzeDescription");
    __name(buildDescriptionPrompt, "buildDescriptionPrompt");
    __name(buildSinglePhotoPrompt, "buildSinglePhotoPrompt");
    __name(normalizeMeasurement, "normalizeMeasurement");
    __name(normalizeMealTypeSuggestion, "normalizeMealTypeSuggestion");
    __name(calibrateAnalysisConfidence, "calibrateAnalysisConfidence");
    __name(normalizeItem, "normalizeItem");
    analysisJsonSchema = {
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
              required: ["name", "grams", "gramsLow", "gramsHigh", "calories", "protein", "carbs", "fiber", "fat", "confidence", "visualEvidence", "portionBasis", "uncertaintyReasons"],
              properties: {
                name: { type: "string" },
                grams: { type: "number", minimum: 0 },
                gramsLow: { type: "number", minimum: 0 },
                gramsHigh: { type: "number", minimum: 0 },
                calories: { type: "number", minimum: 0 },
                protein: { type: "number", minimum: 0 },
                carbs: { type: "number", minimum: 0 },
                fiber: { type: "number", minimum: 0 },
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
    };
    refinementJsonSchema = {
      name: "meal_refinement",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "confidence", "items", "assumptions", "warnings", "assistantReply", "shouldRemember", "memory"],
        properties: {
          title: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "grams", "calories", "protein", "carbs", "fiber", "fat", "confidence", "visualEvidence", "portionBasis"],
              properties: {
                name: { type: "string" },
                grams: { type: "number", minimum: 0 },
                calories: { type: "number", minimum: 0 },
                protein: { type: "number", minimum: 0 },
                carbs: { type: "number", minimum: 0 },
                fiber: { type: "number", minimum: 0 },
                fat: { type: "number", minimum: 0 },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                visualEvidence: { type: "string" },
                portionBasis: { type: "string" }
              }
            }
          },
          assumptions: { type: "array", items: { type: "string" } },
          warnings: { type: "array", items: { type: "string" } },
          assistantReply: { type: "string" },
          shouldRemember: { type: "boolean" },
          memory: { type: "object", additionalProperties: false, required: ["subject", "note"], properties: { subject: { type: "string" }, note: { type: "string" } } }
        }
      }
    };
    refinementPrompt = `You are refining a meal estimate in a chat with its owner. Update the estimate using the correction. Save a reusable memory only when the user explicitly says to remember it or clearly describes what they always/usually do. A preparation detail stated only for today's meal and portion corrections for this plate must not be remembered. Keep visual evidence distinct from facts supplied by the user. Dietary fibre is a component of the carbohydrate figure and must never exceed it.`;
  }
});
