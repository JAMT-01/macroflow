var COOKIE = "mf_session";
var SESSION_DAYS = 30;
var MAX_FAILURES = 8;
var LOCKOUT_MINUTES = 15;
function bytesToBase64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(bytesToBase64Url, "bytesToBase64Url");
async function signingKey(password) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${password}::macroflow-session-v1`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}
__name(signingKey, "signingKey");
async function sign(password, payload) {
  const key = await signingKey(password);
  return bytesToBase64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}
__name(sign, "sign");
function constantTimeEquals(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}
__name(constantTimeEquals, "constantTimeEquals");
async function createSessionCookie(password) {
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1e3;
  const signature = await sign(password, String(expiresAt));
  const value = `${expiresAt}.${signature}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
}
__name(createSessionCookie, "createSessionCookie");
function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
__name(clearSessionCookie, "clearSessionCookie");
async function hasValidSession(request, password) {
  const header = request.headers.get("cookie") || "";
  const match2 = header.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match2) return false;
  const [expiresAt, signature] = match2[1].split(".");
  if (!expiresAt || !signature) return false;
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) return false;
  return constantTimeEquals(signature, await sign(password, expiresAt));
}
__name(hasValidSession, "hasValidSession");
function verifyPassword(candidate, password) {
  return constantTimeEquals(candidate, password);
}
__name(verifyPassword, "verifyPassword");
async function isLockedOut(env, ip) {
  const row = await env.DB.prepare("SELECT locked_until FROM login_attempts WHERE ip = ?").bind(ip).first();
  if (!row?.locked_until) return false;
  return new Date(row.locked_until).getTime() > Date.now();
}
__name(isLockedOut, "isLockedOut");
async function recordFailure(env, ip) {
  const now = Date.now();
  const windowStart = new Date(now - LOCKOUT_MINUTES * 60 * 1e3).toISOString();
  const row = await env.DB.prepare("SELECT failures, window_started_at FROM login_attempts WHERE ip = ?").bind(ip).first();
  const withinWindow = row && row.window_started_at > windowStart;
  const failures = withinWindow ? row.failures + 1 : 1;
  const lockedUntil = failures >= MAX_FAILURES ? new Date(now + LOCKOUT_MINUTES * 60 * 1e3).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, failures, window_started_at, locked_until) VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, window_started_at = excluded.window_started_at, locked_until = excluded.locked_until`
  ).bind(ip, failures, withinWindow ? row.window_started_at : new Date(now).toISOString(), lockedUntil).run();
  return { failures, lockedUntil, remaining: Math.max(0, MAX_FAILURES - failures) };
}
__name(recordFailure, "recordFailure");
async function clearFailures(env, ip) {
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
}
__name(clearFailures, "clearFailures");
function loginPage(options = { configured: true }) {
  const message = !options.configured ? `<p class="notice">No passphrase is set on this Worker yet. Run <code>npx wrangler secret put APP_PASSWORD</code> in the project folder. It takes effect immediately &mdash; no redeploy needed.</p>` : options.error ? `<p class="error">${options.error}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#172019" />
<meta name="robots" content="noindex, nofollow" />
<title>Macroflow</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
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
__name(loginPage, "loginPage");
