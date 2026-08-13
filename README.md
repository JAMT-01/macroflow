# Macroflow

Macroflow is a personal macro tracker built for an iPhone camera, running entirely on Cloudflare's free tier at [macro.montagnertudor.org](https://macro.montagnertudor.org). It combines an editable food diary, OpenRouter vision analysis, correction chat, reusable meal memories, progress tracking, and Telegram reminders in one web app.

## What it does

- Camera-first one-photo meal logging on iPhone (`capture="environment"`)
- Photo + text analysis through one OpenRouter vision model
- English/Spanish food matching when AI is unavailable
- Editable portions and macros before anything is saved
- Chat corrections such as “I always bake this milanesa with sunflower oil”
- Persistent meal memories reused by future OpenRouter analyses when relevant
- Manual food search, direct macro entry, repeat meal, and delete
- Automatic Argentine meal category: desayuno, almuerzo, merienda, cena or antojo
- Daily calories/macros, 30-day progress, and weight check-ins
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
| Login | Cloudflare Access | free up to 50 users |

**The app has no authentication of its own.** Anyone who can reach the URL can read the diary, view the photos, log meals, and spend your OpenRouter credits. Cloudflare Access is what stops that — do not skip step 7 below.

## Requirements

- [Node.js 22 or newer](https://nodejs.org/) and [pnpm](https://pnpm.io/installation)
- A Cloudflare account with `montagnertudor.org` on its nameservers
- An [OpenRouter API key](https://openrouter.ai/settings/keys) for photo analysis and AI correction chat
- Optional: a Telegram bot created with [@BotFather](https://t.me/BotFather)

## Deploy

Every step is CLI. Wrangler opens a browser once for you to approve the login.

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

```bash
npx wrangler secret put OPENROUTER_API_KEY
```

```bash
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

**4. Build and deploy.**

```bash
pnpm deploy
```

**5. Point the domain at the Worker.** `wrangler.jsonc` already declares `macro.montagnertudor.org` as a custom domain, so the deploy creates the DNS record and certificate. Verify:

```bash
npx wrangler deployments list
```

**6. Bring your existing diary across** (optional — skip for a fresh start). This reads `data/macroflow.db`, writes `tmp/d1-import.sql`, and generates one `wrangler kv key put` command per meal photo.

```bash
pnpm d1:export-local
```

```bash
npx wrangler d1 execute macroflow --remote --file tmp/d1-import.sql
```

Then run the commands in `tmp/kv-photos/upload.sh` to push the photos into KV.

**7. Put a login in front of it.** In the Cloudflare dashboard, go to **Zero Trust → Access → Applications**, add a self-hosted application for `macro.montagnertudor.org`, and add a policy allowing your email. Until this exists, the app is public to anyone with the URL.

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

## Open it on your iPhone

Visit [macro.montagnertudor.org](https://macro.montagnertudor.org) in Safari, sign in through Cloudflare Access, then use the Share button → **Add to Home Screen** for an app-like launcher.

Mobile Safari will offer the rear camera when you tap **Take photo**. Use the `1×` camera, photograph the plate from about 45 degrees, and keep the full outer rim visible. The product intentionally uses one ordinary RGB photo, your saved plate size, editable portions, and learned preparation memories.

## The plate reference

Your saved plate size is a **diameter**: the distance straight across the whole round plate, rim to rim. A 25 cm plate is 25 cm across — it is not 25 × 25, and it is not a radius or an area. Set it once in **Settings → Flat round plate · diameter**; the analysis prompt states the number as an edge-to-edge diameter and refuses to treat it as a square.

The plate is only useful when the complete outer rim is in frame, so every scan lets you turn it off:

- **My 25 cm plate** — the model may convert the visible ellipse into real-world centimetres, but only if the whole rim is genuinely visible and matches.
- **No size reference** — for a different plate, a bowl, a pan, a wrapper, or a cropped rim. The model is told not to convert pixels to centimetres at all and falls back to familiar serving sizes with a wider uncertainty range.

Whatever you pick, the review screen reports whether the plate was actually used as scale, and confidence is capped when it was not.

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
