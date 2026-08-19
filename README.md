# Macroflow

Macroflow is a personal macro tracker built for an iPhone camera, running entirely on Cloudflare's free tier at [macro.montagnertudor.org](https://macro.montagnertudor.org). It combines an editable food diary, OpenRouter vision analysis, correction chat, reusable meal memories, progress tracking, and Telegram reminders in one web app.

## What it does

- Camera-first one-photo meal logging on iPhone (`capture="environment"`)
- Photo analysis, or **describe what you ate in plain language** and get an estimate with no photo at all
- English/Spanish food matching when AI is unavailable
- Editable portions and macros before anything is saved
- Chat corrections such as “I always bake this milanesa with sunflower oil”
- Persistent meal memories reused by future OpenRouter analyses when relevant
- Manual food search, direct macro entry, repeat meal, and delete
- **My foods**: the full searchable record of everything you have logged, to repeat any of it
- Quick add remembers your recent entries for one-tap repeats
- Automatic Argentine meal category: desayuno, almuerzo, merienda, cena or antojo
- Daily calories, protein, carbs, fat and **fibre**, 30-day progress, and weight check-ins
- Telegram reminders, daily totals, and `/log` text logging
- D1 persistence, KV image storage, and full JSON export
- Server-authoritative “today” using your configured IANA timezone
- An optional 25 cm flat round plate reference, capture-quality checks, honest ranges, and explicit assumptions before confirmation

This is not a medical device. Food-photo macros are estimates; review the portion and ingredients before saving.

## Where your data lives

Macroflow used to be local-first, with SQLite and photos on a home server. It now runs on Cloudflare, so **your diary, your meal photos, and your OpenRouter key live in your Cloudflare account**, not on your machine:

| Piece | Service | Free-tier allowance |
| --- | --- | --- |
| API + static app | Workers | 100,000 requests/day, 10 ms CPU per request |
| Diary database | D1 | 5 GB, 5M row reads/day, 100k row writes/day |
| Meal photos | Workers KV | 1 GB, 1,000 writes/day, 100,000 reads/day |
| Reminders | Cron Triggers | included |
| Login | passphrase in the Worker | included |

Everything is behind a passphrase login (see below). The Worker runs before the static assets on every path, so the app shell, the API, and the meal photos are all gated — a signed-out visitor gets the login page and nothing else.

## Requirements

- [Node.js 22 or newer](https://nodejs.org/) and [pnpm](https://pnpm.io/installation)
- A Cloudflare account with `montagnertudor.org` on its nameservers
- An [OpenRouter API key](https://openrouter.ai/settings/keys) for photo analysis and AI correction chat
- Optional: a Telegram bot created with [@BotFather](https://t.me/BotFather)

## Deploy

Every step is CLI. Wrangler is a local devDependency rather than a global install, so each command needs the `npx` prefix — a bare `wrangler …` will fail with "not recognized". Wrangler opens a browser once for you to approve the login.

```bash
pnpm install
npx wrangler login
```

**1. Create the database and the photo store.** Copy each id that gets printed into `wrangler.jsonc`, replacing the two `PLACEHOLDER_…` values.

```bash
npx wrangler d1 create macroflow
```

```bash
npx wrangler kv namespace create PHOTOS
```

**2. Create the tables and seed the food list.**

```bash
pnpm d1:migrate
```

**3. Add your secrets.** Each command prompts for the value; nothing is written to the repo.

Because this Worker is deployed as **versions**, plain `wrangler secret put` fails with *"the latest version of your Worker isn't currently deployed"*. Use the versioned form, which prints a new version id:

```bash
npx wrangler versions secret put APP_PASSWORD
```

Then roll that version out — `--yes` alone is not enough, the id is required:

```bash
npx wrangler versions deploy <version-id-printed-above>@100% --yes
```

Repeat for the other two secrets (you can set both, then deploy once):

```bash
npx wrangler versions secret put OPENROUTER_API_KEY
```

```bash
npx wrangler versions secret put TELEGRAM_WEBHOOK_SECRET
```

```bash
npx wrangler versions secret put PHOTO_PASSPHRASE
```

The dashboard is a fine alternative: **Workers & Pages → macroflow → Settings → Variables and Secrets**, which deploys on save.

**4. Build and deploy.**

```bash
pnpm deploy
```

**5. Point the domain at the Worker.** `wrangler.jsonc` already declares `macro.montagnertudor.org` as a custom domain, so the deploy creates the DNS record and certificate. Verify:

```bash
npx wrangler deployments list
```

**6. Bring your existing diary across** (optional — skip for a fresh start). This reads `data/macroflow.db`, writes `tmp/d1-import.sql`, and generates one `npx wrangler kv key put` command per meal photo.

```bash
pnpm d1:export-local
```

```bash
npx wrangler d1 execute macroflow --remote --file tmp/d1-import.sql
```

Then run the commands in `tmp/kv-photos/upload.sh` to push the photos into KV.

**7. Set the login passphrase** (step 3 above, if you skipped it). Until it exists the Worker fails closed: every page returns the login screen and every API call returns 503, so the diary is never public while unconfigured.

**8. Connect Telegram** (optional). After saving the bot token in Settings, register the webhook — Workers cannot long-poll, so Telegram pushes updates instead:

```bash
curl -X POST https://macro.montagnertudor.org/api/telegram/webhook/register
```

## Develop locally

```bash
cp .dev.vars.example .dev.vars
```

Add your OpenRouter key to `.dev.vars`, create the local database, then start the Worker and Vite together:

```bash
pnpm d1:migrate:local
```

```bash
pnpm dev
```

Vite serves the app at [http://localhost:5173](http://localhost:5173) with HMR and proxies `/api` to `wrangler dev` on port 8787. The local D1 and KV are emulated under `.wrangler/` — a throwaway copy, never your production data. `pnpm d1:export-local` plus `wrangler d1 execute macroflow --local --file tmp/d1-import.sql` fills it with realistic rows.

To watch production logs:

```bash
pnpm tail
```

## Login

One passphrase, stored only as the `APP_PASSWORD` Worker secret. Signing in sets an HMAC-signed cookie that lasts 30 days; there is no session table, because the signature is verified with a key derived from the passphrase itself. Rotating the passphrase therefore signs every device out.

- The Worker runs before static assets on **every** path, so the app shell, `/api/*` and `/uploads/*` are all gated.
- Three paths stay public by design: `/api/health` (a liveness probe that exposes no diary data), `/api/auth/login`, and `/api/telegram/webhook` — Telegram's servers cannot send a cookie, so that endpoint authenticates with the `x-telegram-bot-api-secret-token` header instead.
- Eight wrong attempts from one IP triggers a 15-minute lockout, tracked in the `login_attempts` table. During a lockout even the correct passphrase is refused.
- With no `APP_PASSWORD` set, the Worker fails closed rather than open.
- Sign out from **Settings → Sign out**. An expired session makes the app reload straight to the login screen.

To change the passphrase, run `npx wrangler versions secret put APP_PASSWORD` and deploy the version it prints. Every signed-in device is signed out, because the session signing key is derived from the passphrase.

If you would rather use a real identity provider with MFA, Cloudflare Access (free up to 50 users) can sit in front of the same Worker: **Zero Trust → Access → Applications → Add a self-hosted app** for `macro.montagnertudor.org`. The passphrase gate keeps working underneath it.

## Open it on your iPhone

Visit [macro.montagnertudor.org](https://macro.montagnertudor.org) in Safari, sign in, then use the Share button → **Add to Home Screen** for an app-like launcher.

Mobile Safari will offer the rear camera when you tap **Take photo**, or the photo library via **Choose from gallery** — iOS treats the `capture` attribute as camera-only, so each route needs its own control. Use the `1×` camera, photograph the plate from about 45 degrees, and keep the full outer rim visible. The product intentionally uses one ordinary RGB photo, your saved plate size, editable portions, and learned preparation memories.

## The plate reference

Your saved plate size is a **diameter**: the distance straight across the whole round plate, rim to rim. A 25 cm plate is 25 cm across — it is not 25 × 25, and it is not a radius or an area. Set it once in **Settings → Flat round plate · diameter**; the analysis prompt states the number as an edge-to-edge diameter and refuses to treat it as a square.

The plate is only useful when the complete outer rim is in frame, so every scan lets you turn it off:

- **My 25 cm plate** — the model may convert the visible ellipse into real-world centimetres, but only if the whole rim is genuinely visible and matches.
- **No size reference** — for a different plate, a bowl, a pan, a wrapper, or a cropped rim. The model is told not to convert pixels to centimetres at all and falls back to familiar serving sizes with a wider uncertainty range.

Whatever you pick, the review screen reports whether the plate was actually used as scale, and confidence is capped when it was not.

## Logging without a photo

Forgot to photograph something? Open **Log a meal → AI**, skip the camera, and write what you ate: *“milanesa con puré y una coca, y de postre un alfajor”*. The button changes to **Estimate from description** and the model breaks it into items with macros, fibre and an Argentine meal category, exactly as a photo would.

This takes a different prompt from the photo path, not the same one with the image missing. Estimating from a sentence is recall of typical servings rather than reading geometry off a plate, so the description prompt never claims to have seen anything, converts vague amounts honestly (*“un plato de fideos”* is a normal plated portion), and quotes your own words as the evidence for each item.

Because nothing was seen, **the ranges are deliberately wider**: the server floors the spread at 40% either side of each estimate unless you stated a weight. Quantities tighten it — “dos huevos”, “200g de pollo” — but are never required. Correct anything in the chat afterwards and it re-estimates.

## Progress photos

**Progress → Progress photos.** Front, side and back poses, added from the **camera or the photo library**, grouped by the day they were taken, plus a Compare view putting your first and latest of a pose side by side. Your latest weight check-in is attached automatically. Photos are downscaled to 1600px and re-encoded through a canvas, which strips the EXIF block — iPhone photos carry GPS coordinates there and nothing upstream removes them.

They sit behind **a second passphrase**, set as its own `PHOTO_PASSPHRASE` Worker secret and independent of the one that signs you in — knowing the app passphrase does not open the photos, and the photo passphrase cannot sign you in. If `PHOTO_PASSPHRASE` is unset it falls back to `APP_PASSWORD`. This check is separate from the 30-day session. Being signed in is not enough: without a valid unlock the Worker refuses to list the photos or serve a single image, so this is not a blur that devtools defeats. The unlock lasts 15 minutes, is dropped when the browser closes, and ends immediately when you press **Lock**. It is signed with a different key from the session cookie, so a session cookie cannot be replayed as an unlock. Failed unlock attempts are rate-limited two ways: 8 per IP per 15 minutes, and — because a short PIN has a tiny keyspace that per-IP limits do nothing to protect — **20 failures globally per hour**, across every address at once. Both are keyed separately from sign-in, so fumbling here can never lock you out of the app. The trade-off is that anyone who can reach the endpoint can deliberately exhaust the global budget and seal the photos for an hour; the limit is set high enough that ordinary mistyping never trips it.

Every response also carries `Content-Security-Policy`, `Referrer-Policy: same-origin`, `X-Content-Type-Options`, `Cross-Origin-Resource-Policy` and `Permissions-Policy`. The referrer policy is the one that matters most for photos: without it, following an external link would put a `/progress-photos/<uuid>` URL into someone else's logs.

## My foods

Every food you log is kept, whatever route it arrived by — photo analysis, catalogue search, or quick add. **Log a meal → My foods** is the whole record: searchable, ordered by how often you have eaten each one, showing the portion, the calories, how many times you have logged it, and since when.

Tapping an entry puts it on a plate you can build up and adjust before saving, exactly like the food catalogue. Portions rescale proportionally, so pulling in a 200 g milanesa and changing it to 150 g scales the macros with it. Entries recorded without a weight — hand-typed quick adds — carry totals rather than a rate, so those cannot rescale; edit the numbers instead.

This is deliberately separate from the short **Add again** list inside Quick add, which is only the handful of things you logged most recently.

## Fibre

Every food carries a fibre figure and the model estimates it for anything it recognises from a photo. Fibre appears as a fourth ring on the diary, in the review screen's estimate summary, in the `/today` Telegram reply, and as its own daily target in Settings.

**Fibre is a component of carbohydrate, not an addition to it.** A food with 30 g carbs of which 5 g is fibre still counts as 30 g carbs. The prompt states this explicitly and the server clamps any model answer so `fiber` can never exceed `carbs` — without that, carb totals inflate on high-fibre meals. Calories are unaffected.

The onboarding target starts at 14 g per 1,000 kcal with a floor of 25 g, matching Argentine GAPA guidance; change it any time in **Settings → Daily targets**.

Meals logged before this feature existed show 0 g fibre — the value was never recorded, and back-filling it would be inventing data.

## Argentine meal categories

Meals are filed with the four standard GAPA meals plus one discretionary category: **Breakfast** (desayuno), **Lunch** (almuerzo), **Merienda**, **Dinner** (cena) and **Treat** (antojo). Merienda is a real meal here, so a mate with facturas at 17:30 is not filed as a treat; Treat is reserved for a standalone sweet or antojo.

The category is chosen automatically. Food composition and your note count for more than the clock, with the diary's local time as a prior — so an alfajor at 19:00 can still be read as a merienda, while milanesa at the same hour is dinner. When OpenRouter is configured the model decides and explains itself in one line; otherwise the same Argentine time bands and food patterns run locally. The verdict is applied after analysis, and the review screen shows the reason with a dropdown to overrule it before saving.

## Connect Telegram

1. Message [@BotFather](https://t.me/BotFather), run `/newbot`, and copy the token.
2. In Macroflow → **Settings**, paste the bot token and save.
3. Register the webhook (see deploy step 8), then message your bot `/start`; Macroflow stores that private chat ID.
4. Refresh Settings, enable the reminder times you want, and press **Send test**.

Supported commands:

- `/today` or `/remaining` — show today's totals
- `/log 200g milanesa de pollo, 150g arroz` — log a text-described meal
- `/help` — show commands

Reminders fire from a cron trigger that runs every minute and compares your reminder times against the diary timezone. A unique index on `reminder_key` is what stops the same reminder going out twice.

## How meal memory works

Macroflow does not retrain the OpenRouter model. It stores concise facts in the `meal_memories` table—for example, `Chicken milanesa: usually baked with 10 g sunflower oil`. On a later scan, relevant memories are included as private context and the model must report which ones it applied. You can inspect or delete every memory in Settings.

If OpenRouter is unavailable, a small correction parser can still remember common preparation notes involving oils, oven cooking, frying, homemade food, and “always/usually” phrasing.

## Layout

```
src/       React app (Vite)
worker/    the deployed backend — Hono routes, D1, KV, Telegram webhook, cron
shared/    analysis-core.ts, time.ts, seed.ts — imported by both worker/ and server/
migrations/ D1 schema and the generated food seed
server/    local-only research tooling (SQLite): benchmark runner and pipeline test
```

`shared/analysis-core.ts` holds the prompt, the Argentine meal-type rules, and the uncertainty maths with no database or runtime dependency, so the deployed Worker and the local benchmark cannot drift apart.

## Accuracy research

The product UI stays focused on logging. The weighed Nutrition5k benchmark, depth experiments, prompts, and results remain available internally in [docs/NUTRITION_VISION_RESEARCH.md](docs/NUTRITION_VISION_RESEARCH.md) and `data/benchmark/`. The lab is deliberately **not** deployed: it needs ~7 MB of dataset images and shells out to a local Python depth model, which Workers cannot run. It still runs locally against `data/macroflow.db` through `server/`.

The production app uses one RGB photo, a known 25 cm plate diameter when its complete rim is visible and you did not switch the reference off, low model reasoning, personal recipe memories, and editable estimates. In the bundled three-plate smoke test, `google/gemini-3.6-flash` with the one-photo pipeline produced 43.1 kcal calorie MAE, 30.3 g mass MAE, and 4.8 g macro MAE at about $0.0047 per analysis. This sample is too small to claim general accuracy; use the displayed uncertainty range and confirm high-impact assumptions.

## Data and backup

- Diary: D1 database `macroflow`
- Meal photos: KV namespace `PHOTOS`, keyed `uploads/<uuid>.jpg`
- Downloadable backup: Settings → **Export all data**

For an offline copy of the database:

```bash
npx wrangler d1 export macroflow --remote --output backup.sql
```

API keys are Worker secrets and are excluded from exports.

## Verification

```bash
pnpm check
```

```bash
pnpm test
```

```bash
pnpm build
```
