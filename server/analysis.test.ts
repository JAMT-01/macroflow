import { describe, expect, it } from "vitest";
import { analyzeDescription, buildSinglePhotoPrompt, calculateEstimateRange, calibrateAnalysisConfidence, matchFood, suggestArgentineMealType } from "./analysis.js";

const capture = { width: 3024, height: 4032, brightness: .5, contrast: .2, sharpness: .4, qualityScore: 88, issues: [] };

describe("local meal analysis", () => {
  it("understands a Spanish multi-food meal with explicit portions", () => {
    const result = analyzeDescription("200g milanesa de pollo al horno, 10g aceite de girasol y 150g arroz blanco");

    expect(result.items.map((item) => item.name)).toEqual([
      "Chicken milanesa",
      "Sunflower oil",
      "White rice, cooked"
    ]);
    expect(result.items.map((item) => item.grams)).toEqual([200, 10, 150]);
    expect(result.items.reduce((sum, item) => sum + item.calories, 0)).toBe(773);
  });

  it("matches common Spanish aliases without accents", () => {
    expect(matchFood("pechuga de pollo")?.name).toBe("Chicken breast, cooked");
    expect(matchFood("pure de papa")?.name).toBe("Mashed potatoes");
  });

  it("reports unmatched parts instead of inventing nutrients", () => {
    const result = analyzeDescription("150g arroz blanco con salsa secreta espacial");

    expect(result.items).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("salsa secreta espacial");
  });

  it("makes default portion assumptions visible and editable", () => {
    const result = analyzeDescription("milanesa de pollo");

    expect(result.assumptions.join(" ")).toContain("Default serving sizes");
    expect(result.items[0].portionBasis).toContain("editable before saving");
    expect(result.items[0].visualEvidence).toContain("meal description");
  });

  it("returns honest portion and nutrient ranges for unweighed text meals", () => {
    const result = analyzeDescription("200g chicken, rice");
    expect(result.pipelineVersion).toBe("single-photo-v2");
    expect(result.items.every((item) => item.gramsLow <= item.grams && item.gramsHigh >= item.grams)).toBe(true);
    expect(result.range.calories.low).toBeLessThanOrEqual(result.items.reduce((sum, item) => sum + item.calories, 0));
    expect(result.range.calories.high).toBeGreaterThanOrEqual(result.items.reduce((sum, item) => sum + item.calories, 0));
  });

  it("uses exactly one RGB photo and a 25 cm plate conservatively in the prompt", () => {
    const prompt = buildSinglePhotoPrompt({ mode: "default-plate", diameterCm: 25 }, "milanesa", [], capture);
    expect(prompt).toContain("exactly ONE ordinary RGB photograph");
    expect(prompt).toContain("OUTER EDGE-TO-EDGE DIAMETER of exactly 25 cm");
    expect(prompt).toContain("complete outer rim");
    expect(prompt).toContain("Do not pretend one image uniquely reveals food height");
  });

  it("states that the 25 cm plate is a diameter and not a square", () => {
    const prompt = buildSinglePhotoPrompt({ mode: "default-plate", diameterCm: 25 }, "milanesa", [], capture);
    expect(prompt).toContain("This is a diameter, not an area, radius, circumference, or a 25 cm by 25 cm square");
  });

  it("forbids pixel-to-centimetre conversion when no reference is selected", () => {
    const prompt = buildSinglePhotoPrompt({ mode: "none", diameterCm: null }, "milanesa", [], capture);
    expect(prompt).toContain("NO known-size plate or reference object is being provided");
    expect(prompt).toContain("Do not convert pixels to centimeters");
    expect(prompt).not.toContain("OUTER EDGE-TO-EDGE DIAMETER");
  });

  it("caps model confidence when plate scale is unavailable", () => {
    const noScale = calibrateAnalysisConfidence(.95, { referenceMode: "default-plate", plateDiameterCm: 25, plateProfile: "round-flat", plateVisible: false, wholePlateVisible: false, plateUsedAsScale: false, viewAngleDeg: null, scaleConfidence: "none", captureQuality: "good", explanation: "No rim" });
    const goodScale = calibrateAnalysisConfidence(.95, { referenceMode: "default-plate", plateDiameterCm: 25, plateProfile: "round-flat", plateVisible: true, wholePlateVisible: true, plateUsedAsScale: true, viewAngleDeg: 45, scaleConfidence: "high", captureQuality: "good", explanation: "Full rim" });
    expect(noScale).toBe(.56);
    expect(goodScale).toBe(.84);
  });

  it("files an afternoon mate with facturas as merienda, not as a treat", () => {
    expect(suggestArgentineMealType("mate con facturas", "17:30").type).toBe("Merienda");
    expect(suggestArgentineMealType("cafe con leche y tostadas", "08:15").type).toBe("Breakfast");
  });

  it("lets the food override the clock for the two main meals", () => {
    expect(suggestArgentineMealType("milanesa con pure", "13:00").type).toBe("Lunch");
    expect(suggestArgentineMealType("milanesa con pure", "22:00").type).toBe("Dinner");
    expect(suggestArgentineMealType("pizza", "23:30").type).toBe("Dinner");
  });

  it("keeps Treat for a standalone sweet at any hour", () => {
    const lateAlfajor = suggestArgentineMealType("un alfajor", "23:00");
    expect(lateAlfajor.type).toBe("Treat");
    expect(suggestArgentineMealType("helado", "16:00").type).toBe("Treat");
  });

  it("falls back to Argentine meal timing when the food gives no clue", () => {
    expect(suggestArgentineMealType("", "21:30").type).toBe("Dinner");
    expect(suggestArgentineMealType("", "17:00").type).toBe("Merienda");
    expect(suggestArgentineMealType("", "12:30").type).toBe("Lunch");
    expect(suggestArgentineMealType("", "17:00").confidence).toBeLessThan(suggestArgentineMealType("milanesa con pure", "13:00").confidence);
  });

  it("attaches a category suggestion to every text analysis", () => {
    const result = analyzeDescription("200g milanesa de pollo", { localTime: "21:45" });
    expect(result.mealTypeSuggestion.type).toBe("Dinner");
    expect(result.mealTypeSuggestion.explanation).toContain("cena");
  });

  it("aggregates item gram uncertainty into macro ranges", () => {
    const item = analyzeDescription("100g chicken").items[0];
    const range = calculateEstimateRange([{ ...item, gramsLow: 80, gramsHigh: 120 }]);
    expect(range.protein.low).toBeLessThan(item.protein);
    expect(range.protein.high).toBeGreaterThan(item.protein);
  });
});
