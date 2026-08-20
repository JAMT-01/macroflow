async function getSettings(env) {
  const row = await env.DB.prepare("SELECT * FROM settings WHERE id = 1").first();
  if (!row) throw new Error("Settings row is missing. Run the D1 migrations.");
  return row;
}
async function listFoods(env) {
  const result = await env.DB.prepare("SELECT * FROM foods ORDER BY name").all();
  return result.results ?? [];
}
async function getAppSecret(env, name) {
  const row = await env.DB.prepare("SELECT value FROM app_secrets WHERE name = ?").bind(name).first();
  return row?.value || "";
}
async function setAppSecret(env, name, value) {
  await env.DB.prepare(
    "INSERT INTO app_secrets (name, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
  ).bind(name, value).run();
}
async function deleteAppSecret(env, name) {
  await env.DB.prepare("DELETE FROM app_secrets WHERE name = ?").bind(name).run();
}
async function getOpenRouterApiKey(env) {
  return env.OPENROUTER_API_KEY || await getAppSecret(env, "openrouter_api_key");
}
async function getOpenRouterKeySource(env) {
  if (env.OPENROUTER_API_KEY) return "environment";
  if (await getAppSecret(env, "openrouter_api_key")) return "saved";
  return "none";
}
function photoKey(imagePath) {
  return imagePath.replace(/^\/+/, "");
}
async function putPhoto(env, key, bytes, contentType) {
  await env.PHOTOS.put(key, bytes, { metadata: { contentType } });
}
async function getPhoto(env, key) {
  const result = await env.PHOTOS.getWithMetadata(key, "arrayBuffer");
  if (!result.value) return null;
  return { bytes: result.value, contentType: result.metadata?.contentType || "image/jpeg" };
}
async function deletePhoto(env, key) {
  await env.PHOTOS.delete(key);
}
var init_db = __esm({
  "worker/db.ts"() {
    "use strict";
    __name(getSettings, "getSettings");
    __name(listFoods, "listFoods");
    __name(getAppSecret, "getAppSecret");
    __name(setAppSecret, "setAppSecret");
    __name(deleteAppSecret, "deleteAppSecret");
    __name(getOpenRouterApiKey, "getOpenRouterApiKey");
    __name(getOpenRouterKeySource, "getOpenRouterKeySource");
    __name(photoKey, "photoKey");
    __name(putPhoto, "putPhoto");
    __name(getPhoto, "getPhoto");
    __name(deletePhoto, "deletePhoto");
  }
});
