-- Jamtytrack schema for Cloudflare D1.
-- Mirrors the local SQLite schema minus the benchmark tables, which stay local
-- to the research tooling and are never deployed.

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
  reminders_json TEXT NOT NULL DEFAULT '[{"id":"breakfast","label":"Breakfast","time":"09:00","enabled":false},{"id":"lunch","label":"Lunch","time":"13:00","enabled":true},{"id":"merienda","label":"Merienda","time":"17:30","enabled":false},{"id":"dinner","label":"Dinner","time":"21:00","enabled":true}]',
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

CREATE INDEX IF NOT EXISTS meals_logged_at ON meals (logged_at);

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

CREATE INDEX IF NOT EXISTS meal_items_meal_id ON meal_items (meal_id);

CREATE TABLE IF NOT EXISTS weight_entries (
  id TEXT PRIMARY KEY,
  recorded_at TEXT NOT NULL,
  weight_kg REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sent_reminders (
  id TEXT PRIMARY KEY,
  reminder_key TEXT NOT NULL UNIQUE,
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
