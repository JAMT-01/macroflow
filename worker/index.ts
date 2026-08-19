import { Hono } from "hono";
import { z } from "zod";
import { addCalendarDays, dateInTimeZone, dateRangeUtc, diaryTimestamp, getTimeContext, isValidTimeZone } from "../shared/time.js";
import type { CaptureMetadata, MealAnalysis, ScaleReference } from "../shared/analysis-core.js";
import { analyzeWithConfiguredProvider, getAiStatus, refineAnalysis } from "./analysis.js";
import { checkReminders, handleTelegramUpdate, registerWebhook } from "./telegram.js";
import {
  clearFailures, clearSessionCookie, createSessionCookie, hasValidSession, isLockedOut,
  loginPage, recordFailure, verifyPassword
} from "./auth.js";
import {
  deleteAppSecret, deletePhoto, getOpenRouterApiKey, getOpenRouterKeySource, getPhoto, getSettings,
  photoKey, putPhoto, setAppSecret, type Env
} from "./db.js";

const app = new Hono<{ Bindings: Env }>();

/**
 * Paths that must stay reachable without a session.
 *
 * The Telegram webhook is called by Telegram's servers, which cannot carry a
 * cookie; it authenticates with the x-telegram-bot-api-secret-token header
 * instead. /api/health is an unauthenticated liveness probe that reveals no
 * diary data.
 */
const PUBLIC_PATHS = new Set(["/api/health", "/api/auth/login", "/api/telegram/webhook"]);

const clientIp = (c: { req: { header: (name: string) => string | undefined } }) =>
  c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

app.use("*", async (c, next) => {
  const password = c.env.APP_PASSWORD;
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_PATHS.has(path)) return next();

  // Without a configured passphrase the diary would be world-readable, so fail
  // closed rather than open: serve the login page explaining how to set one.
  if (!password) {
    if (path.startsWith("/api/")) return c.json({ error: "This Macroflow has no passphrase configured yet." }, 503);
    return c.html(loginPage({ configured: false }), 503);
  }

  if (await hasValidSession(c.req.raw, password)) return next();

  if (path.startsWith("/api/") || path.startsWith("/uploads/") || path.startsWith("/progress-photos/")) {
    return c.json({ error: "Not signed in", signedOut: true }, 401);
  }
  return c.html(loginPage({ configured: true }), 401);
});

app.post("/api/auth/login", async (c) => {
  const password = c.env.APP_PASSWORD;
  if (!password) return c.html(loginPage({ configured: false }), 503);

  const ip = clientIp(c);
  if (await isLockedOut(c.env, ip)) {
    return c.html(loginPage({ configured: true, error: "Too many attempts. Try again in 15 minutes." }), 429);
  }

  const form = await c.req.formData();
  const candidate = String(form.get("password") || "");
  if (!verifyPassword(candidate, password)) {
    const { remaining } = await recordFailure(c.env, ip);
    const error = remaining > 0
      ? `That passphrase is not right. ${remaining} attempt${remaining === 1 ? "" : "s"} left.`
      : "Too many attempts. Try again in 15 minutes.";
    return c.html(loginPage({ configured: true, error }), 401);
  }

  await clearFailures(c.env, ip);
  c.header("set-cookie", await createSessionCookie(password));
  return c.redirect("/", 303);
});

app.post("/api/auth/logout", (c) => {
  c.header("set-cookie", clearSessionCookie());
  return c.json({ ok: true });
});

const itemSchema = z.object({
  foodId: z.number().nullable().optional(),
  name: z.string().min(1),
  grams: z.number().nonnegative(),
  calories: z.number().nonnegative(),
  protein: z.number().nonnegative(),
  carbs: z.number().nonnegative(),
  fiber: z.number().nonnegative().optional(),
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

async function serializeSettings(env: Env) {
  const settings = await getSettings(env);
  const time = getTimeContext(settings.timezone);
  return {
    name: settings.name,
    onboardingComplete: Boolean(settings.onboarding_complete),
    calorieTarget: settings.calorie_target,
    proteinTarget: settings.protein_target,
    carbsTarget: settings.carbs_target,
    fatTarget: settings.fat_target,
    fiberTarget: settings.fiber_target,
    weightKg: settings.weight_kg,
    heightCm: settings.height_cm,
    age: settings.age,
    sex: settings.sex,
    activity: settings.activity,
    goal: settings.goal,
    theme: settings.theme,
    plateDiameterCm: settings.plate_diameter_cm,
    openrouterConfigured: Boolean(await getOpenRouterApiKey(env)),
    openrouterKeySource: await getOpenRouterKeySource(env),
    openrouterModel: env.OPENROUTER_MODEL || settings.openrouter_model,
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

async function getMealRows(env: Env, date: string) {
  const settings = await getSettings(env);
  const range = dateRangeUtc(date, settings.timezone);
  const meals = await env.DB.prepare("SELECT * FROM meals WHERE logged_at >= ? AND logged_at < ? ORDER BY logged_at DESC")
    .bind(range.start, range.end).all<Record<string, unknown>>();
  const mealRows = meals.results ?? [];
  if (!mealRows.length) return [];

  const ids = mealRows.map((meal) => String(meal.id));
  const placeholders = ids.map(() => "?").join(",");
  const items = await env.DB.prepare(`SELECT * FROM meal_items WHERE meal_id IN (${placeholders}) ORDER BY rowid`)
    .bind(...ids).all<Record<string, unknown>>();

  const byMeal = new Map<string, Array<Record<string, unknown>>>();
  for (const item of items.results ?? []) {
    const list = byMeal.get(String(item.meal_id)) ?? [];
    list.push(item);
    byMeal.set(String(item.meal_id), list);
  }

  return mealRows.map((meal) => ({
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
    items: (byMeal.get(String(meal.id)) ?? []).map((item) => ({
      id: item.id,
      foodId: item.food_id,
      name: item.name,
      grams: item.grams,
      calories: item.calories,
      protein: item.protein,
      carbs: item.carbs,
      fiber: item.fiber,
      fat: item.fat
    }))
  }));
}

app.get("/api/health", (c) => c.json({ ok: true, storage: "d1", now: new Date().toISOString() }));
app.get("/api/settings", async (c) => c.json(await serializeSettings(c.env)));
app.get("/api/time", async (c) => c.json(getTimeContext((await getSettings(c.env)).timezone)));

app.patch("/api/settings", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if ("timezone" in body && !isValidTimeZone(String(body.timezone))) {
    return c.json({ error: "Enter a valid IANA timezone, such as America/Buenos_Aires" }, 400);
  }
  if ("plateDiameterCm" in body && (!Number.isFinite(Number(body.plateDiameterCm)) || Number(body.plateDiameterCm) < 15 || Number(body.plateDiameterCm) > 40)) {
    return c.json({ error: "Plate diameter must be between 15 and 40 cm" }, 400);
  }
  if ("openrouterApiKey" in body) {
    const key = String(body.openrouterApiKey || "").trim();
    if (!key.startsWith("sk-or-") || key.length < 30) return c.json({ error: "That does not look like a valid OpenRouter API key" }, 400);
    await setAppSecret(c.env, "openrouter_api_key", key);
  } else if (body.clearOpenrouterApiKey === true) {
    await deleteAppSecret(c.env, "openrouter_api_key");
  }

  const mapping: Record<string, string> = {
    name: "name", onboardingComplete: "onboarding_complete", calorieTarget: "calorie_target", proteinTarget: "protein_target",
    carbsTarget: "carbs_target", fatTarget: "fat_target", fiberTarget: "fiber_target", weightKg: "weight_kg", heightCm: "height_cm", age: "age",
    sex: "sex", activity: "activity", goal: "goal", theme: "theme", openrouterModel: "openrouter_model",
    telegramBotToken: "telegram_bot_token", telegramChatId: "telegram_chat_id", timezone: "timezone",
    plateDiameterCm: "plate_diameter_cm"
  };
  const updates: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [key, column] of Object.entries(mapping)) {
    if (!(key in body)) continue;
    updates.push(`${column} = ?`);
    values.push(key === "onboardingComplete" ? (body[key] ? 1 : 0) : body[key] as string | number | null);
  }
  if (Array.isArray(body.reminders)) {
    updates.push("reminders_json = ?");
    values.push(JSON.stringify(body.reminders));
  }
  if (updates.length) {
    updates.push("updated_at = CURRENT_TIMESTAMP");
    await c.env.DB.prepare(`UPDATE settings SET ${updates.join(", ")} WHERE id = 1`).bind(...values).run();
  }
  return c.json(await serializeSettings(c.env));
});

app.get("/api/foods", async (c) => {
  const query = (c.req.query("q") || "").trim();
  const rows = query
    ? await c.env.DB.prepare("SELECT * FROM foods WHERE name LIKE ? OR aliases LIKE ? OR category LIKE ? ORDER BY CASE WHEN name LIKE ? THEN 0 ELSE 1 END, name LIMIT 30")
      .bind(`%${query}%`, `%${query}%`, `%${query}%`, `${query}%`).all<Record<string, unknown>>()
    : await c.env.DB.prepare("SELECT * FROM foods ORDER BY category, name LIMIT 30").all<Record<string, unknown>>();
  return c.json((rows.results ?? []).map((row) => ({
    id: row.id, name: row.name, brand: row.brand, category: row.category, emoji: row.emoji,
    servingLabel: row.serving_label, servingGrams: row.serving_grams,
    calories: row.calories, protein: row.protein, carbs: row.carbs, fiber: row.fiber, fat: row.fat
  })));
});

app.get("/api/dashboard", async (c) => {
  const settings = await getSettings(c.env);
  const date = c.req.query("date") || getTimeContext(settings.timezone).today;
  const meals = await getMealRows(c.env, date);
  const totals = meals.flatMap((meal) => meal.items).reduce((acc, item) => ({
    calories: acc.calories + Number(item.calories), protein: acc.protein + Number(item.protein),
    carbs: acc.carbs + Number(item.carbs), fiber: acc.fiber + Number(item.fiber ?? 0), fat: acc.fat + Number(item.fat)
  }), { calories: 0, protein: 0, carbs: 0, fiber: 0, fat: 0 });
  return c.json({ date, settings: await serializeSettings(c.env), totals, meals });
});

app.post("/api/meals", async (c) => {
  const parsed = mealSchema.parse(await c.req.json());
  const id = crypto.randomUUID();
  const settings = await getSettings(c.env);
  const loggedAt = parsed.loggedAt || (parsed.loggedDate ? diaryTimestamp(parsed.loggedDate, settings.timezone) : new Date().toISOString());
  const imagePaths = parsed.imagePaths?.length ? parsed.imagePaths : parsed.imagePath ? [parsed.imagePath] : [];
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO meals (id, logged_at, meal_type, title, image_path, image_paths_json, notes, source, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, loggedAt, parsed.mealType, parsed.title, parsed.imagePath ?? imagePaths[0] ?? null, JSON.stringify(imagePaths), parsed.notes ?? "", parsed.source ?? "manual", parsed.confidence ?? null),
    ...parsed.items.map((item) =>
      c.env.DB.prepare("INSERT INTO meal_items (id, meal_id, food_id, name, grams, calories, protein, carbs, fiber, fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), id, item.foodId ?? null, item.name, item.grams, item.calories, item.protein, item.carbs, item.fiber ?? 0, item.fat)
    )
  ]);
  return c.json({ id }, 201);
});

app.delete("/api/meals/:id", async (c) => {
  const id = c.req.param("id");
  const meal = await c.env.DB.prepare("SELECT image_path, image_paths_json FROM meals WHERE id = ?").bind(id)
    .first<{ image_path?: string; image_paths_json?: string }>();
  await c.env.DB.prepare("DELETE FROM meal_items WHERE meal_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM meals WHERE id = ?").bind(id).run();

  let imagePaths: string[] = [];
  try { imagePaths = JSON.parse(meal?.image_paths_json || "[]") as string[]; } catch { /* Legacy row. */ }
  if (!imagePaths.length && meal?.image_path) imagePaths = [meal.image_path];
  for (const imagePath of new Set(imagePaths.filter((item) => item.startsWith("/uploads/")))) {
    await deletePhoto(c.env, photoKey(imagePath));
  }
  return c.body(null, 204);
});

app.post("/api/meals/:id/duplicate", async (c) => {
  const sourceId = c.req.param("id");
  const meal = await c.env.DB.prepare("SELECT * FROM meals WHERE id = ?").bind(sourceId).first<Record<string, unknown>>();
  if (!meal) return c.json({ error: "Meal not found" }, 404);
  const items = await c.env.DB.prepare("SELECT * FROM meal_items WHERE meal_id = ?").bind(sourceId).all<Record<string, unknown>>();
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO meals (id, logged_at, meal_type, title, image_path, image_paths_json, notes, source, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, new Date().toISOString(), String(meal.meal_type), String(meal.title), meal.image_path == null ? null : String(meal.image_path),
        String(meal.image_paths_json || "[]"), String(meal.notes ?? ""), "repeat", meal.confidence == null ? null : Number(meal.confidence)),
    ...(items.results ?? []).map((item) =>
      c.env.DB.prepare("INSERT INTO meal_items (id, meal_id, food_id, name, grams, calories, protein, carbs, fiber, fat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), id, item.food_id == null ? null : Number(item.food_id), String(item.name),
          Number(item.grams), Number(item.calories), Number(item.protein), Number(item.carbs), Number(item.fiber ?? 0), Number(item.fat))
    )
  ]);
  return c.json({ id }, 201);
});

app.post("/api/analyze", async (c) => {
  const form = await c.req.formData();
  const description = String(form.get("description") || "");
  const image = form.get("image");

  let imagePath: string | undefined;
  if (image && typeof image !== "string") {
    if (!image.type.startsWith("image/")) return c.json({ error: "Only image uploads are supported" }, 400);
    if (image.size > 15 * 1024 * 1024) return c.json({ error: "That photo is larger than 15 MB" }, 400);
    const extension = image.type === "image/png" ? "png" : "jpg";
    imagePath = `/uploads/${crypto.randomUUID()}.${extension}`;
    await putPhoto(c.env, photoKey(imagePath), await image.arrayBuffer(), image.type);
  }
  if (!imagePath && !description.trim()) return c.json({ error: "Add a photo or meal description" }, 400);

  const captureRaw = form.get("capture");
  const capture = captureRaw ? captureSchema.parse(JSON.parse(String(captureRaw))) as CaptureMetadata : undefined;
  const referenceRaw = form.get("scaleReference");
  const scaleReference = referenceRaw ? scaleReferenceSchema.parse(JSON.parse(String(referenceRaw))) as ScaleReference : undefined;
  const loggedDate = String(form.get("loggedDate") || "") || undefined;

  const result = await analyzeWithConfiguredProvider(c.env, description, imagePath, capture, scaleReference, loggedDate);
  if (!result.items.length) {
    return c.json({ error: "No foods could be identified. Add a short description or configure OpenRouter in Settings.", analysis: result }, 422);
  }
  return c.json(result);
});

app.post("/api/analyze/refine", async (c) => {
  const body = await c.req.json<{ analysis?: MealAnalysis; message?: string }>();
  if (!body.analysis || !String(body.message || "").trim()) return c.json({ error: "Add a correction" }, 400);
  return c.json(await refineAnalysis(c.env, body.analysis, String(body.message)));
});

app.get("/api/ai/status", async (c) => c.json(await getAiStatus(c.env)));

/**
 * Distinct foods you have logged before, most recent first, so a repeat can be
 * re-logged with one tap instead of retyping the macros. Everything counts —
 * photo analyses and searches as well as previous quick adds — because the
 * things worth repeating are rarely the ones that happened to be typed by hand.
 *
 * Derived from the meals themselves rather than a separate table, so deleting a
 * meal removes it from the list and the numbers shown are always the latest you
 * saved under that name. The bare columns alongside MAX(logged_at) are not
 * arbitrary: SQLite takes them from the row that produced the maximum.
 */
app.get("/api/quick-adds", async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT mi.name, mi.calories, mi.protein, mi.carbs, mi.fiber, mi.fat, mi.grams,
           COUNT(*) AS timesUsed, MAX(m.logged_at) AS lastLoggedAt
    FROM meals m JOIN meal_items mi ON mi.meal_id = m.id
    GROUP BY lower(mi.name)
    ORDER BY lastLoggedAt DESC
    LIMIT 20
  `).all<Record<string, unknown>>();
  return c.json(rows.results ?? []);
});

/**
 * The complete record of every food you have logged, searchable, ordered by how
 * often you have eaten it. Distinct from /api/quick-adds, which is a short
 * recency list: this is the full library you repeat from.
 */
app.get("/api/my-foods", async (c) => {
  const query = (c.req.query("q") || "").trim();
  const filter = query ? "WHERE lower(mi.name) LIKE ?" : "";
  const statement = c.env.DB.prepare(`
    SELECT mi.name, mi.calories, mi.protein, mi.carbs, mi.fiber, mi.fat, mi.grams,
           mi.food_id AS foodId, COUNT(*) AS timesUsed, MAX(m.logged_at) AS lastLoggedAt,
           MIN(m.logged_at) AS firstLoggedAt
    FROM meals m JOIN meal_items mi ON mi.meal_id = m.id
    ${filter}
    GROUP BY lower(mi.name)
    ORDER BY timesUsed DESC, lastLoggedAt DESC
    LIMIT 300
  `);
  const rows = await (query ? statement.bind(`%${query.toLowerCase()}%`) : statement).all<Record<string, unknown>>();
  return c.json(rows.results ?? []);
});


/* ---------------------------------------------------------- progress photos */

const POSES = ["front", "side", "back"] as const;

const serializeProgressPhoto = (row: Record<string, unknown>) => ({
  id: row.id,
  takenAt: row.taken_at,
  takenDate: row.taken_date,
  pose: row.pose,
  imagePath: row.image_path,
  weightKg: row.weight_kg,
  notes: row.notes
});

app.get("/api/progress", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, taken_at, taken_date, pose, image_path, weight_kg, notes FROM progress_photos ORDER BY taken_at DESC LIMIT 500"
  ).all<Record<string, unknown>>();
  return c.json((rows.results ?? []).map(serializeProgressPhoto));
});

app.post("/api/progress", async (c) => {
  const form = await c.req.formData();
  const image = form.get("image");
  if (!image || typeof image === "string") return c.json({ error: "Attach a photo" }, 400);
  if (!image.type.startsWith("image/")) return c.json({ error: "Only image uploads are supported" }, 400);
  if (image.size > 15 * 1024 * 1024) return c.json({ error: "That photo is larger than 15 MB" }, 400);

  const pose = String(form.get("pose") || "front");
  if (!POSES.includes(pose as typeof POSES[number])) return c.json({ error: "Pose must be front, side or back" }, 400);

  const rawWeight = String(form.get("weightKg") || "").trim();
  const weightKg = rawWeight ? Number(rawWeight) : null;
  if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 20 || weightKg > 400)) {
    return c.json({ error: "Enter a valid weight, or leave it blank" }, 400);
  }

  // Trust the client's clock only for the instant; the diary date that groups
  // photos together has to come from the configured timezone, like every other
  // date in the app.
  const takenAtRaw = String(form.get("takenAt") || "");
  const takenAt = Number.isFinite(Date.parse(takenAtRaw)) ? new Date(takenAtRaw).toISOString() : new Date().toISOString();
  const settings = await getSettings(c.env);
  const takenDate = dateInTimeZone(takenAt, settings.timezone);

  const id = crypto.randomUUID();
  const extension = image.type === "image/png" ? "png" : "jpg";
  const imagePath = `/progress-photos/${id}.${extension}`;
  await putPhoto(c.env, photoKey(imagePath), await image.arrayBuffer(), image.type);

  await c.env.DB.prepare(
    "INSERT INTO progress_photos (id, taken_at, taken_date, pose, image_path, weight_kg, notes) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, takenAt, takenDate, pose, imagePath, weightKg, String(form.get("notes") || "").slice(0, 500)).run();

  return c.json({ id, takenAt, takenDate, pose, imagePath, weightKg, notes: String(form.get("notes") || "") }, 201);
});

app.delete("/api/progress/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT image_path FROM progress_photos WHERE id = ?").bind(id).first<{ image_path: string }>();
  if (!row) return c.json({ error: "Photo not found" }, 404);
  await c.env.DB.prepare("DELETE FROM progress_photos WHERE id = ?").bind(id).run();
  await deletePhoto(c.env, photoKey(row.image_path));
  return c.body(null, 204);
});

app.get("/progress-photos/:key", async (c) => {
  const photo = await getPhoto(c.env, `progress-photos/${c.req.param("key")}`);
  if (!photo) return c.notFound();
  return c.body(photo.bytes, 200, {
    "content-type": photo.contentType,
    "cache-control": "private, max-age=31536000, immutable",
    "vary": "Cookie"
  });
});

app.get("/api/memories", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id, subject, note, times_used timesUsed, created_at createdAt, updated_at updatedAt FROM meal_memories ORDER BY updated_at DESC"
  ).all();
  return c.json(rows.results ?? []);
});

app.delete("/api/memories/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM meal_memories WHERE id = ?").bind(c.req.param("id")).run();
  return c.body(null, 204);
});

app.get("/api/history", async (c) => {
  const days = Math.min(365, Math.max(7, Number(c.req.query("days") || 30)));
  const settings = await getSettings(c.env);
  const context = getTimeContext(settings.timezone);
  const range = {
    start: dateRangeUtc(addCalendarDays(context.today, -(days - 1)), settings.timezone).start,
    end: dateRangeUtc(context.today, settings.timezone).end
  };
  const mealTotals = await c.env.DB.prepare(`
    SELECT m.id, m.logged_at loggedAt, ROUND(SUM(mi.calories),1) calories,
           ROUND(SUM(mi.protein),1) protein, ROUND(SUM(mi.carbs),1) carbs, ROUND(SUM(mi.fiber),1) fiber, ROUND(SUM(mi.fat),1) fat
    FROM meals m JOIN meal_items mi ON mi.meal_id = m.id
    WHERE m.logged_at >= ? AND m.logged_at < ?
    GROUP BY m.id ORDER BY m.logged_at
  `).bind(range.start, range.end).all<Record<string, unknown>>();

  const grouped = new Map<string, { date: string; calories: number; protein: number; carbs: number; fiber: number; fat: number; meals: number }>();
  for (const meal of mealTotals.results ?? []) {
    const date = dateInTimeZone(String(meal.loggedAt), settings.timezone);
    const day = grouped.get(date) ?? { date, calories: 0, protein: 0, carbs: 0, fiber: 0, fat: 0, meals: 0 };
    day.calories += Number(meal.calories); day.protein += Number(meal.protein);
    day.carbs += Number(meal.carbs); day.fiber += Number(meal.fiber ?? 0); day.fat += Number(meal.fat); day.meals += 1;
    grouped.set(date, day);
  }
  const nutrition = [...grouped.values()].map((day) => ({
    ...day,
    calories: Math.round(day.calories * 10) / 10, protein: Math.round(day.protein * 10) / 10,
    carbs: Math.round(day.carbs * 10) / 10, fiber: Math.round(day.fiber * 10) / 10, fat: Math.round(day.fat * 10) / 10
  }));
  const weights = await c.env.DB.prepare("SELECT id, recorded_at recordedAt, weight_kg weightKg FROM weight_entries ORDER BY recorded_at ASC LIMIT 365").all();
  return c.json({ nutrition, weights: weights.results ?? [] });
});

app.post("/api/weight", async (c) => {
  const body = await c.req.json<{ weightKg?: number; recordedAt?: string }>();
  const weightKg = Number(body.weightKg);
  if (!Number.isFinite(weightKg) || weightKg < 20 || weightKg > 400) return c.json({ error: "Enter a valid weight" }, 400);
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO weight_entries (id, recorded_at, weight_kg) VALUES (?, ?, ?)").bind(id, body.recordedAt || new Date().toISOString(), weightKg),
    c.env.DB.prepare("UPDATE settings SET weight_kg = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").bind(weightKg)
  ]);
  return c.json({ id }, 201);
});

app.post("/api/telegram/test", async (c) => {
  const { sendTelegramMessage } = await import("./telegram.js");
  await sendTelegramMessage(c.env, "✅ <b>Macroflow is connected.</b> Your Cloudflare Worker reminder service is working.");
  return c.json({ ok: true });
});

app.post("/api/telegram/webhook/register", async (c) => {
  const url = new URL(c.req.url);
  return c.json({ ok: true, result: await registerWebhook(c.env, c.env.APP_URL || `${url.protocol}//${url.host}`) });
});

app.post("/api/telegram/webhook", async (c) => {
  // This path cannot carry a session cookie, so the shared secret is the only
  // thing standing between the diary and the open internet. Fail closed when it
  // is unset: treating "no secret configured" as "no check needed" would let
  // anyone POST a crafted update to insert meals or claim the chat id.
  const expected = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return c.json({ error: "Telegram webhook is not configured" }, 503);
  if (c.req.header("x-telegram-bot-api-secret-token") !== expected) return c.json({ error: "Forbidden" }, 403);
  await handleTelegramUpdate(c.env, await c.req.json());
  return c.json({ ok: true });
});

app.get("/api/export", async (c) => {
  const [meals, mealItems, weights, memories] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM meals ORDER BY logged_at").all(),
    c.env.DB.prepare("SELECT * FROM meal_items ORDER BY rowid").all(),
    c.env.DB.prepare("SELECT * FROM weight_entries ORDER BY recorded_at").all(),
    c.env.DB.prepare("SELECT * FROM meal_memories ORDER BY updated_at").all()
  ]);
  return c.json({
    exportedAt: new Date().toISOString(),
    settings: await serializeSettings(c.env),
    meals: meals.results ?? [],
    mealItems: mealItems.results ?? [],
    weights: weights.results ?? [],
    mealMemories: memories.results ?? []
  }, 200, {
    "content-disposition": `attachment; filename=macroflow-export-${new Date().toISOString().slice(0, 10)}.json`
  });
});

app.get("/uploads/:key", async (c) => {
  const photo = await getPhoto(c.env, `uploads/${c.req.param("key")}`);
  if (!photo) return c.notFound();
  return c.body(photo.bytes, 200, {
    "content-type": photo.contentType,
    // private keeps meal photos out of shared caches, and Vary: Cookie means any
    // cache that does store one keys it on the session rather than serving it to
    // a signed-out visitor.
    "cache-control": "private, max-age=31536000, immutable",
    "vary": "Cookie"
  });
});

// Anything not handled above is the built SPA, served only once signed in.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((error, c) => {
  console.error(error);
  if (error instanceof z.ZodError) return c.json({ error: "Invalid data", details: error.issues }, 400);
  return c.json({ error: error instanceof Error ? error.message : "Unexpected server error" }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(checkReminders(env).catch((error) => console.error("Reminder check failed:", error)));
  }
} satisfies ExportedHandler<Env>;
