import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { benchmarkDir, db, deleteAppSecret, getOpenRouterApiKey, getOpenRouterKeySource, getSettings, rootDir, setAppSecret, uploadsDir } from "./db.js";
import { analyzeWithConfiguredProvider, getAiStatus, refineAnalysis, type ScaleReference } from "./analysis.js";
import { sendTelegramMessage, startTelegramService } from "./telegram.js";
import { addCalendarDays, dateInTimeZone, dateRangeUtc, diaryTimestamp, getTimeContext, isValidTimeZone } from "./time.js";
import { listBenchmarkCases, listVisionModels, runBenchmark, type BenchmarkStrategy } from "./benchmark.js";

const app = express();
const port = Number(process.env.PORT || 8787);
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(uploadsDir));
app.use("/benchmark", express.static(benchmarkDir));

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (_req, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname || ".jpg").toLowerCase() || ".jpg"}`)
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith("image/"))
});

const customBenchmarkDir = path.join(benchmarkDir, "custom");
fs.mkdirSync(customBenchmarkDir, { recursive: true });
const benchmarkUpload = multer({
  storage: multer.diskStorage({
    destination: customBenchmarkDir,
    filename: (_req, file, callback) => callback(null, `${randomUUID()}-${file.fieldname}${path.extname(file.originalname || ".jpg").toLowerCase() || ".jpg"}`)
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 2 },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith("image/"))
});

const itemSchema = z.object({
  foodId: z.number().nullable().optional(),
  name: z.string().min(1),
  grams: z.number().nonnegative(),
  calories: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  carbs: z.number().nonnegative(),
  fat: z.number().nonnegative()
});

const mealSchema = z.object({
  loggedAt: z.string().optional(),
  loggedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  mealType: z.enum(["Breakfast", "Lunch", "Merienda", "Dinner", "Treat"]),
  title: z.string().min(1),
  imagePath: z.string().nullable().optional(),
  imagePaths: z.array(z.string()).max(1).optional(),
  notes: z.string().optional(),
  source: z.string().optional(),
  confidence: z.number().nullable().optional(),
  items: z.array(itemSchema).min(1)
});

const benchmarkCaseSchema = z.object({
  name: z.string().min(1),
  source: z.string().default("Personal weighed meal"),
  sourceId: z.string().optional(),
  ingredients: z.string().optional(),
  truthMass: z.coerce.number().positive(),
  truthCalories: z.coerce.number().nonnegative(),
  truthProtein: z.coerce.number().nonnegative(),
  truthCarbs: z.coerce.number().nonnegative(),
  truthFat: z.coerce.number().nonnegative()
});

const captureSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  brightness: z.number().min(0).max(1),
  contrast: z.number().min(0).max(1),
  sharpness: z.number().min(0).max(1),
  qualityScore: z.number().min(0).max(100),
  issues: z.array(z.string()).max(10)
});

const scaleReferenceSchema = z.object({
  mode: z.enum(["default-plate", "custom-plate", "none"]),
  diameterCm: z.number().min(15).max(40).nullable()
}).superRefine((value, context) => {
  if (value.mode !== "none" && value.diameterCm == null) context.addIssue({ code: "custom", message: "A known plate needs an edge-to-edge diameter" });
});

function serializeSettings() {
  const settings = getSettings();
  const time = getTimeContext(settings.timezone);
  return {
    name: settings.name,
    onboardingComplete: Boolean(settings.onboarding_complete),
    calorieTarget: settings.calorie_target,
    proteinTarget: settings.protein_target,
    carbsTarget: settings.carbs_target,
    fatTarget: settings.fat_target,
    weightKg: settings.weight_kg,
    heightCm: settings.height_cm,
    age: settings.age,
    sex: settings.sex,
    activity: settings.activity,
    goal: settings.goal,
    theme: settings.theme,
    plateDiameterCm: settings.plate_diameter_cm,
    openrouterConfigured: Boolean(getOpenRouterApiKey()),
    openrouterKeySource: getOpenRouterKeySource(),
    openrouterModel: process.env.OPENROUTER_MODEL || settings.openrouter_model,
    telegramTokenConfigured: Boolean(settings.telegram_bot_token),
    telegramChatId: settings.telegram_chat_id,
    timezone: settings.timezone,
    reminders: JSON.parse(settings.reminders_json),
    today: time.today,
    now: time.now,
    localTime: time.localTime,
    greeting: time.greeting,
    dayStartedAt: time.dayStartedAt,
    dayEndsAt: time.dayEndsAt
  };
}

function getMealRows(date: string) {
  const settings = getSettings();
  const range = dateRangeUtc(date, settings.timezone);
  const meals = db.prepare(`
    SELECT * FROM meals WHERE logged_at >= ? AND logged_at < ? ORDER BY logged_at DESC
  `).all(range.start, range.end) as Array<Record<string, unknown>>;
  const itemsQuery = db.prepare("SELECT * FROM meal_items WHERE meal_id = ? ORDER BY rowid");
  return meals.map((meal) => ({
    id: meal.id,
    loggedAt: meal.logged_at,
    mealType: meal.meal_type,
    title: meal.title,
    imagePath: meal.image_path,
    imagePaths: (() => {
      try { return JSON.parse(String(meal.image_paths_json || "[]")) as string[]; }
      catch { return meal.image_path ? [String(meal.image_path)] : []; }
    })(),
    notes: meal.notes,
    source: meal.source,
    confidence: meal.confidence,
    items: (itemsQuery.all(meal.id as string) as Array<Record<string, unknown>>).map((item) => ({
      id: item.id,
      foodId: item.food_id,
      name: item.name,
      grams: item.grams,
      calories: item.calories,
      protein: item.protein,
      carbs: item.carbs,
      fat: item.fat
    }))
  }));
}

app.get("/api/health", (_req, res) => res.json({ ok: true, storage: "sqlite", now: new Date().toISOString() }));
app.get("/api/settings", (_req, res) => res.json(serializeSettings()));
app.get("/api/time", (_req, res) => res.json(getTimeContext(getSettings().timezone)));

app.patch("/api/settings", (req, res) => {
  if ("timezone" in req.body && !isValidTimeZone(String(req.body.timezone))) return res.status(400).json({ error: "Enter a valid IANA timezone, such as America/Buenos_Aires" });
  if ("plateDiameterCm" in req.body && (!Number.isFinite(Number(req.body.plateDiameterCm)) || Number(req.body.plateDiameterCm) < 15 || Number(req.body.plateDiameterCm) > 40)) return res.status(400).json({ error: "Plate diameter must be between 15 and 40 cm" });
  if ("openrouterApiKey" in req.body) {
    const key = String(req.body.openrouterApiKey || "").trim();
    if (!key.startsWith("sk-or-") || key.length < 30) return res.status(400).json({ error: "That does not look like a valid OpenRouter API key" });
    setAppSecret("openrouter_api_key", key);
  } else if (req.body.clearOpenrouterApiKey === true) {
    deleteAppSecret("openrouter_api_key");
  }
  const mapping: Record<string, string> = {
    name: "name", onboardingComplete: "onboarding_complete", calorieTarget: "calorie_target", proteinTarget: "protein_target",
    carbsTarget: "carbs_target", fatTarget: "fat_target", weightKg: "weight_kg", heightCm: "height_cm", age: "age",
    sex: "sex", activity: "activity", goal: "goal", theme: "theme", openrouterModel: "openrouter_model",
    telegramBotToken: "telegram_bot_token", telegramChatId: "telegram_chat_id", timezone: "timezone",
    plateDiameterCm: "plate_diameter_cm"
  };
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, column] of Object.entries(mapping)) {
    if (!(key in req.body)) continue;
    updates.push(`${column} = ?`);
    values.push(key === "onboardingComplete" ? (req.body[key] ? 1 : 0) : req.body[key] as string | number | null);
  }
  if (Array.isArray(req.body.reminders)) {
    updates.push("reminders_json = ?");
    values.push(JSON.stringify(req.body.reminders));
  }
  if (updates.length) {
    updates.push("updated_at = CURRENT_TIMESTAMP");
    db.prepare(`UPDATE settings SET ${updates.join(", ")} WHERE id = 1`).run(...values);
  }
  res.json(serializeSettings());
});

app.get("/api/foods", (req, res) => {
  const query = String(req.query.q || "").trim();
  const rows = query
    ? db.prepare("SELECT * FROM foods WHERE name LIKE ? OR aliases LIKE ? OR category LIKE ? ORDER BY CASE WHEN name LIKE ? THEN 0 ELSE 1 END, name LIMIT 30").all(`%${query}%`, `%${query}%`, `%${query}%`, `${query}%`)
    : db.prepare("SELECT * FROM foods ORDER BY category, name LIMIT 30").all();
  res.json((rows as Array<Record<string, unknown>>).map((row) => ({
    id: row.id, name: row.name, brand: row.brand, category: row.category, emoji: row.emoji,
    servingLabel: row.serving_label, servingGrams: row.serving_grams,
    calories: row.calories, protein: row.protein, carbs: row.carbs, fat: row.fat
  })));
});

app.get("/api/dashboard", (req, res) => {
  const settings = getSettings();
  const date = String(req.query.date || getTimeContext(settings.timezone).today);
  const meals = getMealRows(date);
  const totals = meals.flatMap((meal) => meal.items).reduce((acc, item) => ({
    calories: acc.calories + Number(item.calories), protein: acc.protein + Number(item.protein),
    carbs: acc.carbs + Number(item.carbs), fat: acc.fat + Number(item.fat)
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
  res.json({ date, settings: serializeSettings(), totals, meals });
});

app.post("/api/meals", (req, res) => {
  const parsed = mealSchema.parse(req.body);
  const id = randomUUID();
  const settings = getSettings();
  const loggedAt = parsed.loggedAt || (parsed.loggedDate ? diaryTimestamp(parsed.loggedDate, settings.timezone) : new Date().toISOString());
  const imagePaths = parsed.imagePaths?.length ? parsed.imagePaths : parsed.imagePath ? [parsed.imagePath] : [];
  db.prepare("INSERT INTO meals (id, logged_at, meal_type, title, image_path, image_paths_json, notes, source, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, loggedAt, parsed.mealType, parsed.title, parsed.imagePath ?? imagePaths[0] ?? null, JSON.stringify(imagePaths), parsed.notes ?? "", parsed.source ?? "manual", parsed.confidence ?? null);
  const insertItem = db.prepare("INSERT INTO meal_items (id, meal_id, food_id, name, grams, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of parsed.items) insertItem.run(randomUUID(), id, item.foodId ?? null, item.name, item.grams, item.calories, item.protein, item.carbs, item.fat);
  res.status(201).json({ id });
});

app.delete("/api/meals/:id", (req, res) => {
  const meal = db.prepare("SELECT image_path, image_paths_json FROM meals WHERE id = ?").get(req.params.id) as { image_path?: string; image_paths_json?: string } | undefined;
  db.prepare("DELETE FROM meals WHERE id = ?").run(req.params.id);
  let imagePaths: string[] = [];
  try { imagePaths = JSON.parse(meal?.image_paths_json || "[]") as string[]; } catch { /* Legacy row. */ }
  if (!imagePaths.length && meal?.image_path) imagePaths = [meal.image_path];
  for (const imagePath of new Set(imagePaths.filter((item) => item.startsWith("/uploads/")))) {
    const file = path.join(rootDir, "data", imagePath.replace(/^\/uploads\//, "uploads/"));
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  res.status(204).end();
});

app.post("/api/meals/:id/duplicate", (req, res) => {
  const meal = db.prepare("SELECT * FROM meals WHERE id = ?").get(req.params.id) as Record<string, unknown> | undefined;
  if (!meal) return res.status(404).json({ error: "Meal not found" });
  const id = randomUUID();
  db.prepare("INSERT INTO meals (id, logged_at, meal_type, title, image_path, image_paths_json, notes, source, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, new Date().toISOString(), String(meal.meal_type), String(meal.title), meal.image_path == null ? null : String(meal.image_path), String(meal.image_paths_json || "[]"), String(meal.notes ?? ""), "repeat", meal.confidence == null ? null : Number(meal.confidence));
  const items = db.prepare("SELECT * FROM meal_items WHERE meal_id = ?").all(req.params.id) as Array<Record<string, unknown>>;
  const insert = db.prepare("INSERT INTO meal_items (id, meal_id, food_id, name, grams, calories, protein, carbs, fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const item of items) insert.run(randomUUID(), id, item.food_id == null ? null : Number(item.food_id), String(item.name), Number(item.grams), Number(item.calories), Number(item.protein), Number(item.carbs), Number(item.fat));
  return res.status(201).json({ id });
});

app.post("/api/analyze", upload.single("image"), async (req, res, next) => {
  try {
    const description = String(req.body.description || "");
    const imagePath = req.file ? `/uploads/${req.file.filename}` : undefined;
    if (!imagePath && !description.trim()) return res.status(400).json({ error: "Add a photo or meal description" });
    const capture = req.body.capture ? captureSchema.parse(JSON.parse(String(req.body.capture))) : undefined;
    const scaleReference = req.body.scaleReference ? scaleReferenceSchema.parse(JSON.parse(String(req.body.scaleReference))) as ScaleReference : undefined;
    const loggedDate = String(req.body.loggedDate || "") || undefined;
    const result = await analyzeWithConfiguredProvider(description, imagePath ? [imagePath] : [], capture, scaleReference, loggedDate);
    if (!result.items.length) return res.status(422).json({ error: "No foods could be identified. Add a short description or configure OpenRouter in Settings.", analysis: result });
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

app.get("/api/ai/status", async (_req, res) => res.json(await getAiStatus()));

app.get("/api/benchmark/cases", (_req, res) => res.json(listBenchmarkCases()));
app.get("/api/benchmark/models", async (_req, res, next) => {
  try { res.json(await listVisionModels()); } catch (error) { next(error); }
});
app.get("/api/benchmark/research", (_req, res) => res.json({
  dataset: {
    name: "Nutrition5k", dishes: 5006, rgbdDishes: 3500, license: "CC BY 4.0",
    url: "https://github.com/google-research-datasets/Nutrition5k",
    note: "Official samples include weighed ingredients, total mass, calories, protein, carbs, fat, RGB views, and aligned RealSense depth."
  },
  findings: [
    { label: "Nutrition5k RGB direct", value: "26.1% calorie MAE", url: "https://openaccess.thecvf.com/content/CVPR2021/html/Thames_Nutrition5k_Towards_Automatic_Nutritional_Understanding_of_Generic_Food_CVPR_2021_paper.html" },
    { label: "Nutrition5k RGB-D", value: "18.8% calorie MAE", url: "https://openaccess.thecvf.com/content/CVPR2021/html/Thames_Nutrition5k_Towards_Automatic_Nutritional_Understanding_of_Generic_Food_CVPR_2021_paper.html" },
    { label: "GPT-4o direct prompt", value: "88.86 kcal MAE", url: "https://openaccess.thecvf.com/content/CVPR2025W/MTF/html/Khlaisamniang_Decomposing_Food_Images_for_Better_Nutrition_Analysis_A_Nutritionist-Inspired_Two-Step_CVPRW_2025_paper.html" },
    { label: "GPT-4o two-step", value: "80.32 kcal MAE", url: "https://openaccess.thecvf.com/content/CVPR2025W/MTF/html/Khlaisamniang_Decomposing_Food_Images_for_Better_Nutrition_Analysis_A_Nutritionist-Inspired_Two-Step_CVPRW_2025_paper.html" }
  ],
  depthStudy: (() => {
    try {
      const summary = JSON.parse(fs.readFileSync(path.join(benchmarkDir, "nutrition5k", "predicted-depth-summary.json"), "utf8")) as { aggregate?: Record<string, unknown> };
      return summary.aggregate ?? null;
    } catch { return null; }
  })(),
  methodology: "Run the same cases multiple times per model and strategy. Compare MAE and PMAE; do not judge accuracy from one attractive prediction."
}));
app.post("/api/benchmark/run", async (req, res, next) => {
  try {
    const parsed = z.object({ caseId: z.string().min(1), model: z.string().min(1), strategy: z.enum(["one-step", "one-step-depth", "one-step-predicted-depth", "two-step", "two-step-depth", "two-step-predicted-depth"]) }).parse(req.body);
    res.json(await runBenchmark(parsed.caseId, parsed.model, parsed.strategy as BenchmarkStrategy));
  } catch (error) { next(error); }
});
app.post("/api/benchmark/cases", benchmarkUpload.fields([{ name: "image", maxCount: 1 }, { name: "depth", maxCount: 1 }]), (req, res) => {
  const parsed = benchmarkCaseSchema.parse(req.body);
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  const image = files?.image?.[0];
  if (!image) return res.status(400).json({ error: "Add an RGB meal image" });
  const depth = files?.depth?.[0];
  const id = randomUUID();
  const ingredients = (parsed.ingredients || "").split(",").map((item) => item.trim()).filter(Boolean);
  db.prepare(`INSERT INTO benchmark_cases
    (id, name, image_path, depth_path, source, source_id, ingredients_json, truth_mass, truth_calories, truth_protein, truth_carbs, truth_fat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, parsed.name, `/benchmark/custom/${image.filename}`, depth ? `/benchmark/custom/${depth.filename}` : null, parsed.source, parsed.sourceId ?? null, JSON.stringify(ingredients), parsed.truthMass, parsed.truthCalories, parsed.truthProtein, parsed.truthCarbs, parsed.truthFat);
  res.status(201).json(listBenchmarkCases().find((item) => item.id === id));
});

app.post("/api/analyze/refine", async (req, res, next) => {
  try {
    if (!req.body.analysis || !String(req.body.message || "").trim()) return res.status(400).json({ error: "Add a correction" });
    return res.json(await refineAnalysis(req.body.analysis, String(req.body.message)));
  } catch (error) { return next(error); }
});

app.get("/api/memories", (_req, res) => {
  res.json(db.prepare("SELECT id, subject, note, times_used timesUsed, created_at createdAt, updated_at updatedAt FROM meal_memories ORDER BY updated_at DESC").all());
});

app.delete("/api/memories/:id", (req, res) => {
  db.prepare("DELETE FROM meal_memories WHERE id = ?").run(req.params.id);
  res.status(204).end();
});

app.get("/api/history", (req, res) => {
  const days = Math.min(365, Math.max(7, Number(req.query.days || 30)));
  const settings = getSettings();
  const context = getTimeContext(settings.timezone);
  const range = {
    start: dateRangeUtc(addCalendarDays(context.today, -(days - 1)), settings.timezone).start,
    end: dateRangeUtc(context.today, settings.timezone).end
  };
  const mealTotals = db.prepare(`
    SELECT m.id, m.logged_at loggedAt, ROUND(SUM(mi.calories),1) calories,
           ROUND(SUM(mi.protein),1) protein, ROUND(SUM(mi.carbs),1) carbs, ROUND(SUM(mi.fat),1) fat
    FROM meals m JOIN meal_items mi ON mi.meal_id = m.id
    WHERE m.logged_at >= ? AND m.logged_at < ?
    GROUP BY m.id ORDER BY m.logged_at
  `).all(range.start, range.end) as Array<Record<string, unknown>>;
  const grouped = new Map<string, { date: string; calories: number; protein: number; carbs: number; fat: number; meals: number }>();
  for (const meal of mealTotals) {
    const date = dateInTimeZone(String(meal.loggedAt), settings.timezone);
    const day = grouped.get(date) ?? { date, calories: 0, protein: 0, carbs: 0, fat: 0, meals: 0 };
    day.calories += Number(meal.calories); day.protein += Number(meal.protein); day.carbs += Number(meal.carbs); day.fat += Number(meal.fat); day.meals += 1;
    grouped.set(date, day);
  }
  const nutrition = [...grouped.values()].map((day) => ({ ...day, calories: Math.round(day.calories * 10) / 10, protein: Math.round(day.protein * 10) / 10, carbs: Math.round(day.carbs * 10) / 10, fat: Math.round(day.fat * 10) / 10 }));
  const weights = db.prepare("SELECT id, recorded_at recordedAt, weight_kg weightKg FROM weight_entries ORDER BY recorded_at ASC LIMIT 365").all();
  res.json({ nutrition, weights });
});

app.post("/api/weight", (req, res) => {
  const weightKg = Number(req.body.weightKg);
  if (!Number.isFinite(weightKg) || weightKg < 20 || weightKg > 400) return res.status(400).json({ error: "Enter a valid weight" });
  const id = randomUUID();
  db.prepare("INSERT INTO weight_entries (id, recorded_at, weight_kg) VALUES (?, ?, ?)").run(id, req.body.recordedAt || new Date().toISOString(), weightKg);
  db.prepare("UPDATE settings SET weight_kg = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").run(weightKg);
  return res.status(201).json({ id });
});

app.post("/api/telegram/test", async (_req, res, next) => {
  try {
    await sendTelegramMessage("✅ <b>Macroflow is connected.</b> Your local reminder service is working.");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/export", (_req, res) => {
  const exportData = {
    exportedAt: new Date().toISOString(),
    settings: serializeSettings(),
    meals: db.prepare("SELECT * FROM meals ORDER BY logged_at").all(),
    mealItems: db.prepare("SELECT * FROM meal_items ORDER BY rowid").all(),
    weights: db.prepare("SELECT * FROM weight_entries ORDER BY recorded_at").all(),
    mealMemories: db.prepare("SELECT * FROM meal_memories ORDER BY updated_at").all()
    , benchmarkCases: db.prepare("SELECT * FROM benchmark_cases ORDER BY created_at").all()
    , benchmarkRuns: db.prepare("SELECT * FROM benchmark_runs ORDER BY created_at").all()
  };
  res.setHeader("content-disposition", `attachment; filename=macroflow-export-${new Date().toISOString().slice(0, 10)}.json`);
  res.json(exportData);
});

if (process.env.NODE_ENV === "production") {
  const dist = path.join(rootDir, "dist");
  app.use(express.static(dist));
  app.get("*splat", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid data", details: error.issues });
  return res.status(500).json({ error: error instanceof Error ? error.message : "Unexpected server error" });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Macroflow API listening on http://localhost:${port}`);
  startTelegramService();
});
