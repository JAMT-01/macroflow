# Jamtytrack — engineering guide

Everything an engineer needs to take this over with no prior context. The [README](README.md) is the product and setup document; this one explains how the system is built, why it is built that way, and which things will bite you.

---

## 1. Orientation

Jamtytrack is a single-user macro tracker for one person in Argentina. Photograph a meal (or describe it in words), a vision model estimates the macros, you edit and save. It also tracks weight, body progress photos, and 30-day trends.

- **Live:** `https://jamtytrack.montagnertudor.org`
- **The Cloudflare resources are still named `macroflow`.** The product was renamed; the Worker and the D1 database were not, and that is deliberate. Cloudflare cannot rename either in place: renaming a Worker creates a *new* one that starts with no secrets, and D1 has no rename command at all, so it would mean copying a live database that holds the photo encryption keys. Neither risk buys anything, because the names appear only in the dashboard and in `wrangler` commands. **Every `wrangler` command below says `macroflow` on purpose.**
- **Runs entirely on Cloudflare's free tier**: Worker + D1 + KV, no origin server
- **Single user.** There is no user table, no tenancy, no sharing. One passphrase gates the app; a second one gates the body photos.
- **Not a medical device.** Every number is an estimate and the UI says so.

### Five-minute start

```bash
pnpm install
```

```bash
pnpm bootstrap
```

```bash
pnpm d1:migrate:local
```

```bash
pnpm dev
```

`pnpm bootstrap` generates `.dev.vars` with a random local passphrase and prints it. **You do not need any production credential to develop.** Vite serves the UI on `:5173` with HMR and proxies `/api` to `wrangler dev` on `:8787`. Local D1 and KV are emulated under `.wrangler/` — throwaway state, never production. Run `pnpm check && pnpm test` before pushing.

> **Wrangler is a local devDependency.** Every command needs `npx` (or a `pnpm` script). A bare `wrangler …` fails with "not recognized".

---

### Credentials: what you need, and what you do not

**Local development needs nothing from anyone.** `pnpm bootstrap` generates a local passphrase; with no OpenRouter key the app falls back to the local food matcher, so every screen still works. Only the model's estimates are unavailable.

**Production secrets are never written down.** They live only as Worker secrets, encrypted by Cloudflare, and are not in this repo, this document, `.dev.vars.example`, or git history — deliberately, because git history is permanent and this document is shareable. Anyone who needs production access gets it from the owner directly, or sets their own.

| secret | needed for | where it lives | how to get one |
| --- | --- | --- | --- |
| `APP_PASSWORD` | signing in | Worker secret | ask the owner, or set your own on your own deployment |
| `PHOTO_PASSPHRASE` | body photos | Worker secret | as above; falls back to `APP_PASSWORD` when unset |
| `OPENROUTER_API_KEY` | AI estimates | Worker secret, or D1 `app_secrets` via Settings | create your own at <https://openrouter.ai/settings/keys> — do not reuse production's |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram | Worker secret | generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

To read which secrets a deployment *has* (names only, never values):

```bash
npx wrangler secret list
```

Setting or rotating any of them is §9 — and mind the versions trap there.

To inspect production data without production credentials in hand:

```bash
npx wrangler d1 execute macroflow --remote --command "SELECT COUNT(*) FROM meals;"
```

That authenticates through `wrangler login` (your own Cloudflare account access), which is the right boundary: account access is auditable and revocable, a pasted passphrase is neither.

**If a credential is ever pasted into a chat, screenshot, or ticket, rotate it.** It cannot be un-shared.

---

## 2. Architecture

One Worker serves everything. There is no separate API host and no origin.

```
  Browser (React SPA, built by Vite into dist/)
      |
      | https://jamtytrack.montagnertudor.org
      v
  Cloudflare Worker  (worker/index.ts, Hono router)
      |
      +-- security headers middleware   (every response)
      +-- auth middleware               (every path except 3 public ones)
      +-- /api/*                JSON endpoints
      +-- /uploads/*            meal photos -> KV
      +-- /progress-photos/*    body photos -> KV, needs a second unlock
      +-- everything else       -> env.ASSETS (the built SPA)
      |
      +-- D1  "macroflow"   diary, settings, secrets, rate limits
      +-- KV  PHOTOS        all images
      +-- fetch()           OpenRouter (vision + refinement), Telegram
      +-- scheduled()       cron every minute, for reminders
```

**`run_worker_first: true` is load-bearing.** The Worker runs before static assets on *every* path. If assets were served first, the app shell and the meal photos would be reachable without a session. Do not change this.

### Request lifecycle

1. **Security headers** middleware wraps the response (§6).
2. **Auth** middleware: three public paths pass through; everything else needs a valid session cookie, or you get the login page (HTML) or a 401 (JSON).
3. Route handlers run. Photo routes additionally require the unlock cookie.
4. Anything unmatched falls through to `env.ASSETS.fetch()` — the SPA, with `not_found_handling: single-page-application` so client routes resolve.

---

## 3. Repo map

```
src/          React app (Vite). The whole UI.
  App.tsx           tab state, settings bootstrap, log modal mounting
  api.ts            every fetch call; 401 -> reload to the login page
  types.ts          client types, mirroring the Worker's JSON
  mealTypes.ts      the five Argentine categories + offline time-band guess
  imageCapture.ts   client-side downscale, quality scoring, EXIF stripping
  lockZoom.ts       cancels iOS pinch gestures; the viewport meta is not enough
  components/       LogModal (the big one), ProgressPhotos, PhotoLock, PhotoViewer, Layout, MacroRing
  photoSession.ts   browser half of the photo encryption; holds the master key in memory only
  screens/          Today, Progress, Photos, SettingsScreen, Onboarding, BenchmarkLab*

worker/       The deployed backend.
  index.ts          Hono routes, middleware, all endpoints
  auth.ts           session + photo-unlock cookies, rate limiting, login page
  analysis.ts       OpenRouter calls, prompt selection, response normalisation
  telegram.ts       webhook handling, /today and /log, cron reminders
  db.ts             Env type, D1 helpers, KV photo helpers

shared/       Imported by BOTH worker/ and server/. No runtime dependencies.
  analysis-core.ts  prompts, JSON schemas, macro maths, meal-type rules
  photo-crypto.ts   key derivation, wrapping and AES-GCM for the body photos
  seed.ts           the 41 seed foods
  time.ts           timezone-correct "today", date ranges, diary timestamps

migrations/   D1 schema, applied in order
public/       Static files Vite copies into dist/ verbatim — PWA icons, manifest
scripts/      One-off tooling (seed generation, local export, UI download, icons)
server/       Local-only research tooling. NOT deployed. See §11.
```

`*BenchmarkLab.tsx` exists but is not imported by `App.tsx` — dead in the UI.

### Why `shared/` exists

The prompt, the Argentine meal rules, and the uncertainty maths are used by the deployed Worker *and* by the local Nutrition5k benchmark. They were duplicated once and drifted. `shared/analysis-core.ts` has no database, filesystem, or runtime dependency precisely so both can import it. **Put logic there by default**; put I/O in `worker/`.

---

## 4. Data model

D1 database `macroflow` (SQLite). Every date-like decision is timezone-aware — see §7.

| table | purpose | notes |
| --- | --- | --- |
| `settings` | single row, `id = 1` | targets, timezone, plate size, Telegram config |
| `app_secrets` | key/value | OpenRouter key when set from the UI |
| `foods` | food catalogue | seeded from `shared/seed.ts`; grows as foods are added |
| `meals` | one logged meal | `meal_type` is a five-value enum |
| `meal_items` | foods within a meal | the actual macro rows |
| `weight_entries` | weight check-ins | |
| `meal_memories` | learned prep facts | injected into later analyses |
| `sent_reminders` | reminder dedupe | unique on `reminder_key` |
| `login_attempts` | rate limiting | keyed by IP *and* by synthetic keys, §6 |
| `progress_photos` | body photos | `pose` CHECK-constrained to front/side/back; `encrypted` marks post-encryption rows |
| `photo_crypto` | photo encryption keys | single row; salt, two verifiers, two wrapped copies of the master key |
| `push_subscriptions` | **unused** | §11 |
| `reports` | **unused** | §11 |

### Images

All images live in the **`PHOTOS` KV namespace**, keyed by the URL path with no leading slash:

| kind | DB column | KV key | route |
| --- | --- | --- | --- |
| meal photo | `meals.image_path` | `uploads/<uuid>.jpg` | `GET /uploads/:key` |
| body photo | `progress_photos.image_path` | `progress-photos/<uuid>.jpg` | `GET /progress-photos/:key` |

`photoKey()` in `worker/db.ts` is the only place that converts a stored path to a KV key. Content type is kept in KV metadata.

### The fibre invariant

**Fibre is a component of carbohydrate, never an addition to it.** A food with 30 g carbs of which 5 g is fibre is still 30 g carbs. Both prompts state this, and `normalizeItem()` clamps `fiber` to at most `carbs` regardless of what the model returns. Without the clamp, carb totals inflate on legume-heavy meals. Calories are unaffected by fibre.

---

## 5. The analysis pipeline

`POST /api/analyze` accepts multipart: `image?`, `description?`, `capture?`, `scaleReference?`, `loggedDate?`. At least one of image or description is required.

### Two prompts, deliberately

| input | prompt | why |
| --- | --- | --- |
| photo (+ optional note) | `buildSinglePhotoPrompt` | reads geometry against a known plate diameter |
| words only | `buildDescriptionPrompt` | recall of typical servings; never claims to have seen anything |

Reusing the photo prompt for a text-only meal was a real bug: it opened with "You are estimating one meal from exactly ONE ordinary RGB photograph" when there was no photograph. Keep them separate.

### The plate reference

`scaleReference` is `default-plate | custom-plate | none`. The number is an **outer edge-to-edge diameter** — a 25 cm plate is 25 cm *across*. The prompt says so explicitly and forbids reading it as a square, radius, or area, because the model got this wrong. With `none`, the model is told not to convert pixels to centimetres at all and uncertainty widens.

### Normalisation, and why the server does not trust the model

Everything from OpenRouter goes through `normalizeItem()`:

- grams floored at 1; confidence clamped to 0.2–0.92
- minimum range spread set by scale confidence; a tight range needs a stated weight
- description-only estimates widened to ±40% (`widenForDescriptionOnly`)
- fibre clamped to carbs
- calories recomputed from macros when the model's number is off by more than 35%
- `calibrateAnalysisConfidence()` caps confidence: 0.84 with a good plate scale, down to 0.56 with none

If you add a field the model returns, normalise it here. Never pass model output to the database unchecked.

### Meal type

Every analysis returns a `mealTypeSuggestion`. The model decides using food, the user's note, and local time; `suggestArgentineMealType()` is the fallback when OpenRouter is unavailable and also validates the model's answer against the allowed enum. **The suggestion wins over the slot the user tapped** — a deliberate product decision.

---

## 6. Auth and privacy

Two independent gates. Both are HMAC-signed cookies with no server-side session store, so rotating a secret invalidates every cookie derived from it.

| | app session | photo unlock |
| --- | --- | --- |
| cookie | `mf_session` | `mf_photos` |
| secret | `APP_PASSWORD` | `PHOTO_PASSPHRASE` (falls back to `APP_PASSWORD`) |
| HMAC context | `::macroflow-session-v1` | `::macroflow-photos-v1` |
| lifetime | 30 days | 3 minutes, and dropped when the browser closes |
| gates | everything | `/api/progress*`, `/progress-photos/*` |

The different HMAC context strings are what stop a session cookie being replayed as a photo unlock. There is a test for exactly that.

### The PWA icons are public

`PUBLIC_ASSETS` in `worker/index.ts` lets the manifest and the generated icons
through the auth gate. This narrows invariant 1 on purpose: the OS fetches a
home screen icon while signed out — often before the first login ever happens —
so behind the gate it 401s and the installed app has no icon at all. The list is
explicit rather than a prefix or an extension test, and holds nothing but
branding.

Regenerate them with `python scripts/generate-icons.py`, optionally passing your
own square image. Pillow is used because there is no `sharp` or `canvas` in
`node_modules`; the script is run by hand and never ships.

The login page in `worker/auth.ts` carries the same icon `<link>` tags as
`index.html`, because it is a separate document and it is what iOS renders — and
would otherwise screenshot for the icon — when you are signed out.

### Public paths — the complete list

```
/api/health              liveness probe, exposes no diary data
/api/auth/login          obviously
/api/telegram/webhook    Telegram's servers cannot send a cookie
```

The webhook authenticates with the `x-telegram-bot-api-secret-token` header instead, and **fails closed**: if `TELEGRAM_WEBHOOK_SECRET` is unset it returns 503 rather than accepting anything. An earlier version treated "no secret configured" as "no check needed", which left it open to anyone who guessed the path — they could inject meals via `/log` or claim `telegram_chat_id`.

### Status codes matter here

Photo endpoints return **403** when locked, never 401. `src/api.ts` treats 401 as an expired session and reloads the page; a 401 would bounce the user to the login screen instead of showing the unlock prompt.

### Rate limiting

All in `login_attempts`, keyed to keep the three budgets independent:

| key | limit | protects |
| --- | --- | --- |
| `<ip>` | 8 per 15 min | sign-in |
| `<ip>\|photos` | 8 per 15 min | photo unlock, per address |
| `\|photos-global` | 20 per hour | photo unlock, **all addresses combined** |

The global cap exists because the photo passphrase may be a short PIN, and per-IP limits are worthless against someone spreading guesses across many addresses. The trade-off is deliberate: anyone reaching the endpoint can exhaust the global budget and seal the photos for an hour.

### The body photos are end-to-end encrypted

Photos are encrypted in the browser before upload and decrypted in the browser
after download. KV holds ciphertext, and **no key that can decrypt them ever
reaches the Worker** — the point being that Cloudflare cannot read them either.

One passphrase does both jobs. PBKDF2 stretches it to 512 bits and splits them:
the first 256 become an *auth key*, hashed and sent to prove knowledge; the
second 256 stay in the browser and unwrap the master key that photos are
actually encrypted with. The Worker seeing the auth half learns nothing about
the encryption half — they are independent outputs of the same KDF.

Photos are encrypted with a random master key rather than with the derived key
directly, and that master key is stored twice: wrapped by the passphrase half,
and wrapped by a recovery key shown once at setup. So the recovery key opens the
photos without the passphrase, and changing the passphrase re-wraps the master
key instead of re-encrypting every photo.

`shared/photo-crypto.ts` holds the whole scheme and is covered by 16 tests,
including that the verifier the Worker stores cannot unwrap the master key.

**What it does not defend.** The passphrase is still the root: anyone who
captures the auth key and the salt can guess-and-derive offline, so a weak
passphrase is weak here too — the iteration count only prices each guess. Nor
does it help on a device already unlocked and open, which is what the 3-minute
window is for.

**Photos taken before this was switched on stay plaintext.** The `encrypted`
column marks which is which so both kinds coexist; migrating the old ones would
need the passphrase and so cannot happen server-side.

### Uploads are allowlisted, not prefix-matched

Both upload paths accept only `image/jpeg`, `image/png` and `image/webp`. The
earlier `image/` prefix test admitted `image/svg+xml`, which the Worker would
then serve back from its own origin under that content-type — and an SVG can
carry script. The CSP blocks it (`script-src 'self'`, no `unsafe-inline`), but
that left the defence resting on a single policy line.

Encrypted progress photos skip the check, because ciphertext has no meaningful
content-type; they are stored as `application/octet-stream` under an `.enc` key.

### Security headers

Set on every response, assets included. `Referrer-Policy: same-origin` is the important one — without it, following an external link would leak a `/progress-photos/<uuid>` URL into another site's logs. The CSP allows `style-src 'unsafe-inline'` for React style attributes and the login page's inline block, and allowlists the Google Fonts hosts that `styles.css` imports.

### What is *not* protected

Passphrase strength is the whole ballgame, and the Cloudflare account outranks everything in this repo — it holds the database, the images, and both secrets.

---

## 7. Time and the Argentine domain

`shared/time.ts` owns every date decision. **Never use the client clock for diary dates.** "Today" is computed from `settings.timezone` (default `America/Buenos_Aires`) on the server; a meal logged at 01:00 belongs to the Argentine day, not the UTC one.

Meal categories follow the national GAPA pattern — four standard meals plus one discretionary:

| stored value | Spanish | typical window |
| --- | --- | --- |
| `Breakfast` | desayuno | 05:00–11:00 |
| `Lunch` | almuerzo | 11:00–15:30 |
| `Merienda` | *(no English equivalent)* | 15:30–19:30 |
| `Dinner` | cena | 19:30–02:00 |
| `Treat` | antojo | any time |

**Merienda is a real meal, not a snack.** Mate with facturas at 17:30 is a merienda; `Treat` is reserved for a standalone sweet. Food composition beats the clock — an alfajor at 19:00 can still read as merienda, while milanesa at the same hour is dinner. Tests cover these cases.

The enum is duplicated in four places by necessity: `shared/analysis-core.ts`, the Zod schema in `worker/index.ts`, the OpenRouter JSON schema, and `src/types.ts`. Change one, change all four.

---

## 8. Platform constraints that shaped the code

These are not trivia; several design decisions exist only because of them.

| limit | free tier | consequence |
| --- | --- | --- |
| Worker CPU | **10 ms per request** | image base64 uses native `Buffer` via `nodejs_compat`; the browser downscales to 1600px before upload |
| Worker requests | 100k/day | ample for one user |
| Subrequests | 50/request | one OpenRouter call, no fan-out |
| D1 | 5 GB, 5M reads/day, 100k writes/day | rate limiting lives here, not KV |
| KV | 1 GB, 100k reads/day, **1,000 writes/day** | images only; never use KV for counters |
| Cron | 1 minute granularity | reminders are minute-accurate |

Workers cannot hold a long-lived loop, which is why Telegram is a **webhook** rather than polling, and reminders run from a **cron trigger** deduped by a unique index on `sent_reminders.reminder_key`.

---

## 9. Deploying

```bash
pnpm run deploy
```

That runs `pnpm check`, `vite build`, then `wrangler deploy`. **The `run` is not optional** — `deploy` is also a built-in pnpm command (deploy a workspace package to a directory), and the built-in wins over a script of the same name, so bare `pnpm deploy` never reaches this script.

### The versions trap — read this

This Worker is managed as **versions**. `wrangler secret put` fails with *"the latest version of your Worker isn't currently deployed"*. The versioned form works but **creates a version without rolling it out**:

```bash
npx wrangler versions secret put PHOTO_PASSPHRASE
```

```bash
npx wrangler versions deploy PASTE_THE_PRINTED_ID@100% --yes
```

The id and `@100%` are **one token with no space**. `wrangler secret list` shows secrets from the newest version, so a secret can look configured while the running code cannot see it. This caused three separate "it's still not working" incidents.

**The dashboard — Workers & Pages → macroflow → Settings → Variables and Secrets — saves and deploys in one step and avoids all of it.**

### Secrets

| name | required | purpose |
| --- | --- | --- |
| `APP_PASSWORD` | **yes** | app login; without it the Worker fails closed |
| `PHOTO_PASSPHRASE` | no | body photos; falls back to `APP_PASSWORD` |
| `OPENROUTER_API_KEY` | for AI | can also be set in the UI, stored in D1 |
| `TELEGRAM_WEBHOOK_SECRET` | for Telegram | webhook returns 503 without it |

Migrations are separate from deploys and must be applied explicitly:

```bash
pnpm d1:migrate
```

```bash
pnpm d1:migrate:local
```

---

## 10. Testing and verification

```bash
pnpm check
```

```bash
pnpm test
```

```bash
pnpm tail
```

`pnpm check` typechecks the app *and* the Worker (`tsconfig.worker.json`). `pnpm test` runs 25 vitest tests covering the pure core in `shared/`: prompt content, the fibre clamp, Argentine meal typing, confidence calibration, and range aggregation.

There is **no automated coverage of the Worker's HTTP layer** — routes, auth, and D1 are verified by hand against `wrangler dev`. If you touch auth or the photo lock, exercise at minimum:

- signed out: app shell, `/api/*`, `/uploads/*`, `/progress-photos/*`
- signed in but locked: photo list and images both 403
- forged, expired, and session-replayed unlock cookies all rejected
- delete removes the D1 row *and* the KV object

`scripts/pull-live-ui.mjs` downloads the deployed front end (it prompts for the passphrase and never stores it) when you need to inspect what is actually running.

---

## 11. Known gaps and dead code

Be honest about these rather than rediscovering them.

- **`push_subscriptions` — empty, non-functional.** Web Push needs a registered service worker; there is none, and no VAPID keys. Either build it properly or drop the table.
- **`reports` — empty, no client code anywhere.** A table designed for cached AI period reports that were never built.
- **`server/` is local-only research tooling.** The Nutrition5k benchmark and `scripts/test-single-photo-pipeline.ts` run against local SQLite. Not deployed: it needs roughly 7 MB of dataset images and a local Python depth model. It imports `shared/` so its prompt matches production exactly.
- **`src/screens/BenchmarkLab.tsx` is orphaned** — never imported.
- **Deleting a meal deletes a photo that a duplicated meal still references**, leaving a broken thumbnail. Pre-existing.
- **No per-device session revocation.** Rotating `APP_PASSWORD` signs out everything, which is the only lever.

---

## 12. Invariants — do not break these

1. **`run_worker_first: true`.** Assets must never be served ahead of auth, with
   the single exception of `PUBLIC_ASSETS` — the manifest and PWA icons, which
   the OS must fetch signed out. Nothing that reads the diary goes in that list.
2. **`workers_dev: false`.** A `*.workers.dev` route would bypass any hostname-level protection such as Cloudflare Access.
3. **Fibre ≤ carbs**, always, whatever the model says.
4. **The plate number is a diameter.** Not a square, radius, or area.
5. **Photo routes return 403 when locked**, never 401. **No photo key material
   reaches the Worker** — only hashes and wrapped blobs. If a change makes the
   server able to decrypt a photo, the feature is broken.
6. **Fail closed.** No `APP_PASSWORD` → the app is unusable, not open. No `TELEGRAM_WEBHOOK_SECRET` → the webhook is 503, not unauthenticated.
7. **Diary dates come from `settings.timezone`**, never the client clock.
8. **Never commit secrets.** `.dev.vars` is gitignored; `.dev.vars.example` documents the names only.
9. **The meal-type enum is duplicated in four places.** Keep them in sync.

---

## 13. Footguns

Things that have actually cost hours on this project.

- **`dist/` is gitignored.** Hand-added files there vanish on the next build and are invisible to `git status`. An entire feature was once implemented as a script dropped into `dist/` and injected into `index.html`; it survived only because it was still deployed. **Static files belong in `public/`**, which Vite copies into `dist/` on every build.
- **Deploying overwrites whatever is live.** If work exists only in Cloudflare — edited in the dashboard, or built on another machine — `pnpm deploy` destroys it. Confirm the repo is the source of truth first.
- **A stale `wrangler dev` on :8787 serves old code.** Vite proxies `/api` there, so backend edits appear to do nothing. Check what owns the port and when it started.
- **`wrangler versions secret put` does not deploy.** See §9.
- **`pnpm deploy` does not run the deploy script.** pnpm has its own `deploy` built-in and it shadows the script; you need `pnpm run deploy`. Every other script name in `package.json` is free of collisions.
- **PowerShell is not bash, and this project is developed on Windows.** Three
  shapes of copied command have failed here:
  - `<` is reserved, so any `<placeholder>` fails before wrangler runs.
  - `&&` is not a valid separator in Windows PowerShell 5.1. Use `;`, or
    `A; if ($?) { B }` when the second command depends on the first.
  - `curl` is an **alias for `Invoke-WebRequest`**, which has no `-X` parameter,
    so `curl -X POST …` dies with *"no parameter matches -X"*. Use
    `Invoke-RestMethod -Method Post -Uri …`, or call `curl.exe` explicitly.
  - `openssl` is not installed. Node is, so use it for random secrets:
    `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Do not reach for `Get-Random`, which is not a CSPRNG.
  - Snippets starting `await fetch(...)` are **browser** JavaScript for the
    devtools console, not shell commands. They need the session cookie, which
    only the browser has.
- **A saved Telegram token and chat id do not mean Telegram works.** Without
  `TELEGRAM_WEBHOOK_SECRET` the webhook answers 503 to every update, and nothing
  outside Telegram's own `getWebhookInfo` reports it — this deployment sat that
  way unnoticed. Settings → Telegram now shows the real delivery state and has a
  **Register webhook** button, so neither the shell nor the devtools console is
  needed. Registering without the secret is refused rather than silently
  creating a dead webhook.
- **Do not reuse the photo prompt for text-only meals**, or the reverse.
- **`capture="environment"` means camera-only on iOS.** Offering the gallery needs a second `<input>` without the attribute. That is why there are two.
- **A control under 16px makes iOS zoom the page in when you focus it.** Safari ignores `maximum-scale`, so the viewport meta does not stop it, and because pinch is locked (`src/lockZoom.ts`) there is no way back out — the app stays magnified until a reload. Any new `<input>`, `<select>` or `<textarea>` needs 16px on touch; the guard is the `@media (pointer: coarse)` block at the end of `src/styles.css`, and the login page in `worker/auth.ts` carries its own copy.

---

## 14. Decision log

Why things are the way they are, so they do not get undone by accident.

| decision | reason |
| --- | --- |
| One Worker serves API and SPA | auth must cover the app shell, not just `/api` |
| `shared/` core | the prompt and macro maths drifted when duplicated |
| Argentine categories including Merienda | the user is Argentine; merienda is a real meal |
| AI meal type overrides the tapped slot | the model sees the food; the tap is a guess |
| Fibre clamped to carbs | prevents inflated carb totals on high-fibre meals |
| Photo unlock separate from login | body photos are more sensitive than macros |
| Body photos encrypted in the browser | a passphrase gate is access control, not secrecy; the storage layer could still read them |
| Master key wrapped twice, not derived per photo | lets the recovery key work without the passphrase, and makes a passphrase change a re-wrap rather than a re-encrypt |
| Progress photos served `no-store` | a year-long immutable cache left the bytes on the device long after the unlock lapsed |
| Global rate limit on photo unlock | a short PIN makes per-IP limits meaningless |
| Progress photos as their own nav item | superseded the original call to keep them in the Progress tab: a passphrase-gated section reads as a destination, not a card halfway down a scroll. The bottom nav is five equal cells with Scan in the middle, which is what keeps it centred — a sixth item breaks that |
| Progress photos rebuilt in React | the vanilla version guessed the theme by scanning the DOM and fought React over the nav |
| EXIF stripped via canvas re-encode | iPhone photos carry GPS and nothing upstream removes it |
| Telegram webhook, not polling | Workers cannot hold a loop |
| Benchmark lab not deployed | needs local Python and 7 MB of dataset images |
| Page zoom locked on touch | the app was being pinch-zoomed like a photo by accident; iOS ignores `user-scalable=no`, so `src/lockZoom.ts` cancels its gesture events as well |
| Form controls forced to 16px on touch | locking pinch removed the escape from iOS focus zoom, so the zoom has to be prevented rather than undone |

---

## 15. Where to look first

| task | start here |
| --- | --- |
| change what the model is asked | `shared/analysis-core.ts` |
| add an endpoint | `worker/index.ts` |
| change auth or the photo lock | `worker/auth.ts` |
| change the diary UI | `src/screens/Today.tsx`, `src/components/LogModal.tsx` |
| change the food catalogue | `shared/seed.ts`, then `pnpm d1:seed` and migrate |
| add a table | new file in `migrations/`, then `pnpm d1:migrate` |
| debug production | `pnpm tail`, then `wrangler d1 execute macroflow --remote` |
