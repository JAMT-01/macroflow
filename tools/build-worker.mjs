/**
 * Build a deployable Worker bundle: the exact production bundle recovered from
 * Cloudflare, plus the progress-photo and habit modules and routes wired in,
 * plus the security patches documented inline below.
 *
 * Deliberately additive. The base is byte-for-byte what is running now, so the
 * diff is only what this script inserts — far lower risk than rewriting a
 * source tree from the decompiled output.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/+/, '');
const OUT_DIR = process.argv[2];

// 1. Compile the TS modules to plain JS.
const MODULES = [
  'worker/progress.ts',
  'worker/progress-assets.ts',
  'worker/habits.ts',
  'worker/habits-assets.ts',
  'worker/habit-reminders.ts',
  'worker/photo-lock.ts',
];



/*
 * Guard the client-source template literals.
 *
 * Each *-assets.ts exports its browser code as one big template literal. A
 * backtick inside it -- easiest to write by accident in a prose comment quoting
 * a CSS property or a variable name -- closes the literal early. esbuild then
 * reports something like: Expected ";" but found "bottom", pointing at the
 * COMMENT, which reads as nonsense and has cost three separate debugging
 * detours. Fail here instead, naming the offending lines and the fix.
 */
function assertNoStrayBackticks(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const open = lines.findIndex((line) => /_CLIENT_SOURCE\s*=.*`\s*$/.test(line));
  if (open === -1) return;
  const close = lines.findIndex((line, i) => i > open && /^`;\s*$/.test(line));
  if (close === -1) throw new Error(file + ': client-source literal is never closed');

  const bad = [];
  for (let i = open + 1; i < close; i++) {
    if (lines[i].includes('`')) bad.push('  line ' + (i + 1) + ': ' + lines[i].trim().slice(0, 90));
  }
  if (bad.length) {
    throw new Error(
      file + ': ' + bad.length + ' stray backtick(s) inside the client-source template literal.\n' +
      bad.join('\n') +
      '\nThey close the literal early. Use plain text or single quotes in that block.'
    );
  }
}

for (const file of MODULES) assertNoStrayBackticks(ROOT + '/' + file);

execSync(
  `npx --yes esbuild@0.25.0 ${MODULES.map((file) => `"${ROOT}/${file}"`).join(' ')} ` +
    `--outdir="${OUT_DIR}/mods" --format=esm --platform=neutral --log-level=warning`,
  { stdio: 'inherit' }
);

/** Strip module syntax — the bundle is one flat scope and the deps are already in it. */
function flatten(file) {
  return readFileSync(file, 'utf8')
    // `import { a, b } from "./x";`
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?[ \t]*\r?$/gm, '')
    // `export const foo = …` -> `const foo = …`
    .replace(/^export\s+(?=(const|function|async function|class|var|let))/gm, '')
    // esbuild's trailing `export {\n  a,\n  b\n};` block
    .replace(/^export\s*\{[\s\S]*?\};?[ \t]*\r?$/gm, '')
    .trim();
}

const progress = flatten(`${OUT_DIR}/mods/progress.js`);
const progressAssets = flatten(`${OUT_DIR}/mods/progress-assets.js`);
const habits = flatten(`${OUT_DIR}/mods/habits.js`);
const habitsAssets = flatten(`${OUT_DIR}/mods/habits-assets.js`);
const habitReminders = flatten(`${OUT_DIR}/mods/habit-reminders.js`);
const photoLock = flatten(`${OUT_DIR}/mods/photo-lock.js`);

// Nothing should survive that would break a flat scope.
for (const [name, code] of [
  ['progress', progress],
  ['progress-assets', progressAssets],
  ['habits', habits],
  ['habits-assets', habitsAssets],
  ['habit-reminders', habitReminders],
  ['photo-lock', photoLock],
]) {
  if (/^\s*(import|export)\s/m.test(code)) throw new Error(`${name}: leftover module syntax`);
}

/*
 * Progress photos, rebuilt ${new Date().toISOString().slice(0, 10)} to match the DEPLOYED FRONTEND'S contract.
 *
 * The frontend is the `source` fork's React app, whose Photos tab is an
 * end-to-end encrypted gallery behind a passphrase lock. Master's Worker never
 * had those routes, so that tab has been dead since master's bundle was
 * deployed over source's on 2026-08-21 (keep_assets preserved source's assets
 * but replaced its Worker). These routes are ported from source/worker/index.ts
 * and must keep its exact shapes — the client cannot be changed from here:
 *
 *   * GET /api/progress returns a bare ARRAY, not { photos: [...] }
 *   * every photo route is behind requirePhotoUnlock, including the bytes
 *   * DELETE answers 204 with no body
 *   * rows carry `encrypted`, and an encrypted upload skips the image-type check
 *
 * KV keys come from photoKey(image_path), which yields `progress-photos/<id>`
 * — where the bytes actually are. Master's own helper used `progress/`, matched
 * nothing, and 404ed every thumbnail.
 */
const ROUTES = `
// ---- progress photos, source-compatible (rebuilt ${new Date().toISOString().slice(0, 10)}) ----
app.get("/progress-client.js", () => progressClientResponse());

app.get("/api/progress/state", async (c) => {
  const secret = photoSecret(c.env);
  const expiresAt = secret ? await photoUnlockExpiry(c.req.raw, secret) : null;
  const record = await getPhotoCrypto(c.env);
  return c.json({
    unlocked: expiresAt !== null,
    unlockMinutes: PHOTO_UNLOCK_MINUTES,
    expiresAt,
    separateSecret: hasSeparatePhotoSecret(c.env),
    encryption: record ? { configured: true, salt: record.salt } : { configured: false, salt: null }
  });
});

// One-shot. A second call would let anyone holding a session replace the
// verifiers and wrapped keys — which reveals nothing, but orphans every
// existing photo permanently.
app.post("/api/progress/setup", async (c) => {
  if (await getPhotoCrypto(c.env)) return c.json({ error: "Photo encryption is already set up" }, 409);
  const body = await c.req.json().catch(() => ({}));
  const fields = ["salt", "authVerifier", "recoveryVerifier", "wrappedPassphrase", "wrappedRecovery"];
  const values = {};
  for (const field of fields) {
    const value = typeof body[field] === "string" ? body[field] : "";
    if (!value || value.length > 512) return c.json({ error: "Missing or invalid " + field }, 400);
    values[field] = value;
  }
  await c.env.DB.prepare(
    "INSERT INTO photo_crypto (id, version, salt, auth_verifier, recovery_verifier, wrapped_passphrase, wrapped_recovery) VALUES (1, 1, ?, ?, ?, ?, ?)"
  ).bind(values.salt, values.authVerifier, values.recoveryVerifier, values.wrappedPassphrase, values.wrappedRecovery).run();
  return c.json({ configured: true }, 201);
});

app.post("/api/progress/unlock", async (c) => {
  const secret = photoSecret(c.env);
  if (!secret) return c.json({ error: "No passphrase is configured" }, 503);
  // Per-IP under its own key, so failed unlocks cannot lock you out of the app
  // itself; plus a global cap, which is what actually bounds a short PIN.
  const ip = clientIp(c) + "|photos";
  if (await isLockedOut(c.env, ip)) return c.json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
  if (await isGloballyLockedOut(c.env)) return c.json({ error: "Too many failed attempts across the internet. Photos are sealed for an hour." }, 429);

  const body = await c.req.json().catch(() => ({}));
  const attempt = await verifyUnlock(c.env, body);
  if (!attempt.ok) {
    const failure = await recordFailure(c.env, ip);
    await recordGlobalFailure(c.env);
    return c.json({
      error: failure.remaining > 0
        ? "That passphrase is not right. " + failure.remaining + " attempt" + (failure.remaining === 1 ? "" : "s") + " left."
        : "Too many attempts. Try again in 15 minutes."
    }, 403);
  }
  await clearFailures(c.env, ip);
  await clearGlobalFailures(c.env);
  const unlock = await createUnlockCookie(secret);
  c.header("set-cookie", unlock.cookie);
  return c.json({ unlocked: true, unlockMinutes: PHOTO_UNLOCK_MINUTES, expiresAt: unlock.expiresAt, wrappedKey: attempt.wrappedKey });
});

app.post("/api/progress/lock", (c) => {
  c.header("set-cookie", clearUnlockCookie());
  return c.json({ unlocked: false });
});

app.get("/api/progress", async (c) => {
  if (!await requirePhotoUnlock(c.env, c.req.raw)) return c.json(PHOTO_LOCKED_RESPONSE, 403);
  const rows = await c.env.DB.prepare(
    "SELECT id, taken_at, taken_date, pose, image_path, weight_kg, notes, encrypted FROM progress_photos ORDER BY taken_at DESC LIMIT 500"
  ).all();
  return c.json((rows.results ?? []).map((row) => ({
    id: row.id,
    takenAt: row.taken_at,
    takenDate: row.taken_date,
    pose: row.pose,
    encrypted: Number(row.encrypted) === 1,
    imagePath: row.image_path,
    weightKg: row.weight_kg,
    notes: row.notes
  })));
});

app.post("/api/progress", async (c) => {
  if (!await requirePhotoUnlock(c.env, c.req.raw)) return c.json(PHOTO_LOCKED_RESPONSE, 403);
  const form = await c.req.formData();
  const image = form.get("image");
  if (!image || typeof image === "string") return c.json({ error: "Attach a photo" }, 400);

  // An encrypted photo arrives as opaque bytes, so the image-type allowlist
  // only applies to the plaintext path. An allowlist rather than an "image/"
  // prefix test: the prefix admitted image/svg+xml, which the Worker would then
  // serve from its own origin, and an SVG can carry script.
  const encrypted = String(form.get("encrypted") || "") === "1";
  const allowed = ["image/jpeg", "image/png", "image/webp"];
  if (!encrypted && allowed.indexOf(image.type) === -1) {
    return c.json({ error: "Only JPEG, PNG or WebP uploads are supported" }, 400);
  }
  if (image.size > 15 * 1024 * 1024) return c.json({ error: "That photo is larger than 15 MB" }, 400);

  const pose = String(form.get("pose") || "front");
  if (!isPose(pose)) return c.json({ error: "Pose must be front, side or back" }, 400);

  const rawWeight = String(form.get("weightKg") || "").trim();
  const weightKg = rawWeight ? Number(rawWeight) : null;
  if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 20 || weightKg > 400)) {
    return c.json({ error: "Enter a valid weight, or leave it blank" }, 400);
  }

  // The client's clock is trusted for the instant only; the diary date that
  // groups photos has to come from the configured timezone, like every other
  // date in the app.
  const takenAtRaw = String(form.get("takenAt") || "");
  const takenAt = Number.isFinite(Date.parse(takenAtRaw)) ? new Date(takenAtRaw).toISOString() : new Date().toISOString();
  const settings = await getSettings(c.env);
  const takenDate = dateInTimeZone(takenAt, settings.timezone);

  const id = crypto.randomUUID();
  const extension = encrypted ? "enc" : image.type === "image/png" ? "png" : "jpg";
  const imagePath = "/progress-photos/" + id + "." + extension;
  const storedType = encrypted ? "application/octet-stream" : image.type;
  const notes = String(form.get("notes") || "").slice(0, 500);

  await putPhoto(c.env, photoKey(imagePath), await image.arrayBuffer(), storedType);
  await c.env.DB.prepare(
    "INSERT INTO progress_photos (id, taken_at, taken_date, pose, image_path, weight_kg, notes, encrypted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, takenAt, takenDate, pose, imagePath, weightKg, notes, encrypted ? 1 : 0).run();

  return c.json({ id, takenAt, takenDate, pose, imagePath, weightKg, encrypted, notes }, 201);
});

app.delete("/api/progress/:id", async (c) => {
  if (!await requirePhotoUnlock(c.env, c.req.raw)) return c.json(PHOTO_LOCKED_RESPONSE, 403);
  const row = await c.env.DB.prepare("SELECT image_path FROM progress_photos WHERE id = ?").bind(c.req.param("id")).first();
  if (!row) return c.json({ error: "Photo not found" }, 404);
  await c.env.DB.prepare("DELETE FROM progress_photos WHERE id = ?").bind(c.req.param("id")).run();
  await deletePhoto(c.env, photoKey(row.image_path));
  return c.body(null, 204);
});

app.get("/progress-photos/:key", async (c) => {
  if (!await requirePhotoUnlock(c.env, c.req.raw)) return c.json(PHOTO_LOCKED_RESPONSE, 403);
  const photo = await getPhoto(c.env, "progress-photos/" + c.req.param("key"));
  if (!photo) return c.notFound();
  return c.body(photo.bytes, 200, {
    "content-type": photo.contentType,
    // no-store, unlike the year-long cache on meal photos: a short unlock window
    // is pointless if the bytes then sit in the browser's disk cache, where
    // locking would clear the screen but leave the photos on the device.
    "cache-control": "private, no-store, max-age=0, must-revalidate",
    "vary": "Cookie"
  });
});
`;

const HABIT_ROUTES = `
// ---- habits (added ${new Date().toISOString().slice(0, 10)}) ----
app.get("/habits-client.js", () => habitsClientResponse());
app.get("/api/habits", async (c) => {
  const settings = await getSettings(c.env);
  return c.json({
    habits: await listHabits(c.env, c.req.query("archived") === "1"),
    today: dateInTimeZone(new Date(), String(settings.timezone))
  });
});
app.post("/api/habits", async (c) => {
  const body = await c.req.json();
  const habit = await createHabit(c.env, {
    name: String(body.name || ""),
    emoji: body.emoji ? String(body.emoji) : void 0,
    targetValue: body.targetValue == null ? null : Number(body.targetValue),
    unit: body.unit ? String(body.unit) : "",
    startedOn: body.startedOn ? String(body.startedOn) : void 0,
    reminderTime: body.reminderTime ? String(body.reminderTime) : null
  });
  return c.json(habit, 201);
});
// Fields are copied across one by one rather than passing the body through, so
// a client cannot reach a column the UI does not expose (started_on, sort_order).
app.patch("/api/habits/:id", async (c) => {
  const body = await c.req.json();
  const patch2 = {};
  if ("name" in body) patch2.name = String(body.name);
  if ("emoji" in body) patch2.emoji = String(body.emoji);
  if ("targetValue" in body) patch2.targetValue = body.targetValue == null ? null : Number(body.targetValue);
  if ("unit" in body) patch2.unit = String(body.unit);
  if ("reminderTime" in body) patch2.reminderTime = body.reminderTime == null ? null : String(body.reminderTime);
  if ("reminderEnabled" in body) patch2.reminderEnabled = Boolean(body.reminderEnabled);
  if ("archived" in body) patch2.archived = Boolean(body.archived);
  const updated = await updateHabit(c.env, c.req.param("id"), patch2);
  return updated ? c.json({ ok: true }) : c.notFound();
});
app.delete("/api/habits/:id", async (c) => {
  const deleted = await deleteHabit(c.env, c.req.param("id"));
  return deleted ? c.json({ ok: true }) : c.notFound();
});
app.post("/api/habits/:id/check", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const result = await checkIn(c.env, c.req.param("id"), {
    date: body.date ? String(body.date) : void 0,
    value: body.value == null ? null : Number(body.value),
    note: body.note ? String(body.note) : "",
    source: "app"
  });
  return result ? c.json(result.habit) : c.notFound();
});
app.delete("/api/habits/:id/check", async (c) => {
  const removed = await undoCheckIn(c.env, c.req.param("id"), c.req.query("date") || void 0);
  return c.json({ ok: removed });
});
`;

const ANCHOR = 'app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));';
const REPLACEMENT = `${photoLock}

${progress}

${progressAssets}

${habits}

${habitsAssets}

${habitReminders}
${ROUTES}${HABIT_ROUTES}
app.all("*", async (c) => injectHabitsClient(injectProgressClient(await c.env.ASSETS.fetch(c.req.raw))));`;

// ---- security fixes (added 2026-08-21) ----
//
// Written as patches for the same reason as everything else: BUNDLE-FULL.js
// stays the pristine production base and the diff stays reviewable.
//
// 1. Telegram sender authorization. handleTelegramUpdate trusted whatever
//    chat an update arrived from, so anyone who found the bot's username
//    could read /today totals or inject meals with /log. The first message
//    still claims pairing — that is the documented setup flow ("send /start
//    to your bot") — but every later update from a different chat is dropped.
const TELEGRAM_ANCHOR = `  if (!settings.telegram_chat_id) {
    await env.DB.prepare("UPDATE settings SET telegram_chat_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").bind(chatId).run();
  }
  const text = message.text.trim();`;
const TELEGRAM_REPLACEMENT = `  if (!settings.telegram_chat_id) {
    await env.DB.prepare("UPDATE settings SET telegram_chat_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1").bind(chatId).run();
  } else if (String(settings.telegram_chat_id) !== chatId) {
    console.warn("telegram: ignored update from unpaired chat", chatId);
    return;
  }
  const text = message.text.trim();`;

// 2. Generic 500s. app.onError echoed error.message to the client, which can
//    surface SQL errors and upstream fetch URLs. Zod issues stay — they carry
//    validation constraints, not internals.
const ONERROR_ANCHOR = `  if (error51 instanceof external_exports.ZodError) return c.json({ error: "Invalid data", details: error51.issues }, 400);
  return c.json({ error: error51 instanceof Error ? error51.message : "Unexpected server error" }, 500);`;
const ONERROR_REPLACEMENT = `  if (error51 instanceof external_exports.ZodError) return c.json({ error: "Invalid data", details: error51.issues }, 400);
  return c.json({ error: "Something went wrong. The error was logged." }, 500);`;

// ---- habit wiring (added 2026-08-27) ----
//
// 3. The cron. The every-minute trigger already exists (macroflow-kb.md §2) and
//    already calls checkReminders; habits ride the same tick. The two run
//    concurrently and are wrapped separately, so a habit reminder that throws
//    cannot take the meal reminders down with it — and vice versa.
//
//    String.raw throughout this section: these anchors carry literal `\u{...}`,
//    `\n` and `\/` sequences from the bundle, and a normal template literal
//    would interpret them and never match.
const SCHEDULED_ANCHOR = String.raw`  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkReminders(env).catch((error51) => console.error("Reminder check failed:", error51)));
  }`;
const SCHEDULED_REPLACEMENT = String.raw`  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkReminders(env).catch((error51) => console.error("Reminder check failed:", error51)));
    ctx.waitUntil(checkHabitReminders(env).catch((error51) => console.error("Habit reminder check failed:", error51)));
  }`;

// 4. Bot commands. /habits, /done and /undo are tried BEFORE the existing
//    dispatch and fall through untouched when the message is not one of them,
//    so /today, /log and /help behave exactly as they do now. Putting the
//    check-in on the same channel as the reminder is the point of the feature:
//    the nudge arrives and is answerable in place, without opening the app.
const COMMANDS_ANCHOR = String.raw`  const text = message.text.trim();
  if (/^\/start/i.test(text)) {
    await sendTelegramMessage(env, "\u{1F44B} <b>Macroflow is connected.</b>\n\nUse /today for your totals or /log followed by a meal description.", chatId);`;
const COMMANDS_REPLACEMENT = String.raw`  const text = message.text.trim();
  const habitReply = await handleHabitCommand(env, text);
  if (habitReply) {
    await sendTelegramMessage(env, habitReply, chatId);
    return;
  }
  if (/^\/start/i.test(text)) {
    await sendTelegramMessage(env, "\u{1F44B} <b>Macroflow is connected.</b>\n\nUse /today for your totals, /log to log a meal, or /habits for your streaks.", chatId);`;

// 5. /help lists the new commands. HABIT_HELP is defined in
//    worker/habit-reminders.ts so the list has one source rather than two that
//    drift.
const HELP_ANCHOR = String.raw`    await sendTelegramMessage(env, "<b>Commands</b>\n/today \u2014 daily totals\n/log 200g chicken, 150g rice \u2014 log a meal\n/help \u2014 show this message", chatId);`;
const HELP_REPLACEMENT = String.raw`    await sendTelegramMessage(env, "<b>Commands</b>\n/today \u2014 daily totals\n/log 200g chicken, 150g rice \u2014 log a meal\n" + HABIT_HELP + "\n/help \u2014 show this message", chatId);`;

/** Exact-match patch. BUNDLE-FULL.js has CRLF line endings, so anchors
 *  written with plain newlines are normalized before matching. Must hit
 *  exactly once or the build aborts — a drifted anchor fails loudly rather
 *  than silently skipping a security fix. */
function patch(bundle, anchor, replacement, label) {
  const normalized = anchor.replace(/\n/g, '\r\n');
  const hits = bundle.split(normalized).length - 1;
  if (hits !== 1) throw new Error(`${label}: anchor matched ${hits} times, expected exactly 1`);
  // Function replacement, not a string: a literal `$&` or `$'` anywhere in an
  // injected client script would otherwise be read as a replacement pattern and
  // silently splice the anchor back in.
  return bundle.replace(normalized, () => replacement);
}

const bundle = readFileSync(`${ROOT}/recovered/BUNDLE-FULL.js`, 'utf8');

/** Applied in order; each anchor must match exactly once. */
const PATCHES = [
  [ANCHOR, REPLACEMENT, 'progress + habit routes'],
  [TELEGRAM_ANCHOR, TELEGRAM_REPLACEMENT, 'telegram sender check'],
  [ONERROR_ANCHOR, ONERROR_REPLACEMENT, 'generic 500s'],
  [SCHEDULED_ANCHOR, SCHEDULED_REPLACEMENT, 'habit reminders on the cron'],
  [COMMANDS_ANCHOR, COMMANDS_REPLACEMENT, 'habit bot commands'],
  [HELP_ANCHOR, HELP_REPLACEMENT, 'habit commands in /help'],
];

const out = PATCHES.reduce(
  (current, [anchor, replacement, label]) => patch(current, anchor, replacement, label),
  bundle
);

/*
 * Parse the result before writing it.
 *
 * Everything above splices modules into ONE flat scope alongside hono, zod and
 * the app code, so a name this build introduces that already exists at the top
 * level is a `SyntaxError: Identifier 'x' has already been declared` — and the
 * Worker does not boot at all. That failure is invisible until deploy, where it
 * takes the whole app down rather than just the new feature. Parsing here turns
 * it into a failed build.
 *
 * Checked as .mjs so `export default` is legal, and only parsed — nothing runs,
 * so the Cloudflare-only globals it references never need to exist.
 */
const checkDir = mkdtempSync(join(tmpdir(), 'macroflow-build-'));
const checkFile = join(checkDir, 'candidate.mjs');
writeFileSync(checkFile, out);
try {
  execSync(`node --check "${checkFile}"`, { stdio: 'pipe' });
} catch (error) {
  throw new Error(`bundle does not parse:\n${error.stderr?.toString() || error.message}`);
}

writeFileSync(`${OUT_DIR}/index.js`, out);

console.log(JSON.stringify({
  baseBytes: bundle.length,
  outBytes: out.length,
  addedBytes: out.length - bundle.length,
  patches: PATCHES.length,
  progressModuleBytes: progress.length,
  progressAssetsBytes: progressAssets.length,
  habitsModuleBytes: habits.length,
  habitsAssetsBytes: habitsAssets.length,
  habitRemindersBytes: habitReminders.length,
  photoLockBytes: photoLock.length,
  syntax: 'ok',
}, null, 2));
