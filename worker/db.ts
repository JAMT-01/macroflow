import type { FoodRow } from "../shared/analysis-core.js";

export type Env = {
  DB: D1Database;
  PHOTOS: KVNamespace;
  ASSETS: Fetcher;
  APP_PASSWORD?: string;
  PHOTO_PASSPHRASE?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  APP_URL?: string;
};

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

export async function getSettings(env: Env): Promise<DbSettings> {
  const row = await env.DB.prepare("SELECT * FROM settings WHERE id = 1").first<DbSettings>();
  if (!row) throw new Error("Settings row is missing. Run the D1 migrations.");
  return row;
}

export async function listFoods(env: Env): Promise<FoodRow[]> {
  const result = await env.DB.prepare("SELECT * FROM foods ORDER BY name").all<FoodRow>();
  return result.results ?? [];
}

export async function getAppSecret(env: Env, name: string) {
  const row = await env.DB.prepare("SELECT value FROM app_secrets WHERE name = ?").bind(name).first<{ value: string }>();
  return row?.value || "";
}

export async function setAppSecret(env: Env, name: string, value: string) {
  await env.DB.prepare(
    "INSERT INTO app_secrets (name, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
  ).bind(name, value).run();
}

export async function deleteAppSecret(env: Env, name: string) {
  await env.DB.prepare("DELETE FROM app_secrets WHERE name = ?").bind(name).run();
}

/**
 * A Worker secret set with `wrangler secret put` always wins over a key typed
 * into Settings, matching how the local build preferred the environment.
 */
export async function getOpenRouterApiKey(env: Env) {
  return env.OPENROUTER_API_KEY || (await getAppSecret(env, "openrouter_api_key"));
}

export async function getOpenRouterKeySource(env: Env): Promise<"environment" | "saved" | "none"> {
  if (env.OPENROUTER_API_KEY) return "environment";
  if (await getAppSecret(env, "openrouter_api_key")) return "saved";
  return "none";
}

/** Meal photos live in KV under `uploads/<uuid>.jpg`, keyed the same way the URL path reads. */
export function photoKey(imagePath: string) {
  return imagePath.replace(/^\/+/, "");
}

export async function putPhoto(env: Env, key: string, bytes: ArrayBuffer, contentType: string) {
  await env.PHOTOS.put(key, bytes, { metadata: { contentType } });
}

export async function getPhoto(env: Env, key: string) {
  const result = await env.PHOTOS.getWithMetadata<{ contentType?: string }>(key, "arrayBuffer");
  if (!result.value) return null;
  return { bytes: result.value, contentType: result.metadata?.contentType || "image/jpeg" };
}

export async function deletePhoto(env: Env, key: string) {
  await env.PHOTOS.delete(key);
}
