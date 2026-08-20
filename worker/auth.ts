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
const UNLOCK_MINUTES = 3;
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
 * payload expires UNLOCK_MINUTES after it was issued regardless.
 *
 * The expiry is baked into the cookie at issue time, so shortening the window
 * only affects unlocks granted after the change: there is no session store to
 * revoke through. Rotating PHOTO_PASSPHRASE is the only way to kill live ones.
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
  return { cookie: `${UNLOCK_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax`, expiresAt };
}

export function clearUnlockCookie() {
  return `${UNLOCK_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * The instant the current unlock lapses, or null when there is not a valid one.
 *
 * The client needs the real expiry rather than just "unlocked": a tab opened
 * partway through a window has to close the photos when *that* window ends, not
 * UNLOCK_MINUTES after the page happened to load.
 */
export async function photoUnlockExpiry(request: Request, password: string) {
  const header = request.headers.get("cookie") || "";
  const match = header.match(new RegExp(`(?:^|;\\s*)${UNLOCK_COOKIE}=([^;]+)`));
  if (!match) return null;

  const [expiresAt, signature] = match[1].split(".");
  if (!expiresAt || !signature) return null;
  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;

  return constantTimeEquals(signature, await signUnlock(password, expiresAt)) ? expiry : null;
}

export async function hasPhotoUnlock(request: Request, password: string) {
  return (await photoUnlockExpiry(request, password)) !== null;
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
<meta name="theme-color" content="#14120f" />
<meta name="robots" content="noindex, nofollow" />
<link rel="icon" href="/favicon-32.png" sizes="32x32" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="Jamtytrack" />
<title>Jamtytrack</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&family=DM+Mono:wght@500&display=swap" rel="stylesheet" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html { touch-action:pan-x pan-y; -webkit-text-size-adjust:100%; text-size-adjust:100%; }
  /* The gate is the one dark screen in a light app: warm ink, lit from the top,
     so the carrot mark and the button are the only colour on it. */
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:32px 24px;
    background:radial-gradient(120% 70% at 50% 0%, #1f1c17 0%, #14120f 60%) #14120f; color:#fff;
    font-family:"DM Sans","Segoe UI",system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  form { width:min(360px,100%); display:grid; gap:14px; }
  .mark { width:54px; height:54px; border-radius:18px; background:#ed7117; color:#fff;
    display:grid; place-items:center; font:700 24px/1 "DM Sans",sans-serif; margin:0 0 20px; }
  h1 { font:700 32px/1.05 "DM Sans","Segoe UI",sans-serif; letter-spacing:-.04em; margin:0; }
  p.sub { margin:10px 0 10px; color:rgba(255,255,255,.55); font-size:14.5px; line-height:1.55; }
  label { display:grid; gap:9px; font:500 10px/1 "DM Mono",ui-monospace,monospace;
    letter-spacing:.14em; text-transform:uppercase; color:rgba(255,255,255,.4); }
  input { height:54px; border-radius:16px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.05);
    color:#fff; padding:0 16px; font:400 16px "DM Sans",sans-serif; letter-spacing:normal; text-transform:none; outline:0; }
  input:focus { border-color:#ed7117; background:rgba(255,255,255,.07); }
  button { height:58px; border:0; border-radius:999px; background:#ed7117; color:#fff;
    font:700 16.5px "DM Sans",sans-serif; cursor:pointer; box-shadow:0 10px 26px rgba(237,113,23,.28); margin-top:4px; }
  button:active { transform:scale(.99); }
  .error, .notice { margin:0; font-size:12.5px; line-height:1.5; border-radius:16px; padding:13px 15px; }
  .error { background:rgba(237,113,23,.14); color:#f2c9a6; }
  .notice { background:rgba(201,162,39,.14); color:#e8d5a0; }
  code { background:rgba(255,255,255,.1); padding:2px 6px; border-radius:6px;
    font:500 12px "DM Mono",ui-monospace,monospace; }
  .foot { text-align:center; color:rgba(255,255,255,.32); font-size:11px; margin:6px 0 0; }
</style>
</head>
<body>
  <form method="POST" action="/api/auth/login">
    <div class="mark">J</div>
    <h1>Jamtytrack</h1>
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
