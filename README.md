# Macroflow

Macroflow is a local-first macro tracker designed for an iPhone camera and a private home server. It combines an editable food diary, OpenRouter vision analysis, correction chat, reusable meal memories, progress tracking, and Telegram reminders in one web app.

## What the MVP does

- Camera-first one-photo meal logging on iPhone (`capture="environment"`)
- Photo + text analysis through one OpenRouter vision model
- Local English/Spanish food matching when AI is unavailable
- Editable portions and macros before anything is saved
- Chat corrections such as “I always bake this milanesa with sunflower oil”
- Persistent meal memories reused by future OpenRouter analyses when relevant
- Manual food search, direct macro entry, repeat meal, and delete
- Automatic Argentine meal category: desayuno, almuerzo, merienda, cena or antojo
- Daily calories/macros, 30-day progress, and weight check-ins
- Telegram reminders, daily totals, and `/log` text logging
- SQLite persistence, local image storage, and full JSON export
- Server-authoritative “today” using your configured IANA timezone
- An optional 25 cm flat round plate reference, capture-quality checks, honest ranges, and explicit assumptions before confirmation

This is not a medical device. Food-photo macros are estimates; review the portion and ingredients before saving.

## Requirements

- [Node.js 22 or newer](https://nodejs.org/) (the app uses Node's built-in SQLite API)
- [pnpm](https://pnpm.io/installation)
- An [OpenRouter API key](https://openrouter.ai/settings/keys) for photo analysis and AI correction chat
- Optional: a Telegram bot created with [@BotFather](https://t.me/BotFather)

## Run locally

```powershell
cd C:\Users\agust\Desktop\macros
Copy-Item .env.example .env
```

Open `.env` and add your OpenRouter key:

```dotenv
OPENROUTER_API_KEY=sk-or-v1-your-real-key
OPENROUTER_MODEL=google/gemini-3.6-flash
APP_URL=http://localhost:5173
```

Then install and start both the API and the web app:

```powershell
pnpm install
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). Your key remains on the server and is never sent to the browser.

If an API key was pasted into a chat, terminal recording, screenshot, or public issue, revoke it and create a new one before adding it to `.env`.

## Open it on your iPhone 13 Pro

1. Keep the computer and iPhone on the same Wi-Fi network.
2. Find the computer's local IPv4 address with `ipconfig` (for example `192.168.1.20`).
3. Set `APP_URL=http://192.168.1.20:5173` in `.env`, then restart `pnpm dev`.
4. In iPhone Safari, open `http://192.168.1.20:5173`.
5. Use Safari's Share button → **Add to Home Screen** for an app-like launcher.

Windows may ask you to allow Node.js through the firewall on private networks. Do not port-forward this MVP or expose it directly to the public internet; it does not include multi-user authentication yet.

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
3. Message your new bot `/start`; Macroflow stores that private chat ID.
4. Refresh Settings, enable the reminder times you want, and press **Send test**.

Supported commands:

- `/today` or `/remaining` — show today's totals
- `/log 200g milanesa de pollo, 150g arroz` — log a text-described meal
- `/help` — show commands

The local server must be running for polling and reminders to work. Telegram polling does not require a public webhook.

## How meal memory works

Macroflow does not retrain the OpenRouter model. It stores concise facts in the local `meal_memories` table—for example, `Chicken milanesa: usually baked with 10 g sunflower oil`. On a later scan, relevant memories are included as private context and the model must report which ones it applied. You can inspect or delete every memory in Settings.

If OpenRouter is unavailable, a small local correction parser can still remember common preparation notes involving oils, oven cooking, frying, homemade food, and “always/usually” phrasing.

## Accuracy research

The product UI stays focused on logging. The weighed Nutrition5k benchmark, depth experiments, prompts, and results remain available internally in [docs/NUTRITION_VISION_RESEARCH.md](docs/NUTRITION_VISION_RESEARCH.md) and `data/benchmark/` so future model changes can still be evaluated without exposing research controls in the daily app.

The production MVP uses one RGB photo, a known 25 cm plate diameter when its complete rim is visible and you did not switch the reference off, low model reasoning, personal recipe memories, and editable estimates. In the bundled three-plate smoke test, `google/gemini-3.6-flash` with the one-photo pipeline produced 43.1 kcal calorie MAE, 30.3 g mass MAE, and 4.8 g macro MAE at about $0.0047 per analysis. This sample is too small to claim general accuracy; use the displayed uncertainty range and confirm high-impact assumptions.

## Data and backup

- Database: `data/macroflow.db`
- Uploaded meal photos: `data/uploads/`
- Downloadable backup: Settings → **Export all data**

Back up the database and upload directory together while the server is stopped. API keys are read from `.env`; the OpenRouter key is excluded from exports.

## Production-style local server

```powershell
pnpm build
pnpm start
```

This serves the built frontend and API together at [http://localhost:8787](http://localhost:8787). For iPhone access in this mode, set `APP_URL` to `http://YOUR-LAN-IP:8787`.

## Verification

```powershell
pnpm check
pnpm test
pnpm build
```
