# MacroFlow — Knowledge Base

> Reconstructed entirely from live Cloudflare state via `wrangler` on **2026-08-18**.
> There is **no local source checkout** — the deployed Worker is currently the only copy of the code.

---

## 1. What it is

A single-user **macro / nutrition tracker** deployed as one Cloudflare Worker. You photograph or describe a meal, an LLM (via OpenRouter) identifies the foods and estimates portions, and the app breaks it into per-item macros and tallies them against daily targets. It also tracks body weight and fires scheduled meal reminders.

Everything — API, cron, and frontend — is served from **one Worker** with static assets bound in. There is no separate Pages project.

**Live at:** https://macro.montagnertudor.org (returns `HTTP 401` until you pass the password gate — confirmed responding)

---

## 2. Cloudflare resources

**Account:** `Agustinmontagner@gmail.com's Account` — `6c3b2df3d669fda007025e023ffee12c`

The second account on the token, `Nilasero60@gmail.com's Account` / `b698d1a7dabf95737b3145ee9d95a119`, holds nothing related — only a `sinergia-club` worker.

| Resource | Type | ID |
|---|---|---|
| `macroflow` | Worker | — |
| `macroflow` | D1 database | `978a69cc-f981-4fa8-a136-c67b556bb643` |
| `PHOTOS` | KV namespace | `cafdcdcb096c4b23b5978317a08a0fa1` |

R2 is **not enabled** on this account (API error 10042).

### Worker runtime

- **Handlers:** `fetch` + `scheduled` — it is both the web app and a cron job
- **Compatibility date:** `2026-08-13`
- **Compatibility flags:** `nodejs_compat`
- **Last deployed:** `2026-08-15T02:30:02Z` (version `1f24e9ee-7d5f-43ed-adb0-5286f8b118ff`)

### Bindings

| Binding | Resource |
|---|---|
| `env.DB` | D1 → `macroflow` |
| `env.PHOTOS` | KV → `cafdcdcb096c4b23b5978317a08a0fa1` |
| `env.ASSETS` | Static assets (the frontend) |
| `env.APP_URL` | Var → `https://macro.montagnertudor.org` |

### Secrets (Worker-level)

- `APP_PASSWORD` — the shared password for the login gate
- `OPENROUTER_API_KEY`

Note the duplication: an OpenRouter key **also** lives in the D1 `app_secrets` table (73 chars, set `2026-08-14 01:22:33`). Two sources of truth for the same credential — worth collapsing to one.

### Reconstructing `wrangler.jsonc`

```jsonc
{
  "name": "macroflow",
  "main": "worker/index.ts",   // confirmed from the recovered bundle — there is no src/
  "compatibility_date": "2026-08-13",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "binding": "ASSETS" },
  "vars": { "APP_URL": "https://macro.montagnertudor.org" },
  "d1_databases": [
    { "binding": "DB", "database_name": "macroflow",
      "database_id": "978a69cc-f981-4fa8-a136-c67b556bb643" }
  ],
  "kv_namespaces": [
    { "binding": "PHOTOS", "id": "cafdcdcb096c4b23b5978317a08a0fa1" }
  ],
  "triggers": { "crons": ["* * * * *"] }
}
```

**The cron runs every minute.** `wrangler` cannot show this, but the REST API can:

```bash
curl -H "Authorization: Bearer $CF_API_TOKEN"   "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/macroflow/schedules"
```

That is 1,440 invocations a day, currently all no-ops — the reminder path has no
delivery channel configured (§4), which is why `sent_reminders` is empty. The
minute granularity is what lets user-configured reminder times like `13:30` fire
on time, so it is defensible, but nothing is using it yet.

---

## 3. Data model (D1 `macroflow`)

10 tables, ~123 kB, created `2026-08-13T23:12:28Z`, region ENAM, read replication disabled.

### `foods` — the food reference table (41 rows)

```sql
CREATE TABLE foods (
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
  aliases TEXT NOT NULL DEFAULT '[]',   -- JSON array of alternate names
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Critical convention:** macro columns are stored **per 100 g**, not per serving. `serving_grams` is the scaling factor. Olive oil is `884` kcal with `serving_grams` 14; whey is `400` kcal / `80` g protein per 100 g. Any code reading this table must divide by 100 and multiply by grams.

### `meals` — one logged eating event (12 rows)

```sql
CREATE TABLE meals (
  id TEXT PRIMARY KEY,                       -- UUID
  logged_at TEXT NOT NULL,                   -- ISO 8601 UTC
  meal_type TEXT NOT NULL,                   -- Breakfast|Lunch|Merienda|Dinner|Treat
  title TEXT NOT NULL,                       -- LLM-generated description
  image_path TEXT,                           -- legacy single-image column
  image_paths_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',     -- manual|openrouter|repeat
  confidence REAL,                           -- LLM self-reported, 0-1
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX meals_logged_at ON meals (logged_at);
```

`image_path` and `image_paths_json` coexist — a half-finished migration from single to multi-image.

### `meal_items` — the macro line items (26 rows)

```sql
CREATE TABLE meal_items (
  id TEXT PRIMARY KEY,
  meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  food_id INTEGER REFERENCES foods(id),   -- nullable: LLM-invented foods are not in `foods`
  name TEXT NOT NULL,
  grams REAL NOT NULL,
  calories REAL NOT NULL,   -- absolute for this portion, NOT per-100g
  protein REAL NOT NULL, carbs REAL NOT NULL,
  fiber REAL NOT NULL DEFAULT 0, fat REAL NOT NULL
);
CREATE INDEX meal_items_meal_id ON meal_items (meal_id);
```

Macros here are **absolute for the portion** — the opposite convention from `foods`. Easy to get wrong.

### `settings` — singleton config row

`CHECK (id = 1)` enforces exactly one row. Full column list (dumped live —
note the target columns are `<macro>_target`, **not** `target_<macro>`, and the
activity column is `activity`, not `activity_level`):

| Column | Type |
|---|---|
| `id` | INTEGER |
| `name` | TEXT |
| `onboarding_complete` | INTEGER |
| `calorie_target` | REAL |
| `protein_target` | REAL |
| `carbs_target` | REAL |
| `fat_target` | REAL |
| `fiber_target` | REAL |
| `weight_kg` | REAL |
| `height_cm` | REAL |
| `age` | INTEGER |
| `sex` | TEXT |
| `activity` | TEXT |
| `goal` | TEXT |
| `theme` | TEXT |
| `plate_diameter_cm` | REAL |
| `openrouter_model` | TEXT |
| `telegram_bot_token` | TEXT |
| `telegram_chat_id` | TEXT |
| `timezone` | TEXT |
| `reminders_json` | TEXT |
| `updated_at` | TEXT |
| `report_model` | TEXT — added by `0004` (§10) |

### `weight_entries` (1 row)

`id TEXT PK, recorded_at TEXT, weight_kg REAL`

### `meal_memories` (0 rows — unused)

`id, subject, note, times_used, created_at, updated_at` — a "remember that I usually eat X" feature that is built but has never been written to.

### `sent_reminders` (0 rows)

`id, reminder_key UNIQUE, sent_at` — the cron idempotency ledger. The UNIQUE constraint on `reminder_key` is what stops double-sends.

### `login_attempts` (0 rows)

`ip TEXT PK, failures INTEGER, window_started_at TEXT, locked_until TEXT` — per-IP brute-force lockout.

### `app_secrets` (1 row)

`name TEXT PK, value TEXT, updated_at TEXT` — currently holds `openrouter_api_key`.

### Migrations applied

**The `d1_migrations` ledger under-reports.** It lists only what was applied via
`wrangler d1 migrations apply`; everything since has been applied with
`d1 execute --file`, which does not record itself. Verified against
`sqlite_master` on 2026-08-19:

| # | Name | Applied | In `d1_migrations`? |
|---|---|---|---|
| 1 | `0001_init.sql` | 2026-08-13 23:12:51 | yes |
| 2 | `0002_seed_foods.sql` | 2026-08-13 23:12:51 | yes |
| 3 | `0003_login_attempts.sql` | 2026-08-13 23:50:08 | yes |
| 4 | `0004_reports.sql` | 2026-08-18 21:47:42 | yes |
| 5 | `0005_fiber_foods.sql` | ~2026-08-18 | **no** — but `foods` holds 45 rows, so it ran |
| 6 | `0006_push_notifications.sql` | ~2026-08-18 | **no** — but `push_subscriptions` exists |
| 7 | `0007_progress_photos.sql` | 2026-08-19 | **no** — but `progress_photos` exists (§11) |

Trust `sqlite_master`, not the ledger. The database is now **13 tables**, not the
10 recorded at the top of this section.

The `d1_migrations` table means the repo had a `migrations/` directory — recreate it if you rebuild the source.

---

## 4. Current live state

### User profile (`settings`, updated `2026-08-14 01:22:33`)

| Field | Value |
|---|---|
| name | Jamt |
| onboarding_complete | 1 |
| targets | **3110 kcal** · 192 g protein · 412 g carbs · 77 g fat · 30 g fiber |
| body | 96 kg · 193 cm · age 25 · male |
| activity / goal | light / **gain** |
| theme | light |
| plate_diameter_cm | 25 |
| openrouter_model | `google/gemini-3.6-flash` |
| timezone | `America/Buenos_Aires` |
| Telegram bot token / chat id | **empty** (not configured) |

`plate_diameter_cm` is the scale reference for photo-based portion estimation — the "plate of known diameter" trick from the research notes (§8).

**Reminders configured:** Breakfast 09:00 (off) · Lunch 13:00 (**on**) · Dinner 21:00 (**on**). The default `merienda` 17:30 entry has been deleted from this row.

Telegram is empty, so the `scheduled` handler currently has no delivery channel — which is consistent with `sent_reminders` having 0 rows.

### Food library — 41 seeded foods

Carbs 13 · Protein 8 · Fats 6 · Fruit 4 · Vegetables 3 · Dairy 3 · Prepared 2 · Treats 1 · Supplements 1.

Argentine-localized entries: beef empanada, chicken milanesa, dulce de leche.

### Logged meals — 12, spanning 2026-08-13 → 2026-08-16

11 of 12 came from `openrouter`; 1 from `repeat`. Zero manual entries — the LLM path is the only one being used in practice.

LLM confidence sits in a narrow band: **0.44, 0.56, 0.84, 0.85** — four discrete values across 11 meals. That looks like the model returning coarse buckets rather than a calibrated score.

Sample entries: *Asado con entraña, papas fritas y choripán* (1440 kcal) · *4 hamburguesas caseras de carne y queso* (1884 kcal) · *40 Palitos de la Selva* (480 kcal).

### Activity

- **Last write:** `2026-08-17 06:39:22` UTC
- Last 24 h: 1,409 reads / **0 writes**; 1,548 rows read / 0 written

Being read but not written to — consistent with the app being open while no new meals get logged.

---

## 5. Known issues

**1. ~~Orphaned meal photos~~ — not a bug, and never was.** This previously read
that `PHOTOS` contained **zero keys** and the meal image references were
dangling. That was a measurement error: `wrangler kv key list` was run **without
`--remote`**, so it read the local `.wrangler` simulation rather than the real
namespace and returned `[]`.

Re-checked 2026-08-19 with `--remote`: the namespace holds **all 6 meal photos**,
including one uploaded 2026-08-18. Confirmed a second way with a
write/read/delete round-trip. Nothing is missing and nothing is dangling.

**Always pass `--remote` to `wrangler kv` commands.** It fails quietly in the
most misleading possible direction — an empty list that looks like data loss.

**2. Duplicate meal from a double-submit.** *"Asado con entraña, papas fritas y choripán"* exists twice with distinct IDs, identical `logged_at`, created **43 seconds apart** (`06:38:39` and `06:39:22`). There is no idempotency guard on meal creation. Cleanup:

```sql
DELETE FROM meals WHERE id = 'd222be10-c06f-4f0c-91ec-645258ccb00f';
```

`meal_items` cascades on delete, so the 3 child rows go with it.

**3. ~~Duplicated OpenRouter credential~~ — not a bug.** The recovered `worker/db.ts` shows this is a deliberate precedence chain:

```js
async function getOpenRouterApiKey(env) {
  return env.OPENROUTER_API_KEY || await getAppSecret(env, "openrouter_api_key");
}
```

The Worker secret wins; the `app_secrets` row is the fallback the settings UI can write. Leave both.

**4. Two conventions for macro columns** — per-100 g in `foods`, absolute in `meal_items`. Undocumented in the schema and a likely source of silent 100x errors.

**5. Dead `image_path` column** superseded by `image_paths_json`.

**6. `meal_memories` built but never used** — 0 rows since creation.

---

## 6. Operating it

Wrangler is not installed globally — use `npx`. All commands need the account selected:

```bash
export CLOUDFLARE_ACCOUNT_ID=6c3b2df3d669fda007025e023ffee12c
```

Query the database:

```bash
npx wrangler d1 execute macroflow --remote --command "SELECT * FROM settings WHERE id=1;"
```

Inspect database health and usage:

```bash
npx wrangler d1 info macroflow
```

Watch live logs, useful for debugging the cron:

```bash
npx wrangler tail macroflow
```

Review deploy history:

```bash
npx wrangler versions list --name macroflow
```

Roll back to the previous version:

```bash
npx wrangler rollback --name macroflow
```

Credentials live at `C:\Users\agust\AppData\Roaming\xdg.config\.wrangler\config\default.toml` (OAuth, `agustinmontagner@gmail.com`).

Note: D1 rejects compound `SELECT`s with more than ~4 `UNION ALL` terms (`SQLITE_ERROR 7500`). Split large multi-table count queries.

---

## 7. Deployment history

10 versions, all authored by `agustinmontagner@gmail.com`, all on 2026-08-14 and 08-15. Built in a burst — from empty D1 to deployed in about 3 hours on Aug 13-14.

| Version | Created | Promoted |
|---|---|---|
| `aafb7408` | 2026-08-14 00:02:39 | |
| `e0fe6217` | 2026-08-14 00:06:31 | |
| `97b21557` | 2026-08-14 00:10:40 | |
| `8d2f1bed` | 2026-08-14 01:27:29 | |
| `8c504ee5` | 2026-08-14 01:47:29 | |
| `f043f6f9` | 2026-08-14 01:53:26 | deployed |
| `ca1baa1b` | 2026-08-14 01:58:01 | deployed |
| `06ae67d4` | 2026-08-14 02:29:45 | deployed |
| `eaf43f37` | 2026-08-15 02:28:23 | deployed |
| `1f24e9ee` | 2026-08-15 02:30:00 | **current, 100%** |

---

## 8. Design background

Prior research lives at `Proyectos/Apps-Agentes/macros app/macro-app-research.md` (10.7 kB, dated 2026-08-08 — five days before the build). Its conclusions clearly shaped what got built:

- **Recommended build order:** manual logging first, then a bundled food DB, then barcodes, then densities, then vision last. The build **inverted this** — it went straight to LLM vision and skipped barcode scanning and the USDA bulk import entirely, seeding 41 hand-written foods instead.
- **LiDAR from a website is impossible on iOS.** Safari has no WebXR on iOS/iPadOS through 26.5, and there is no raw LiDAR API even natively. The fallback the doc recommends — monocular depth estimation with a scale reference in frame (a credit card, a coin, a plate of known diameter) — is why `settings.plate_diameter_cm` exists.
- **Data sources evaluated:** USDA FoodData Central (CC0), USDA FNDDS, FAO/INFOODS density DB, Open Food Facts (ODbL), ARGENFOODS.
- **FOSS prior art:** OpenNutriTracker, SparkyFitness, Waistline, FoodYou. Three of the four are GPL-3.0, so their code cannot go into a closed-source app. The data sources are reusable; the code is not.
- **The identified gap:** photo recognition is the one durable advantage closed-source trackers still hold over FOSS ones. MacroFlow targets exactly that gap.

---

## 9. Recovering the source — **done (2026-08-18)**

The source is recovered and now lives in `recovered/` — see `recovered/README.md`.
The Worker is no longer a single point of failure.

`GET /workers/scripts/{name}/content` rejects wrangler's OAuth token
(`10405 Method not allowed for this authentication scheme`), which is what made
this look impossible. **A different endpoint accepts the same token:**

```bash
TOKEN=$(grep '^oauth_token'   "$APPDATA/xdg.config/.wrangler/config/default.toml" | sed 's/.*= *"//; s/"//')
curl -H "Authorization: Bearer $TOKEN"   "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/services/macroflow/environments/production/content"
```

It returns `multipart/form-data`; the `index.js` part is the deployed bundle
(711 kB). The deploy was **not minified**, so esbuild's `// path/to/file.ts`
markers survived and the bundle splits cleanly back into modules.

What came back: ~1,570 lines of application code across 7 modules, plus vendored
hono 4.13.1 and zod 4.4.3 making up the other ~17,000 lines.

| Module | Lines |
|---|---|
| `worker/index.ts` | 491 — Hono app, all 26 routes, the `fetch`/`scheduled` export |
| `shared/analysis-core.ts` | 409 — food matching, portion maths, vision prompts |
| `worker/analysis.ts` | 252 — OpenRouter calls for meal analysis |
| `worker/auth.ts` | 132 — password gate, sessions, IP lockout |
| `worker/telegram.ts` | 132 — bot messaging, `checkReminders` |
| `shared/time.ts` | 97 — timezone helpers |
| `worker/db.ts` | 59 — settings, foods, secrets, photos |

Caveats: it is the **built bundle**, not the original TypeScript — types erased,
imports inlined, `__name()` wrappers throughout. Readable and faithful, but a
rewrite reference rather than a buildable tree. The frontend is served via the
`ASSETS` binding and is not in the script bundle, so it was not recovered.

**Do not** use `wrangler init --from-dash <name> -y`. The `-y` skips the download
and scaffolds a hello-world project whose `wrangler.jsonc` carries
`name: macroflow` — deploying it would overwrite the live Worker.

The scheduled handler as deployed:

```js
var index_default = {
  fetch: app.fetch,
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkReminders(env).catch((e) => console.error("Reminder check failed:", e)));
  }
};
```

## 10. Periodic LLM reports (in progress, 2026-08-18)

Weekly and monthly "what am I lacking" reports, analysed by a reasoning model and
stored for viewing in the app. Written but **not deployed** — blocked on source
recovery (§9).

### Files

| File | Status |
|---|---|
| `migrations/0004_reports.sql` | **applied** 2026-08-18 21:47:42 |
| `worker/reports.ts` | written, needs wiring into `scheduled` |

Placed at `worker/reports.ts` to match the real layout (`worker/` + `shared/`),
and built on the existing helpers rather than duplicating them — `partsAt`,
`dateInTimeZone`, `dateRangeUtc` and `addCalendarDays` from `shared/time.ts`,
`getSettings` / `listFoods` / `getOpenRouterApiKey` from `worker/db.ts`. The
claim-then-work idiom is copied from `checkReminders`.

### How it schedules

No new cron trigger is needed. The existing `* * * * *` tick calls
`runScheduledReports(env)`, which asks whether a period is *due and not yet
generated*:

- **weekly** — covers the previous Mon–Sun, due Monday 08:00 local
- **monthly** — covers the previous calendar month, due the 1st at 08:00 local

Because the test is "at or after the due time" rather than "exactly at it", a
missed minute (deploy, outage, cold start) self-heals on the next tick instead of
dropping the period.

Once-only generation reuses the **existing** `sent_reminders` ledger rather than a
new mechanism: `INSERT OR IGNORE` against its `UNIQUE(reminder_key)` index with a
key of `report:weekly:2026-W34`. Exactly one concurrent tick sees
`meta.changes === 1` and proceeds. On failure the key is deleted so the next tick
retries.

Day bucketing goes through `Intl` in `settings.timezone`, not a hardcoded `-3`, so
it stays correct if the timezone is ever changed to one observing DST. Date logic
is verified over a 400-day sweep including ISO-week year boundaries
(`2026-W01` = `2025-12-29..2026-01-04`) and February lengths.

### The micronutrient problem

`foods` stores only calories, protein, carbs, fiber, fat — **no vitamins or
minerals at all**. "What am I lacking" in the usual sense (iron, B12, vitamin D,
calcium, zinc, omega-3) is therefore not computable from this schema.

Current approach follows what `macros.md` §8 already concluded — *"a photo app
estimates macros reasonably and micros poorly; handle these with food rules rather
than daily numbers."* So the prompt explicitly forbids estimating mg/IU intakes
and instead asks whether the logged food met the user's own baseline rule (2 fruit,
3 vegetables, 1 legume, 1 nuts/seeds per day), naming which nutrients are at risk
when it did not. Their documented targets for vitamin D, omega-3, calcium, iron,
magnesium, zinc, potassium and sodium are embedded in the prompt, including the
note that athletes need *more* sodium, not less.

Every micronutrient claim still carries a `high|medium|low` confidence and is
labelled an inference from food names, not a measurement.

The rigorous fix is to add micronutrient columns and backfill the 41 foods from
USDA FoodData Central (CC0, already evaluated in the research doc, §8). The report
pipeline does not change when that lands — only the payload gets richer.

### Model

`moonshotai/kimi-k3` via OpenRouter, in a new `settings.report_model` column so it
stays separate from `settings.openrouter_model`, which the vision path uses
(`google/gemini-3.6-flash`) and should keep using.

Pricing check on 2026-08-18: K3 is **$3/M in, $15/M out** with 1M context — the
flagship tier, *not* a budget model. `moonshotai/kimi-k2.6` is $0.56/$2.36, roughly
5x cheaper. At this payload size (~5k in, ~2k out) a run costs about $0.06, so
weekly + monthly is on the order of **$4/year** either way.

### Status

`0004_reports.sql` was **applied on 2026-08-18 21:47:42** — `reports` exists (0
rows) and `settings.report_model` defaults to `moonshotai/kimi-k3`. A partial
`wrangler.jsonc` was added to make that possible; it deliberately omits `main` and
`assets` so `wrangler deploy` cannot run from it and clobber the only copy of the
Worker source.

The source has since been recovered (§9), so nothing here is blocked any more.

Still to do:

1. Rebuild a buildable source tree from `recovered/` — the recovered files are the
   compiled bundle, not the original TypeScript, so this is the real remaining work.
2. Call `runScheduledReports(env)` from the `scheduled` handler — a one-line change
   alongside the existing `checkReminders` call.
3. Add a `GET /api/reports` route and a frontend view.
4. Restore `main` and `assets` in `wrangler.jsonc`, but **only** once a genuine
   buildable tree exists and is under git. Until then a deploy from this directory
   would replace the live Worker with something incomplete.

Deferred by choice: the first weekly report cannot be generated until the Worker
runs the new code, because the OpenRouter key is a Worker secret and an
`app_secrets` row — neither is readable from a local shell, by design.

### Note on source recovery

`GET /workers/scripts/macroflow/content` **rejects wrangler's OAuth token** with
`10405 Method not allowed for this authentication scheme`. It needs a
dashboard-created API token with Workers Scripts:Read, or use the dashboard's
Quick Edit.

---

## 11. Progress photos (written 2026-08-19, not deployed)

Body progress photos — capture, timeline, and a same-pose before/after with the
bodyweight delta. Fills the one row of `macros.md` §10 that had nowhere to go:
*Photos — every 4 weeks — same light, pose, time of day*.

Full detail in **`PROGRESS-PHOTOS.md`**. Summary:

| File | Status |
|---|---|
| `migrations/0007_progress_photos.sql` | **applied** 2026-08-19 |
| `worker/progress.ts` | **deployed** |
| `worker/progress-assets.ts` | **deployed** |
| Routes | **deployed** 2026-08-19, version `605f2295` (v18) |

**LIVE.** `progress_photos` exists with both indexes; the database is now 13
tables. Deployment history in §7 is stale from version 15 onward — the current
version is **18** (`605f2295-c16e-43e0-992f-7850851dd049`), uploaded via the API
rather than wrangler. 16 shipped with a hardcoded dark palette, 17 added runtime
theme adoption, 18 moved the launcher into the nav bar.

### The UI is grafted onto the app, not dropped on top of it

The launcher is a **nav-bar tab cloned from one of the app's own items** — active
state stripped, icon swapped for an outline camera, relabelled "Photos" (the nav
already has a Progress tab). Cloning means it inherits the app's class names,
sizing and markup for free, which is the only reliable way to match a frontend
that cannot be read. It goes second-to-last so Settings stays last. Colours are
sampled from the live page at mount.

**The app's design, recorded from a screenshot 2026-08-19** — the first direct
look at the frontend, and worth keeping since it is otherwise unreadable:

- fixed bottom nav: Today · Progress · Scan · Settings, Scan a raised dark circle
- warm off-white page (~`#f4f3ef`), near-black text, dark rounded hero card
- **lime-green accent ~`#c5f04a`**, appearing on a chip inside a pale card, on
  small heading text, and as an icon colour — *never* as a button's own
  background, which is why naive accent detection missed it entirely
- large corner radii (cards ~18–22px)

`PROGRESS-PHOTOS.md` §9 and §10 have the token table, the clone technique, and
what to check if it still looks off.

### This unblocks reports and push too

§10 named "rebuild a buildable source tree" as the blocker for every pending
feature. **That was not the only path.** `tools/build-worker.mjs` patches the
recovered production bundle directly and uploads it with `keep_assets: true`,
which never touches the asset store — the actual reason a deploy was dangerous.
Full method and the staged-version safety procedure in `PROGRESS-PHOTOS.md` §8.

`runScheduledReports` and the push routes could go live the same way. A proper
source tree is still worth having, but it is no longer a prerequisite.

### `dist/worker.js` is a local copy of production

First time that has been true. The Worker is no longer the only copy of its own
code. `recovered/BUNDLE-FULL.js` stays as the pristine pre-feature base the build
patches — do not overwrite it.

**The frontend is still a single point of failure** and this deploy did not change
that. It exists only in Cloudflare's asset store, cannot be downloaded back, and
is unrecoverable if a future deploy drops it. Backing it up is the most valuable
outstanding task in the project.

### Storage

Metadata in D1 (`progress_photos`), bytes in KV under the **`progress/`**
prefix. R2 remains unavailable (error 10042, re-confirmed 2026-08-19).

The prefix is a privacy boundary rather than a naming choice. Meal photos
(`uploads/`) are deliberately uploaded to OpenRouter for macro estimation; body
photos must never be. Existing code already respects it — `DELETE /api/meals/:id`
filters on `/uploads/` before deleting KV objects, so meal deletion cannot reach
progress photos.

**One gap.** `POST /api/analyze/refine` passes a client-supplied
`analysis.imagePaths` straight into `imageContent`, which will read *any* KV key
and send it to OpenRouter. Only a signed-in caller can trigger it and the current
frontend never does, so it is not reachable by an outsider — but the two-line
guard in `PROGRESS-PHOTOS.md` §4.4 turns the convention into an enforced boundary
and is worth applying whenever `worker/analysis.ts` is next touched.

### UI without the frontend source

Injected with HTMLRewriter into a shadow root, exactly as `worker/push-assets.ts`
does, because the frontend still lives only in the `ASSETS` binding (§9). The
client downscales to a 1600 px long edge and re-encodes as JPEG, which strips the
EXIF block — iPhone photos carry GPS coordinates there, and nothing else in the
pipeline removes them.
