import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedFoods } from "../shared/seed.js";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(serverDir, "..");
export const dataDir = path.join(rootDir, "data");
export const uploadsDir = path.join(dataDir, "uploads");
export const benchmarkDir = path.join(dataDir, "benchmark");
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(benchmarkDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, "macroflow.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL DEFAULT 'You',
    onboarding_complete INTEGER NOT NULL DEFAULT 0,
    calorie_target REAL NOT NULL DEFAULT 2200,
    protein_target REAL NOT NULL DEFAULT 160,
    carbs_target REAL NOT NULL DEFAULT 230,
    fat_target REAL NOT NULL DEFAULT 70,
    fiber_target REAL NOT NULL DEFAULT 30,
    weight_kg REAL NOT NULL DEFAULT 75,
    height_cm REAL NOT NULL DEFAULT 175,
    age INTEGER NOT NULL DEFAULT 30,
    sex TEXT NOT NULL DEFAULT 'male',
    activity TEXT NOT NULL DEFAULT 'moderate',
    goal TEXT NOT NULL DEFAULT 'maintain',
    theme TEXT NOT NULL DEFAULT 'light',
    plate_diameter_cm REAL NOT NULL DEFAULT 25,
    openrouter_model TEXT NOT NULL DEFAULT 'google/gemini-3.6-flash',
    telegram_bot_token TEXT NOT NULL DEFAULT '',
    telegram_chat_id TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT 'America/Buenos_Aires',
    reminders_json TEXT NOT NULL DEFAULT '[{"id":"breakfast","label":"Breakfast","time":"09:00","enabled":false},{"id":"lunch","label":"Lunch","time":"13:00","enabled":true},{"id":"dinner","label":"Dinner","time":"21:00","enabled":true}]',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  INSERT OR IGNORE INTO settings (id) VALUES (1);

  CREATE TABLE IF NOT EXISTS app_secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    brand TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🍽️',
    serving_label TEXT NOT NULL,
    serving_grams REAL NOT NULL,
    calories REAL NOT NULL,
    protein REAL NOT NULL,
    carbs REAL NOT NULL,
    fiber REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meals (
    id TEXT PRIMARY KEY,
    logged_at TEXT NOT NULL,
    meal_type TEXT NOT NULL,
    title TEXT NOT NULL,
    image_path TEXT,
    image_paths_json TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    confidence REAL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meal_items (
    id TEXT PRIMARY KEY,
    meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
    food_id INTEGER REFERENCES foods(id),
    name TEXT NOT NULL,
    grams REAL NOT NULL,
    calories REAL NOT NULL,
    protein REAL NOT NULL,
    carbs REAL NOT NULL,
    fiber REAL NOT NULL DEFAULT 0,
    fat REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS weight_entries (
    id TEXT PRIMARY KEY,
    recorded_at TEXT NOT NULL,
    weight_kg REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sent_reminders (
    id TEXT PRIMARY KEY,
    reminder_key TEXT NOT NULL,
    sent_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meal_memories (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    note TEXT NOT NULL,
    times_used INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS benchmark_cases (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    image_path TEXT NOT NULL,
    depth_path TEXT,
    source TEXT NOT NULL,
    source_id TEXT,
    source_url TEXT,
    ingredients_json TEXT NOT NULL DEFAULT '[]',
    truth_mass REAL NOT NULL,
    truth_calories REAL NOT NULL,
    truth_protein REAL NOT NULL,
    truth_carbs REAL NOT NULL,
    truth_fat REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS benchmark_runs (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES benchmark_cases(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    strategy TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    predicted_mass REAL NOT NULL,
    predicted_calories REAL NOT NULL,
    predicted_protein REAL NOT NULL,
    predicted_carbs REAL NOT NULL,
    predicted_fat REAL NOT NULL,
    response_json TEXT NOT NULL,
    latency_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

function ensureColumn(table: string, column: string, declaration: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
}

ensureColumn("settings", "plate_diameter_cm", "REAL NOT NULL DEFAULT 25");
ensureColumn("settings", "fiber_target", "REAL NOT NULL DEFAULT 30");
ensureColumn("foods", "fiber", "REAL NOT NULL DEFAULT 0");
ensureColumn("meal_items", "fiber", "REAL NOT NULL DEFAULT 0");

// Databases seeded before fibre tracking have the column but no values, and the
// seed block below only runs on an empty table. Backfill from the seed list.
if (Number((db.prepare("SELECT COUNT(*) count FROM foods WHERE fiber = 0").get() as { count: number }).count) > 0) {
  const backfill = db.prepare("UPDATE foods SET fiber = ? WHERE name = ? AND fiber = 0");
  for (const food of seedFoods) backfill.run(food.fiber, food.name);
}
ensureColumn("meals", "image_paths_json", "TEXT NOT NULL DEFAULT '[]'");
db.prepare("UPDATE meals SET meal_type = 'Treat' WHERE meal_type = 'Snack'").run();

const benchmarkCount = Number((db.prepare("SELECT COUNT(*) count FROM benchmark_cases").get() as { count: number }).count);
if (benchmarkCount === 0) {
  const samples = [
    { id: "nutrition5k-1558459115", dish: "1558459115", name: "Fruit, rice & almonds", ingredients: ["almonds", "apple", "white rice", "cherry tomatoes", "grapes"], mass: 298, calories: 271.5, protein: 6.6, carbs: 43.5, fat: 10.5 },
    { id: "nutrition5k-1558546663", dish: "1558546663", name: "Apple, spinach & almonds", ingredients: ["spinach (raw)", "almonds", "apple"], mass: 197, calories: 330.7, protein: 10.6, carbs: 30.3, fat: 22.1 },
    { id: "nutrition5k-1557862783", dish: "1557862783", name: "Steak, chicken & cauliflower", ingredients: ["cauliflower", "steak", "chicken"], mass: 258, calories: 443, protein: 50.4, carbs: 3.9, fat: 24.9 }
  ];
  const insert = db.prepare(`INSERT INTO benchmark_cases
    (id, name, image_path, depth_path, source, source_id, source_url, ingredients_json, truth_mass, truth_calories, truth_protein, truth_carbs, truth_fat)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const sample of samples) {
    const rgb = path.join(benchmarkDir, "nutrition5k", `dish_${sample.dish}-rgb.png`);
    const depth = path.join(benchmarkDir, "nutrition5k", `dish_${sample.dish}-depth.png`);
    if (!fs.existsSync(rgb)) continue;
    insert.run(sample.id, sample.name, `/benchmark/nutrition5k/dish_${sample.dish}-rgb.png`, fs.existsSync(depth) ? `/benchmark/nutrition5k/dish_${sample.dish}-depth.png` : null, "Nutrition5k", `dish_${sample.dish}`, "https://github.com/google-research-datasets/Nutrition5k", JSON.stringify(sample.ingredients), sample.mass, sample.calories, sample.protein, sample.carbs, sample.fat);
  }
}

const foodCount = Number((db.prepare("SELECT COUNT(*) AS count FROM foods").get() as { count: number }).count);
if (foodCount === 0) {
  const insert = db.prepare(`
    INSERT INTO foods (name, brand, category, emoji, serving_label, serving_grams, calories, protein, carbs, fiber, fat, aliases)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const food of seedFoods) {
    insert.run(food.name, food.brand ?? "", food.category, food.emoji, food.servingLabel, food.servingGrams, food.calories, food.protein, food.carbs, food.fiber, food.fat, JSON.stringify(food.aliases));
  }
}

export type DbSettings = {
  id: number;
  name: string;
  onboarding_complete: number;
  calorie_target: number;
  protein_target: number;
  carbs_target: number;
  fat_target: number;
  fiber_target: number;
  weight_kg: number;
  height_cm: number;
  age: number;
  sex: string;
  activity: string;
  goal: string;
  theme: string;
  plate_diameter_cm: number;
  openrouter_model: string;
  telegram_bot_token: string;
  telegram_chat_id: string;
  timezone: string;
  reminders_json: string;
};

export function getSettings(): DbSettings {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get() as unknown as DbSettings;
}

export function getAppSecret(name: string) {
  const row = db.prepare("SELECT value FROM app_secrets WHERE name = ?").get(name) as { value: string } | undefined;
  return row?.value || "";
}

export function setAppSecret(name: string, value: string) {
  db.prepare(`
    INSERT INTO app_secrets (name, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
  `).run(name, value);
}

export function deleteAppSecret(name: string) {
  db.prepare("DELETE FROM app_secrets WHERE name = ?").run(name);
}

export function getOpenRouterApiKey() {
  return process.env.OPENROUTER_API_KEY || getAppSecret("openrouter_api_key");
}

export function getOpenRouterKeySource(): "environment" | "saved" | "none" {
  if (process.env.OPENROUTER_API_KEY) return "environment";
  if (getAppSecret("openrouter_api_key")) return "saved";
  return "none";
}
