import fs from "node:fs";
import path from "node:path";
import { analyzeWithConfiguredProvider } from "../server/analysis.js";
import { db, rootDir } from "../server/db.js";

type BenchmarkRow = {
  id: string;
  name: string;
  image_path: string;
  truth_mass: number;
  truth_calories: number;
  truth_protein: number;
  truth_carbs: number;
  truth_fat: number;
};

if (!process.env.OPENROUTER_API_KEY) throw new Error("Set OPENROUTER_API_KEY only for this test process.");

const cases = db.prepare("SELECT id, name, image_path, truth_mass, truth_calories, truth_protein, truth_carbs, truth_fat FROM benchmark_cases WHERE source = 'Nutrition5k' ORDER BY id").all() as unknown as BenchmarkRow[];
if (!cases.length) throw new Error("No Nutrition5k benchmark cases are installed.");
const usePlateScale = process.env.BENCHMARK_USE_PLATE === "true";

const runs = [];
for (const benchmarkCase of cases) {
  const relativePath = `/data${benchmarkCase.image_path}`;
  const result = await analyzeWithConfiguredProvider(usePlateScale ? "" : "Benchmark photo: this is not my usual plate and its diameter is unknown. Do not apply the 25 cm plate scale.", [relativePath]);
  if (result.provider !== "openrouter") throw new Error(result.warnings[0] || "The model call did not complete.");
  const predicted = result.items.reduce((total, item) => ({
    mass: total.mass + item.grams,
    calories: total.calories + item.calories,
    protein: total.protein + item.protein,
    carbs: total.carbs + item.carbs,
    fat: total.fat + item.fat
  }), { mass: 0, calories: 0, protein: 0, carbs: 0, fat: 0 });
  const truth = { mass: benchmarkCase.truth_mass, calories: benchmarkCase.truth_calories, protein: benchmarkCase.truth_protein, carbs: benchmarkCase.truth_carbs, fat: benchmarkCase.truth_fat };
  const errors = Object.fromEntries(Object.entries(truth).map(([key, value]) => [key, Math.abs(predicted[key as keyof typeof predicted] - value)]));
  const calorieCovered = result.range.calories.low <= truth.calories && result.range.calories.high >= truth.calories;
  runs.push({
    id: benchmarkCase.id,
    name: benchmarkCase.name,
    truth,
    predicted,
    errors,
    calorieRange: result.range.calories,
    calorieCovered,
    confidence: result.confidence,
    measurement: result.measurement,
    costUsd: result.usage?.costUsd ?? 0,
    latencyMs: result.usage?.latencyMs ?? 0,
    items: result.items.map((item) => ({ name: item.name, grams: item.grams, gramsLow: item.gramsLow, gramsHigh: item.gramsHigh }))
  });
}

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const summary = {
  pipeline: usePlateScale ? "single-photo-v2-plate25" : "single-photo-v2-no-scale",
  model: process.env.OPENROUTER_MODEL || "google/gemini-3.1-flash-lite",
  cases: runs.length,
  calorieMae: average(runs.map((run) => run.errors.calories)),
  massMae: average(runs.map((run) => run.errors.mass)),
  macroMae: average(runs.flatMap((run) => [run.errors.protein, run.errors.carbs, run.errors.fat])),
  calorieRangeCoverage: average(runs.map((run) => run.calorieCovered ? 1 : 0)),
  averageCostUsd: average(runs.map((run) => run.costUsd)),
  averageLatencyMs: average(runs.map((run) => run.latencyMs))
};

const output = { createdAt: new Date().toISOString(), summary, runs };
const outputPath = path.join(rootDir, "tmp", `single-photo-v2-${usePlateScale ? "plate25" : "no-scale"}-results.json`);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, ...summary }, null, 2));
