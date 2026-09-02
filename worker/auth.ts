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
  .mark { width:54px; height:54px; border-radius:18px; background:#ed7117; color:#f7f6f3;
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
    <div class="mark"><svg viewBox="0 0 318 916" height="26" width="9" fill="currentColor" aria-hidden="true"><path d="M 156 0C 162 1.5 163.5 5.9 166.6 10.9C 200.5 69.2 202.5 137.3 185.6 201.4C 167.4 266.1 167.4 266.1 160 281C 159 280.7 158 280.3 157 280C 155 274.9 153.2 269.8 151.4 264.6C 150.9 263 150.4 261.4 149.8 259.8C 123.7 181.3 105.8 98.9 143.6 20.7C 147.3 13.4 151.1 6.6 156 0Z M 72.3 142.7C 75.3 145.4 78.1 148.2 81 151C 82.2 152.1 83.4 153.2 84.6 154.3C 109.2 181.2 141 242.6 141 280C 135.9 278 133.7 276.2 129.9 272.4C 124.1 267 118.2 262 112 257C 109.8 255.1 107.5 253.1 105.3 251.2C 99.1 245.8 92.7 240.9 86.1 236.1C 80.5 231.9 75.1 227.4 69.6 223C 66.6 220.5 63.6 218.1 60.6 215.8C 55.6 211.7 50.8 207.4 46 203C 44.4 201.6 42.7 200.1 41 198.6C 23.2 182.1 2.1 156.1 0 131C 4 126 4 126 9.5 124.6C 31.9 122.9 54.7 128.2 72.3 142.7Z M 298 124.8C 300.1 124.8 302.2 124.8 304.4 124.8C 310 125 310 125 315 127C 318 131 318 131 317.6 135.2C 309.5 163.9 289.7 189.3 267 208C 266 208.8 265.1 209.7 264.1 210.5C 257.7 216 251.3 221.2 244.6 226.3C 230.2 237.3 216 248.5 202.2 260.3C 199.2 262.8 196.2 265.3 193.1 267.8C 188 272 188 272 184.1 276C 181 279 181 279 177 280C 179.2 270.8 181.9 261.9 185 253C 185.5 251.6 186 250.2 186.5 248.8C 219.3 154.8 219.3 154.8 259.9 133.7C 272.5 127.7 284.1 124.9 298 124.8Z M 148.9 305C 155 309 155 309 163 309C 166.2 306.9 169.4 304.8 172.5 302.5C 192.6 288.2 216.9 282.3 241.4 286.2C 265.2 290.8 284.1 301.7 299 321C 311.4 340.9 316.5 361.6 316 385C 315.7 386.3 315.3 387.6 315 389C 305.6 392.7 295.8 394.9 286 397.2C 284.4 397.6 282.7 398 281.1 398.4C 261.1 403 241.1 407 221 411C 219.5 411.3 217.9 411.6 216.4 411.9C 210.5 413.1 205 414 199 414C 199.3 414.7 199.7 415.3 200 416C 229.7 416.3 259.1 416.1 288.7 413.4C 296.2 412.7 303.6 412.3 311 412C 311.3 412.3 311.7 412.7 312 413C 311.3 425.1 309.2 436.9 307.1 448.8C 306.7 451.1 306.3 453.4 305.9 455.8C 301.8 479.6 297.2 503.2 292.3 526.8C 291.4 531.1 290.6 535.3 289.8 539.6C 289.5 541.7 289.1 543.8 288.7 545.9C 288.3 547.8 288 549.7 287.7 551.6C 286 556 286 556 282.1 558C 280.8 558.4 279.4 558.7 278 559C 277.2 559.2 277.2 559.2 273.2 560.4C 249.5 566.3 225.7 571 201.8 575.4C 201.1 575.6 201.1 575.6 197.5 576.2C 191.9 577.2 186.7 578 181 578C 181.3 578.7 181.7 579.3 182 580C 194.6 580.9 207.2 581.2 219.8 581.2C 221.7 581.2 223.6 581.2 225.6 581.2C 243.4 581.1 261.2 580.2 279 579C 280.5 585 278.6 589.8 277.1 595.8C 276.8 597.1 276.5 598.4 276.2 599.8C 275.1 604.1 274.1 608.4 273 612.7C 272.3 615.7 271.5 618.7 270.8 621.6C 264.4 647.6 257.8 673.6 250.8 699.4C 249.5 704.2 248.3 708.9 247.1 713.7C 246.4 716.2 245.8 718.7 245.1 721.3C 244.5 723.6 244 725.9 243.4 728.3C 240.6 734.9 238.6 736.5 232.1 739.2C 228.4 740.3 224.7 741.2 221 742C 216.7 743.4 212.4 744.8 208.1 746.2C 178.7 755 178.7 755 170 755C 170 755.7 170 756.3 170 757C 191.2 757.3 211.9 756.4 233 754C 234.4 759.7 232.6 763.3 230.8 768.9C 230.1 771.1 229.4 773.4 228.7 775.7C 227.9 778.1 227.2 780.5 226.4 782.9C 226 784.2 226 784.2 224 790.3C 190.4 895.3 190.4 895.3 168 914C 164 916 164 916 156 916C 120.4 897.7 106.7 819.8 95.1 783.9C 86.7 757.4 78.7 730.7 71 704C 70.4 702.1 69.9 700.2 69.3 698.2C 67.8 693.1 66.4 688 64.9 682.9C 64.5 681.5 64.1 680 63.7 678.5C 60.9 668.6 60.9 668.6 62 663C 63.4 663.1 64.8 663.3 66.2 663.4C 94.9 666 123.2 666.2 152 665C 152 664.3 152 663.7 152 663C 150.7 662.9 149.3 662.8 147.9 662.7C 140.8 661.9 133.9 660.4 126.9 658.9C 126.2 658.8 126.2 658.8 122.5 658C 59.2 644.2 59.2 644.2 53 638C 51.8 634 50.8 630 49.7 626C 49.1 623.5 48.4 620.9 47.7 618.3C 47 615.5 46.3 612.8 45.6 610C 44.9 607.2 44.2 604.4 43.5 601.5C 23.5 523.6 23.5 523.6 19 498C 20 497 20 497 26.4 496.9C 29.4 496.9 32.3 497 35.3 497C 38.5 497 41.7 497 45 497C 50.1 497 55.2 497.1 60.3 497.1C 79.3 497.2 98.1 497 117 495.4C 122.4 495 127.6 494.9 133 495C 133 494.3 133 493.7 133 493C 130.9 492.9 128.7 492.8 126.5 492.7C 115.2 492 104 490.2 92.8 488.5C 90.6 488.2 88.3 487.8 86 487.4C 31.5 478.8 31.5 478.8 14 473C 10.9 458.3 8.2 443.5 5.8 428.6C 5.6 427.1 5.3 425.5 5.1 423.9C -0.6 388 -3.1 352.7 18 321C 34.2 300.8 54.7 289.6 80.1 285.3C 105.5 283.3 128.5 290.1 148.9 305Z"/></svg></div>
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
