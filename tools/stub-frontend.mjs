/**
 * Serves the real built Jamtytrack frontend (macroflow-app/dist) against a stub
 * API that mirrors the SHAPES observed in production D1/KV on 2026-08-29:
 *
 *   - photo_crypto row EXISTS  -> encryption.configured = true
 *   - all 3 progress_photos have encrypted = 0 (plaintext, pre-encryption)
 *   - image_path values are /progress-photos/<uuid>.jpg
 *
 * That combination is the state the live app is actually in, and it is the one
 * worth reproducing: encryption switched on, but every stored photo predates it.
 *
 * Also injects /progress-client.js exactly as the Worker's HTMLRewriter does,
 * so the injected launcher and the app's native Photos tab are exercised
 * together.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';

const DIST = process.env.JAMTY_DIST || 'C:/Users/agust/macroflow-app/dist';
const CLIENT = process.argv[3]; // optional path to progress-client.js
const HABITS = process.argv[4]; // optional path to habits-client.js
const PORT = Number(process.argv[2] || 8141);

const REAL_PHOTOS = [
  { id: 'd8696df7-cbe8-4cc7-abdd-dae8499dc811', takenAt: '2026-08-19T12:00:00.000Z', takenDate: '2026-08-19',
    pose: 'front', encrypted: false, imagePath: '/progress-photos/d8696df7-cbe8-4cc7-abdd-dae8499dc811.jpg',
    weightKg: 96.4, notes: '' },
  { id: 'cac2f66c-41ea-4845-aa01-f5ff8641cac9', takenAt: '2026-08-19T12:01:00.000Z', takenDate: '2026-08-19',
    pose: 'front', encrypted: false, imagePath: '/progress-photos/cac2f66c-41ea-4845-aa01-f5ff8641cac9.jpg',
    weightKg: 96.4, notes: '' },
  { id: 'c2d1871c-b1b3-4839-acb7-1d8e209f8fa4', takenAt: '2026-08-19T12:02:00.000Z', takenDate: '2026-08-19',
    pose: 'side', encrypted: false, imagePath: '/progress-photos/c2d1871c-b1b3-4839-acb7-1d8e209f8fa4.jpg',
    weightKg: 96.4, notes: '' },
];

// 1x1 JPEG so <img> actually decodes.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64');

let unlocked = false;

/* Mirrors listHabits(): the row aliased to camelCase plus the computed
   fields. Matches production - 'Walk 10 km', started 2026-08-26, days 1
   and 2 logged, day 3 (Aug 28) missing. */
const HABIT = {
  id: 'b1a7d4c2-9e35-4f18-8a6b-3c0d5e7f2a91',
  name: 'Walk 10 km', emoji: '🚶',
  targetValue: 10, unit: 'km',
  startedOn: '2026-08-26', reminderTime: '21:00', reminderEnabled: 1,
  archived: 0, sortOrder: 0,
  dayNumber: 4, streak: 0, longestStreak: 2,
  doneToday: false, todayValue: null,
  history: ['2026-08-27', '2026-08-26'],
  totalDone: 2, totalValue: 20,
};

/*
 * serializeSettings() merges getTimeContext into the settings payload, and
 * /api/dashboard embeds this whole object under `settings`. App.tsx does
 * setSelectedDate(next.today) on boot — omit `today` and Today.tsx dies in
 * toISOString before React ever mounts.
 */
const SETTINGS = {
  name: 'Jamt', onboardingComplete: true,
  calorieTarget: 3110, proteinTarget: 192, carbsTarget: 392, fatTarget: 86, fiberTarget: 43,
  weightKg: 96.4, heightCm: 193, age: 25, sex: 'male',
  activity: 'light', goal: 'gain', theme: 'light', plateDiameterCm: 25,
  openrouterConfigured: false, openrouterKeySource: 'none',
  openrouterModel: 'google/gemini-3.6-flash',
  telegramTokenConfigured: false, telegramChatId: '',
  timezone: 'America/Buenos_Aires', reminders: [],
  today: '2026-08-29', now: new Date().toISOString(), localTime: '18:30',
  greeting: 'evening',
  dayStartedAt: '2026-08-29T03:00:00.000Z', dayEndsAt: '2026-08-30T03:00:00.000Z',
};

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.jpg': 'image/jpeg' };

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const log = (...a) => console.log('[stub]', req.method, path, ...a);

  if (path === '/progress-client.js' && CLIENT && existsSync(CLIENT)) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(readFileSync(CLIENT));
  }
  if (path === '/habits-client.js' && HABITS && existsSync(HABITS)) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(readFileSync(HABITS));
  }

  if (path.startsWith('/progress-photos/')) {
    log('-> 1x1 jpeg');
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(JPEG);
  }

  if (path.startsWith('/api/')) {
    log();
    if (path === '/api/health') return json(res, { ok: true, storage: 'd1', now: new Date().toISOString() });
    // Exact shape of shared/time.ts:getTimeContext — a wrong one crashes the
    // app at Date.toISOString before React mounts.
    if (path === '/api/time') return json(res, {
      timezone: 'America/Buenos_Aires',
      now: new Date().toISOString(),
      today: '2026-08-29',
      localTime: '18:30',
      greeting: 'evening',
      dayStartedAt: '2026-08-29T03:00:00.000Z',
      dayEndsAt: '2026-08-30T03:00:00.000Z',
    });
    if (path === '/api/settings') return json(res, SETTINGS);
    // Returns { date, settings, totals, meals } — settings is EMBEDDED, and the
    // app reads settings.calorieTarget straight off it.
    if (path === '/api/dashboard') return json(res, {
      date: '2026-08-29', settings: SETTINGS,
      totals: { calories: 0, protein: 0, carbs: 0, fiber: 0, fat: 0 }, meals: [] });
    if (path === '/api/progress/state') return json(res, {
      unlocked, unlockMinutes: 15, expiresAt: unlocked ? Date.now() + 900000 : null,
      separateSecret: process.env.JAMTY_SEPARATE === '1', encryption: { configured: true, salt: 'c2FsdHNhbHRzYWx0c2FsdA==' } });
    if (path === '/api/progress/unlock') { unlocked = true; return json(res, { unlocked: true, unlockMinutes: 15, expiresAt: Date.now() + 900000, wrappedKey: 'd3JhcHBlZGtleQ==' }); }
    if (path === '/api/progress/lock') { unlocked = false; return json(res, { unlocked: false }); }
    if (path === '/api/progress') {
      if (!unlocked) return json(res, { error: 'Photos are locked', locked: true }, 403);
      return json(res, REAL_PHOTOS);
    }
    // Shape must match the Worker: { habits, today }. A bare array renders
    // as "No habits yet" because the client reads data.habits.
    if (path === '/api/habits') return json(res, { habits: [HABIT], today: '2026-08-29' });
    if (path === '/api/history') return json(res, { nutrition: [], weights: [] });
    if (path === '/api/foods' || path === '/api/quick-adds' || path === '/api/my-foods' || path === '/api/memories') return json(res, []);
    if (path === '/api/ai/status') return json(res, { configured: false, source: 'none' });
    if (path === '/api/telegram/status') return json(res, { configured: false });
    return json(res, {});
  }

  // static
  let file = join(DIST, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  if (!existsSync(file)) file = join(DIST, 'index.html');       // SPA fallback
  let body = readFileSync(file);
  const type = TYPES[extname(file)] || 'application/octet-stream';
  if (type.startsWith('text/html') && (CLIENT || HABITS)) {
    let tags = '';
    if (CLIENT) tags += '<script src="/progress-client.js" defer></script>';
    if (HABITS) tags += '<script src="/habits-client.js" defer></script>';
    body = Buffer.from(String(body).replace('</head>', tags + '</head>'));
  }
  res.writeHead(200, { 'content-type': type });
  res.end(body);
}).listen(PORT, () => console.log('stub listening on http://localhost:' + PORT));
