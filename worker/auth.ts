import type { Env } from "./db.js";

/**
 * Single-user passphrase login.
 *
 * The passphrase lives only as a Worker secret (APP_PASSWORD). Sessions are
 * HMAC-signed cookies rather than rows in a table, so there is no session store
 * to keep, and rotating the passphrase invalidates every existing session
 * because the signing key is derived from it.
 */

const COOKIE = "mf_session";
const UNLOCK_COOKIE = "mf_photos";
const UNLOCK_MINUTES = 15;
/*
 * A photo passphrase is often a short PIN, whose keyspace is small enough that
 * per-IP limits alone mean nothing: an attacker with a few hundred proxies gets
 * hundreds of guesses a minute. GLOBAL_FAILURES caps attempts across every IP,
 * which is what actually bounds the search. The cost is that someone who can
 * reach the unlock endpoint can deliberately exhaust it and keep the owner out
 * for an hour, so it is set high enough that ordinary fumbling never trips it.
 */
const GLOBAL_FAILURES = 20;
const GLOBAL_WINDOW_MINUTES = 60;
const GLOBAL_KEY = "|photos-global";
const SESSION_DAYS = 30;
const MAX_FAILURES = 8;
const LOCKOUT_MINUTES = 15;

function bytesToBase64Url(bytes: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signingKey(password: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${password}::macroflow-session-v1`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function sign(password: string, payload: string) {
  const key = await signingKey(password);
  return bytesToBase64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

/** Compares two strings without leaking their contents through timing. */
function constantTimeEquals(a: string, b: string) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  // Length alone is not secret enough to branch on, so fold it into the result.
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

export async function createSessionCookie(password: string) {
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const signature = await sign(password, String(expiresAt));
  const value = `${expiresAt}.${signature}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function hasValidSession(request: Request, password: string) {
  const header = request.headers.get("cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return false;

  const [expiresAt, signature] = match[1].split(".");
  if (!expiresAt || !signature) return false;
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) return false;

  return constantTimeEquals(signature, await sign(password, expiresAt));
}

export function verifyPassword(candidate: string, password: string) {
  return constantTimeEquals(candidate, password);
}

/**
 * A second, short-lived unlock for the progress photos.
 *
 * Signed with a different context string from the session cookie, so a session
 * cookie can never be replayed as an unlock. Deliberately a *browser-session*
 * cookie with no Max-Age — closing the browser drops it — and the signed
 * payload expires 15 minutes after it was issued regardless.
 */
async function signUnlock(password: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${password}::macroflow-photos-v1`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return bytesToBase64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

export async function createUnlockCookie(password: string) {
  const expiresAt = Date.now() + UNLOCK_MINUTES * 60 * 1000;
  const value = `${expiresAt}.${await signUnlock(password, String(expiresAt))}`;
  return `${UNLOCK_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearUnlockCookie() {
  return `${UNLOCK_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function hasPhotoUnlock(request: Request, password: string) {
  const header = request.headers.get("cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${UNLOCK_COOKIE}=([^;]+)`));
  if (!match) return false;

  const [expiresAt, signature] = match[1].split(".");
  if (!expiresAt || !signature) return false;
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) return false;

  return constantTimeEquals(signature, await signUnlock(password, expiresAt));
}

export const unlockMinutes = UNLOCK_MINUTES;

/** The photo secret, falling back to the app passphrase when none is set. */
export function photoSecret(env: Env) {
  return env.PHOTO_PASSPHRASE || env.APP_PASSWORD || "";
}

export function hasSeparatePhotoSecret(env: Env) {
  return Boolean(env.PHOTO_PASSPHRASE);
}

export async function isGloballyLockedOut(env: Env) {
  const row = await env.DB.prepare("SELECT failures, window_started_at, locked_until FROM login_attempts WHERE ip = ?")
    .bind(GLOBAL_KEY).first<{ failures: number; window_started_at: string; locked_until: string | null }>();
  if (!row?.locked_until) return false;
  return new Date(row.locked_until).getTime() > Date.now();
}

export async function recordGlobalFailure(env: Env) {
  const now = Date.now();
  const windowStart = new Date(now - GLOBAL_WINDOW_MINUTES * 60 * 1000).toISOString();
  const row = await env.DB.prepare("SELECT failures, window_started_at FROM login_attempts WHERE ip = ?")
    .bind(GLOBAL_KEY).first<{ failures: number; window_started_at: string }>();

  const withinWindow = row && row.window_started_at > windowStart;
  const failures = withinWindow ? row.failures + 1 : 1;
  const lockedUntil = failures >= GLOBAL_FAILURES ? new Date(now + GLOBAL_WINDOW_MINUTES * 60 * 1000).toISOString() : null;

  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, failures, window_started_at, locked_until) VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at, locked_until = excluded.locked_until`
  ).bind(GLOBAL_KEY, failures, withinWindow ? row.window_started_at : new Date(now).toISOString(), lockedUntil).run();
}

export async function clearGlobalFailures(env: Env) {
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(GLOBAL_KEY).run();
}

/**
 * Brute-force protection, keyed by client IP in D1. KV would burn the free
 * plan's 1,000 daily writes under a sustained attack; D1 allows 100k.
 */
export async function isLockedOut(env: Env, ip: string) {
  const row = await env.DB.prepare("SELECT locked_until FROM login_attempts WHERE ip = ?").bind(ip).first<{ locked_until: string | null }>();
  if (!row?.locked_until) return false;
  return new Date(row.locked_until).getTime() > Date.now();
}

export async function recordFailure(env: Env, ip: string) {
  const now = Date.now();
  const windowStart = new Date(now - LOCKOUT_MINUTES * 60 * 1000).toISOString();
  const row = await env.DB.prepare("SELECT failures, window_started_at FROM login_attempts WHERE ip = ?").bind(ip)
    .first<{ failures: number; window_started_at: string }>();

  const withinWindow = row && row.window_started_at > windowStart;
  const failures = withinWindow ? row.failures + 1 : 1;
  const lockedUntil = failures >= MAX_FAILURES ? new Date(now + LOCKOUT_MINUTES * 60 * 1000).toISOString() : null;

  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, failures, window_started_at, locked_until) VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at, locked_until = excluded.locked_until`
  ).bind(ip, failures, withinWindow ? row.window_started_at : new Date(now).toISOString(), lockedUntil).run();

  return { failures, lockedUntil, remaining: Math.max(0, MAX_FAILURES - failures) };
}

export async function clearFailures(env: Env, ip: string) {
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
}

export function loginPage(options: { error?: string; configured: boolean } = { configured: true }) {
  const message = !options.configured
    ? `<p class="notice">No passphrase is set on this Worker yet. Run <code>npx wrangler secret put APP_PASSWORD</code> in the project folder. It takes effect immediately &mdash; no redeploy needed.</p>`
    : options.error
      ? `<p class="error">${options.error}</p>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
<meta name="theme-color" content="#172019" />
<meta name="robots" content="noindex, nofollow" />
<title>Macroflow</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html { touch-action:pan-x pan-y; -webkit-text-size-adjust:100%; text-size-adjust:100%; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
    background:#172019; color:#f3f5ef; font-family:"DM Sans","Segoe UI",system-ui,sans-serif; }
  form { width:min(360px,100%); display:grid; gap:14px; }
  .mark { width:52px; height:52px; border-radius:16px; background:#c9f36a; color:#172019;
    display:grid; place-items:center; font:800 24px/1 "Manrope",sans-serif; margin:0 auto 6px; }
  h1 { font:700 22px/1.2 "Manrope","Segoe UI",sans-serif; margin:0; text-align:center; }
  p.sub { margin:0 0 8px; text-align:center; color:#9ea89f; font-size:13px; }
  label { display:grid; gap:7px; font-size:12px; font-weight:600; color:#b9c1ba; }
  input { height:48px; border-radius:12px; border:1px solid #354137; background:#222c24;
    color:#fff; padding:0 14px; font-size:16px; outline:0; }
  input:focus { border-color:#c9f36a; }
  button { height:48px; border:0; border-radius:12px; background:#c9f36a; color:#172019;
    font:700 15px "Manrope",sans-serif; cursor:pointer; }
  button:active { transform:scale(.99); }
  .error, .notice { margin:0; font-size:13px; line-height:1.5; border-radius:10px; padding:10px 12px; }
  .error { background:#3a2321; color:#f6c7c0; }
  .notice { background:#2f2c1e; color:#f0e3ad; }
  code { background:rgba(255,255,255,.1); padding:2px 6px; border-radius:5px; font-size:12px; }
  .foot { text-align:center; color:#6f7a70; font-size:11px; margin:4px 0 0; }
</style>
</head>
<body>
  <form method="POST" action="/api/auth/login">
    <div class="mark">M</div>
    <h1>Macroflow</h1>
    <p class="sub">Enter your passphrase to open the diary.</p>
    ${message}
    <label>Passphrase
      <input type="password" name="password" autocomplete="current-password" autofocus required />
    </label>
    <button type="submit">Sign in</button>
    <p class="foot">Private food diary. Not a medical device.</p>
  </form>
</body>
</html>`;
}
