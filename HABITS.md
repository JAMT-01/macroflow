# Habits — daily streaks, and a Telegram reminder that answers back

Habit tracking for MacroFlow: one tap a day, a streak, and a reminder over
Telegram you can reply `/done` to without opening the app.

Built 2026-08-27 around the habit that prompted it — **walk 10 km**, day 1 on
2026-08-26.

| Piece | Status |
|---|---|
| `migrations/0008_habits.sql` | **applied** 2026-08-27 (§3) |
| `worker/habits.ts` — storage, streaks, check-ins | written, tested (§6) |
| `worker/habit-reminders.ts` — cron dispatch + bot commands | written, tested (§6) |
| `worker/habits-assets.ts` — injected UI | driven against the real built app (§6, §10) |
| Wiring in `tools/build-worker.mjs` | done |
| Deployed | **yes** — version `58e4b544` (§7, §10–§12) |

**Live since 2026-08-27.** The migration is applied and the Worker is promoted
to 100%.

The first deploy (`66468e1a`) **broke the app's bottom nav** — it was built
against a stale screenshot description instead of the real frontend, which is in
this repo. Fixed in `2bfb19e7`; the full account is in §10, and it is the part of
this document most worth reading before touching injected UI again.

The bot is connected and reminders are going out. The one thing still missing is
the **Telegram webhook registration**, without which replies (`/done`, `/habits`,
`/undo`) never reach the Worker — see §4.

---

## 1. What it does

**In the app.** A **Habits** tab in the bottom nav opens a sheet listing each
habit with a big check circle, the day counter, the current and best streak, and
a ten-week dot grid. Tapping the circle logs today. A habit with a target
("10 km") records that number by default and lets you correct it afterwards.
Per-habit settings hold the reminder time; new habits are added from the same
sheet.

**Over Telegram.** At the habit's reminder time the bot sends:

> 🚶 **Walk 10 km** (10 km)
> Day 3 · 2 days on the line.
> Reply `/done` when it is in — or `/done 10.4` to record the actual km.

and `/done` checks the day off. Also `/habits` for every streak and what is left
today, and `/undo` to take back today's check-in.

**The reminder is suppressed if the habit is already done.** A tracker that pings
you about something you finished two hours ago gets muted within a week, and a
muted channel cannot deliver the reminder that would have mattered.

---

## 2. How it is put together

Three pieces, each following a pattern already in the codebase:

- **Two D1 tables, no KV.** `habits` is the definition, `habit_entries` is one
  row per day done. Unlike meal and progress photos there are no bytes to store,
  so this feature has no storage caveat at all.
- **Reminders ride the existing cron.** The `* * * * *` trigger already runs
  `checkReminders`; the `scheduled` handler now also calls
  `checkHabitReminders`. No new trigger, and minute granularity is what lets a
  21:00 reminder actually arrive at 21:00 local.
- **UI injected with HTMLRewriter into a shadow root**, copied from
  `worker/progress-assets.ts`. The reason is that `master`'s Worker is deployed
  against assets built from the *other* fork, so there is no frontend on this
  branch to add a tab to. That is not the same as the frontend being unreadable:
  its source and a built copy are in the `source` worktree at
  `C:/Users/agust/macroflow-app`, and injected UI **must** be tested against
  `macroflow-app/dist` before deploying (§10). The palette is sampled from the
  running app at mount, so it follows the theme with no redeploy.

### The two constraints worth knowing

**Days are local, always.** Every date is a local `YYYY-MM-DD` in
`settings.timezone` (`America/Buenos_Aires`), never a UTC slice — the same
reasoning as `progress_photos.taken_date`. A 22:00 walk is 01:00 UTC the next
day; bucketing on UTC would file it under tomorrow and break the streak it was
meant to extend.

**The database owns "once per day".** `UNIQUE(habit_id, done_date)` makes
check-in idempotent no matter who calls it — the page, a `/done` reply, a
double-tap on a bad connection. Nothing in `worker/habits.ts` checks first, and
nothing should start. It is the same trick `sent_reminders.reminder_key UNIQUE`
already uses to stop double-sends, applied to the other end of the loop.

### The streak grace rule

If today is not yet done, the count starts at **yesterday** rather than reporting
zero. Without it a two-week streak reads "0" every morning until the walk
happens — both wrong and exactly the moment the number is supposed to be
motivating. A streak is only broken once a full day has been missed.

---

## 3. The migration — applied 2026-08-27

```bash
export CLOUDFLARE_ACCOUNT_ID=6c3b2df3d669fda007025e023ffee12c
npx wrangler d1 execute macroflow --remote --file migrations/0008_habits.sql
```

Applied directly rather than via `d1 migrations apply`, matching `0005`, `0006`
and `0007` — all live in the database but absent from `d1_migrations`, which
still ends at `0004`. **That ledger under-reports by three migrations**; trust
`sqlite_master`.

Done. `habits` and `habit_entries` exist with both named indexes
(`habit_entries_habit_date`, `habit_entries_date`) and the three implicit ones
from the PRIMARY KEY and UNIQUE constraints — confirmed by reading back
`sqlite_master`. The database is now **16 tables**, not the 13 recorded in
`macroflow-kb.md` §3 (that count also predates `photo_crypto`, which arrived
from the other fork — §8).

It also seeds the walking habit and backfills **2026-08-26 only**. Today is
deliberately left unchecked: under-recording is the safe direction, because a
missing check-in is visible on the page and one tap away, whereas a fabricated
one is invisible and quietly corrupts the streak it was meant to measure.

To undo, alongside a Worker rollback:

```bash
npx wrangler d1 execute macroflow --remote --command "DROP TABLE habit_entries; DROP TABLE habits;"
```

> **Numbering collides with the `source` fork.** That branch has its own
> `0004`–`0005` with different contents. `0008` is free on both, but see §8.

---

## 4. Telegram — what is already there, and what is missing

Almost all of this already existed. `worker/telegram.ts` in the deployed bundle
has `sendTelegramMessage`, the webhook, `registerWebhook`, and a command
dispatch for `/start`, `/today`, `/log` and `/help`. The webhook secret
`TELEGRAM_WEBHOOK_SECRET` is a live Worker secret.

### Correction: the bot IS connected, and outbound already works

An earlier draft of this section said `telegram_bot_token` and
`telegram_chat_id` were empty and `sent_reminders` had zero rows. **Both claims
were wrong** — they were copied from `macroflow-kb.md` §4 instead of being read
from the database. Checked 2026-08-28:

- the token and chat id are **set**
- `sent_reminders` holds **29 rows**, with meal and weight reminders going out
  daily since at least 2026-08-24
- the first **habit** reminder fired on schedule:
  `habit:b1a7d4c2…:2026-08-27`, sent `2026-08-28T00:00:38Z` = 21:00 local

So the outbound half of this feature is confirmed working in production, not
just in tests.

### What is actually missing: the webhook

`getWebhookInfo` reports **no URL registered**. Telegram therefore has nowhere
to deliver replies, so every inbound command silently does nothing — `/done`,
`/habits` and `/undo`, and equally the pre-existing `/today` and `/log`. That is
why the 21:00 reminder fired but no check-in was recorded for the 27th.

**The app has a button for this: Settings → "Register webhook."** It is enabled
whenever a bot token is configured, and it calls the route below.

One thing above it will look broken and is not: the Telegram health panel reads
`/api/telegram/status`, which `master`'s Worker does not serve, so it sits on
"Checking…" forever. `refreshTelegram` catches that (`.catch(() => setTelegram(null))`)
so the screen does not crash. Ignore the panel; press the button.

Failing that, from a desktop browser's devtools console on the app — this reuses
the session cookie, so nothing has to be extracted:

```javascript
fetch('/api/telegram/webhook/register', {method:'POST'}).then(r=>r.json()).then(console.log)
```

Note that `curl` in PowerShell is an alias for `Invoke-WebRequest`, which takes a
dictionary for `-Headers`; a bash-shaped `curl -H "Cookie: …"` fails there. Use
`curl.exe` if you want the real thing.

The route reads `TELEGRAM_WEBHOOK_SECRET` from `env` and passes it to Telegram
as `secret_token`, so no local copy of the secret is needed — and it cannot be
done from outside the password gate, which is why it needs you.

**If Telegram is ever disconnected, the app says so.** The habits sheet shows a
warning whenever a reminder time is set and the bot is not configured, rather
than letting you configure a reminder that silently goes nowhere.

---

## 5. Wiring, as source edits

`tools/build-worker.mjs` already does all of this. This section is a description
of what it inserts, for whenever a real source tree is rebuilt.

### 5.1 Imports

```ts
import { listHabits, createHabit, updateHabit, deleteHabit, checkIn, undoCheckIn } from './habits';
import { habitsClientResponse, injectHabitsClient } from './habits-assets';
import { checkHabitReminders, handleHabitCommand, HABIT_HELP } from './habit-reminders';
```

### 5.2 Routes

`GET/POST /api/habits`, `PATCH/DELETE /api/habits/:id`,
`POST/DELETE /api/habits/:id/check`, and `GET /habits-client.js`. All sit above
the `app.all('*')` fallthrough and **none is added to `PUBLIC_PATHS`** — they
stay behind the password gate.

`PATCH` copies fields across one at a time rather than passing the body through,
so a client cannot reach a column the UI does not expose (`started_on`,
`sort_order`).

### 5.3 The cron

```ts
async scheduled(_event, env, ctx) {
  ctx.waitUntil(checkReminders(env).catch((e) => console.error('Reminder check failed:', e)));
  ctx.waitUntil(checkHabitReminders(env).catch((e) => console.error('Habit reminder check failed:', e)));
}
```

Wrapped separately on purpose: a habit reminder that throws cannot take the meal
reminders down with it, or the reverse.

### 5.4 Bot commands

`handleHabitCommand` runs **before** the existing dispatch and returns `null`
when the message is not a habit command, so `/today`, `/log` and `/help` behave
exactly as they do now. It sits after the unpaired-chat check, so habit commands
are gated by it too.

### 5.5 The client

```ts
app.all('*', async (c) =>
  injectHabitsClient(injectProgressClient(await c.env.ASSETS.fetch(c.req.raw))));
```

HTMLRewriter streams, so two passes do not each buffer the document.

---

## 6. What is verified, and what is not

### Verified — 53 assertions against a real SQLite database

The **compiled** modules were run against the real `0008` migration through a
minimal D1 shim, with the Telegram sender stubbed:

- streaks: today-done, the grace rule, a broken streak, an empty set, and
  "longest is an older run"
- `daysBetween` across a month, a year, and a US DST boundary — the noon anchor
  is what makes the last one correct
- the seed leaves exactly one habit, day 1 recorded, reminder 21:00
- check-in creates the day, sets the streak to 2, records 10.4 km; a **second**
  check-in is not a new day, does not inflate the streak, and a `null` value does
  not erase the distance already recorded
- exactly one row per day survives all of it
- undo removes today and the streak falls back to the grace count; undo again is
  a no-op
- a future-dated check-in is rejected; an unknown habit returns `null`; `25:00`
  is rejected and `9:05` is padded to `09:05`
- `/habits`, `/done`, `/done 10.4`, `/done read 25`, `/undo`, and fall-through
  on `/today`
- `/done` twice replies "Already logged" rather than double-counting
- with two habits a bare `/done` asks which, a name fragment resolves, and a
  trailing number is read as the value — **`Walk 10 km` is not parsed as the
  value 10**
- a habit named `Run <10 min/km & win` comes back HTML-escaped, so it cannot
  break Telegram's HTML parse mode and silently drop the message
- the reminder does not fire at 20:59, fires once at 21:00, does not double-send
  on a second tick in the same minute, and is **suppressed once the walk is
  logged**
- nothing is sent when the bot token is empty

### Verified — the client, driven in a browser

Against a stub host page styled to match the real app (warm off-white, lime
accent on a chip, floating nav of Today · Progress · Scan · Photos · Settings):

- the nav item lands **between Scan and Photos**, so Settings stays last, and its
  computed `display`, `flex-direction`, `font-size` and `padding` are identical
  to its siblings
- exactly **one** item after three full nav re-renders and 60 DOM mutations
- the icon is replaced with the outline check SVG — including on a nav that draws
  its icons as **emoji in a plain element**, which the original selector missed
  entirely and which would otherwise have shipped a Settings gear labelled
  "Habits" (§9)
- check-in: tap → `POST` → refetch → streak 1→2, dots 1→2, subtitle becomes
  "Day 2 · done · 10 km"; undo reverses all of it
- changing the reminder time `PATCH`es and the subtitle updates
- the add form creates a habit and it appears in the list
- **dark host**: the sheet takes the page's `#121214`, and the card surface comes
  out *lighter* than the background (luminance 0.138 vs 0.071) — derived from the
  page, not hardcoded
- the Telegram warning shows when the bot is not connected and disappears when it
  is
- no console errors throughout

### Not verified

- **Anything behind the password gate.** The gate is a secret and correctly so,
  so no automated check reaches the real D1, the real `ASSETS` HTML, or the real
  nav. `keep_assets` and the binding audit are strong evidence, not proof.
- **A real Telegram send.** There is no bot token, so `sendTelegramMessage` has
  never run in production. The dispatch logic around it is tested; the network
  call to Telegram is not.
- **The exact nav position against the real bar.** The ordering rule was checked
  against a stub built from the screenshot in `PROGRESS-PHOTOS.md` §10, not
  against the app.

---

## 7. Deployed 2026-08-27

The method was `PROGRESS-PHOTOS.md` §8 unchanged — patch the recovered bundle,
upload a **staged version** with `keep_assets: true`, audit the bindings, then
promote:

```bash
node tools/build-worker.mjs dist
```

Confirmed before writing any of this: the deployed script is **byte-identical**
to `dist/worker.js`, and `tools/build-worker.mjs` reproduces that file exactly
from `recovered/BUNDLE-FULL.js` (modulo the date stamp in one comment). The base
is production.

**The order matters.** Apply the migration **first**. The routes query `habits`
on every `GET /api/habits`; deploying before the table exists means the Habits
tab errors for however long the gap lasts. The reverse — table first, code
second — is invisible.

`run_worker_first: true` must survive the deploy. If it were lost, static assets
would be served **before the password gate** and the whole frontend would go
public. Re-check it on any deploy through this path.

It did survive: the staged version came back with
`raw_run_worker_first: true` and
`not_found_handling: "single-page-application"`, and all seven bindings matched
production — `APP_PASSWORD`, `OPENROUTER_API_KEY` and `TELEGRAM_WEBHOOK_SECRET`
all inherited as `secret_text`, plus `ASSETS`, `DB`, `PHOTOS` and `APP_URL`.
Only then was it promoted.

### Verified after promotion

- `/api/health` → `200 {"ok":true,"storage":"d1",...}` — boots, D1 reachable
- `/`, `/api/habits`, `/habits-client.js`, `/api/progress`, `/api/dashboard`,
  `/api/settings` → all `401`. The new routes are gated and nothing regressed
- the deployed script pulled back down is **byte-identical** to `dist/index.js`
  (819,803 bytes)
- the cron trigger is still `* * * * *`, unmodified
- `wrangler tail` over several minutes shows the scheduled handler running on
  version `66468e1a` with `"outcome": "ok"` and `"exceptions": []` — so
  `checkHabitReminders` executes in production without throwing. It returns
  early because there is no bot token, which is exactly the designed path

### Still not verified

Everything behind the password gate, because the gate is a secret. Nobody has
confirmed by eye that the **Habits** tab appears in the real nav, that a check-in
round-trips, or — the one that matters most — **that the frontend still renders**.
The 401 login page is inline in the Worker and never touches the `ASSETS`
binding, so a 401 does not exercise it at all.

**Sign in and load the app.** If anything is wrong:

```bash
npx wrangler rollback --name macroflow
```

Nothing in this deploy wrote to or deleted the asset store. The previous version
is `b5c627fe-431a-44ae-86e7-3fc6a55f370e`; the current one is
`66468e1a-e872-4e51-8ddf-98207d2ac2f7`. A rollback leaves the `habits` tables in
place, which is harmless — nothing else queries them.

---

## 8. The other fork

`git worktree list` shows a second checkout at `C:/Users/agust/macroflow-app` on
branch **`source`** — a React + Vite rewrite of the same product, renamed
Jamtytrack, with its own `worker/` and its own `0001`–`0005` migrations.
`master` and `source` have **no common ancestor**; see
`DEPLOYING-THE-REDESIGN.md` on that branch.

**Production runs `master`.** Confirmed 2026-08-27 by pulling the deployed
bundle and diffing it against `dist/worker.js` — identical — and by the version
log, whose two most recent messages are this branch's security and Telegram
patches.

So this feature is on the right fork. But it exists **only** on `master`. If
`source` is ever deployed, habits disappear along with push notifications,
weekly reports and the reminder cron, exactly as that runbook warns. Porting is
not hard — `worker/habits.ts` and `worker/habit-reminders.ts` are plain modules
with no bundle-specific assumptions, and only `worker/habits-assets.ts` is
throwaway, because `source` has a real frontend to put a real tab in.

---

## 9. Notes for the next person

**The nav is now six items.** Today · Progress · Habits · Photos · Scan ·
Settings. They fit — `fitNav()` tightens the row when it overflows — but this is
the last one that should go in by cloning. Anything further needs the real
frontend.

**The theme reader is a third copy.** `push-assets.ts`, `progress-assets.ts` and
`habits-assets.ts` each carry their own. Deliberate for now: they are independent
injected scripts in separate shadow roots, and editing a deployed working module
to share a source string risks a live feature to save bytes on an already-cached
page. Collapse all three when the frontend source is recovered.

**`progress-assets.ts` has the icon bug this feature fixed.** Its `buildNavItem`
still matches only `svg,img,i,[class*="icon" i]`. If the real nav draws icons as
emoji rather than SVG, the Photos tab is showing a cloned Settings gear right
now. The fix is the ten-line fallback in `habits-assets.ts`; it was not applied
to `progress-assets.ts` because that file is deployed and working, and this
change did not need to touch it. Worth doing next time that file is opened.

**The build now parses its own output** (`node --check` on the spliced bundle
before writing it). That is not cosmetic: everything is spliced into **one flat
scope** alongside hono and zod, so a name collision is a `SyntaxError` and the
Worker does not boot at all — taking the whole app down, not just the new
feature. It caught exactly that during this build: `esc` was already a top-level
name in the bundle, and is now `escapeHtml`.

---

## 10. The nav was broken, and why — fixed 2026-08-27, version `2bfb19e7`

The first deploy put the launcher in the wrong place and broke the app's bottom
bar. Worth recording in full, because the cause was a documentation trap that is
still sitting in this repo.

### What I validated against, and why it was wrong

I built a synthetic test page from the **screenshot description** in
`PROGRESS-PHOTOS.md` §10 — "Today · Progress · Scan · Settings, lime accent,
Scan a raised dark circle". That description was accurate on 2026-08-19 and is
now stale: the carrot restyle on the `source` branch replaced that bar entirely.

Meanwhile **the real frontend's source was in the repo the whole time** — the
`source` worktree at `C:/Users/agust/macroflow-app`, with `src/components/Layout.tsx`,
`src/styles.css`, and a **built copy in `dist/`** that can be served locally and
driven in a browser. `macroflow-kb.md` §9 says the frontend is unreadable. It
has not been true since 2026-08-20. See `macroflow-kb.md` §14.

### The three failures

Measured against `macroflow-app/dist`, not inferred:

| Failure | Cause |
|---|---|
| A **second capture button** beside the nav, squashing it 271px → 195px | `findNav()` scored `.mobile-bar` (6 controls, fixed, low) above `.bottom-nav` (4 controls, static), so the launcher cloned the `.scan-fab` and was appended to the wrapper |
| **Settings pushed out of the bar** | `.bottom-nav` is `grid-template-columns:repeat(4,1fr)` with a fixed 66px height. A fifth cell wraps to a second row that the height hides. `fitNav()` only handled flex, and only on horizontal overflow — which a grid never has |
| A **duplicate "Photos" tab** | The app already ships one. This one predates habits: it shipped with progress photos and was live for eight days |

A fourth, found while fixing: on the wide layout `findNav()` matched the app's
**week picker** and injected a Habits button into the date selector.

**Rolling back would not have fixed it.** Tested: the duplicate Photos tab and
Settings falling out of the bar were both present in `b5c627fe`, before habits
existed.

### The fix

Both `worker/habits-assets.ts` and `worker/progress-assets.ts` now:

- **Gate on being bar-like** — a real `<nav>`/tablist, or pinned, or
  bottom-anchored. "Wide, short, several controls" also describes a date strip.
- **Drop any candidate containing another candidate** — the inner element is the
  bar, the outer one is its layout wrapper.
- **Rewrite the grid** when the bar is one: `grid-template-columns:repeat(N,1fr)`
  plus the sliding pill's width, with the inset read from the bar's own padding
  so it stays responsive.
- **Append last.** The pill is positioned by an index into the app's *own* tab
  array, so inserting ahead of a native tab shifts that tab right while its index
  stays put and the highlight lands under the wrong one. The cost is that Habits
  sits after Settings — a small oddity, versus a highlight that looks broken.
- **Judge by the result**: if the item lands somewhere invisible it is removed
  and the floating fallback takes over, re-checked on resize because the app's
  760px breakpoint swaps the bar for a sidebar without mutating the body.
- **Stand down when the app has its own Photos tab** (progress-assets only), kept
  conditional so it starts working again if the assets ever roll back.

### Verified against the real built app

`macroflow-app/dist` served locally with both clients injected, exactly as the
Worker injects them:

| Width | Result |
|---|---|
| 320 | 5 tabs @ 41px, one row, pill aligned, no x-scroll |
| 375 | 5 tabs @ 52px, nav back to 271px, one capture button |
| 390 | 5 tabs @ 55px |
| 414 | 5 tabs @ 60px |
| 430 | 5 tabs @ 63px |
| 760 | 5 tabs @ 129px (breakpoint edge) |
| 1200 | sidebar layout intact, week picker clean, floating fallback shown |

Also: the pill lands under each of the four native tabs at `--nav-index` 0–3;
the sheet covers the viewport, picks up the app's real `#f7f6f3` and DM Sans, and
gives the check circle a 46px tap target.

### What this does not fix

The frontend and the Worker are **different forks**. The React app calls
`/api/progress/lock|setup|state|unlock`, `/api/telegram/status` and
`/api/benchmark/*`, none of which `master`'s Worker serves — so the app's own
Photos tab and part of Settings are broken regardless of anything here. That is
the next piece of work, and it starts with a D1 export, because
`DEPLOYING-THE-REDESIGN.md` §3 records that the `photo_crypto` row is the only
key to every body photo.

---

## 11. The sheet could only be closed with the × — fixed, version `9f91f947`

Reported after the nav fix: the Habits panel opened fine but tapping the nav bar
would not dismiss it.

### Why

`position: fixed` on the shadow host **creates a stacking context**. The sheet's
`z-index: 2147483001` therefore only competes *inside* that context — against
the app's `.mobile-bar` (`z-index: 50`) the host counts as 0, so **the app's nav
bar painted on top of the sheet**, and no z-index the sheet could carry would
change that. Confirmed with `elementsFromPoint` at the nav row, which returned
`BUTTON → NAV.bottom-nav → .mobile-bar → [host]` — the host underneath.

The visible consequence was worse than a z-index quibble: the bar floated over
the panel, and tapping another tab **navigated the app behind the still-open
sheet**, so the screen changed underneath while the panel stayed put. It read as
stuck, and the × was the only thing that worked.

### The fix

Stop fighting the stacking context and give the bar its own space:

- **The sheet stops above the nav bar.** `navReserve()` measures the outermost
  fixed ancestor of the launcher — so the detached capture button is included —
  and sets the sheet's `bottom` inline, recomputed on resize. The tabs stay
  visible and usable with the panel open, which is better than covering them.
- **Any tap outside closes it**, on the capture phase so the app cannot swallow
  it. The launcher itself is excluded, because its own handler toggles and
  closing first would let that toggle immediately re-open it. Nothing is
  cancelled, so the app still navigates on the same tap.
- **Escape closes it**, and every listener is removed on close.
- A bottom radius and shadow make the new edge look deliberate.

### Verified against the real built app

All five dismissals work: tap Habits again, tap another tab, Escape, the ×, and
tap the capture button. Plus: the sheet clears the bar with a 10px gap at 320,
375 and 430px (94px reserve at each); six open/close cycles leave zero orphan
sheet nodes; `aria-expanded` tracks; check-in still round-trips with the sheet
staying open; and the nav is still `Today · Progress · Photos · Settings ·
Habits` with one capture button afterwards.

One incidental confirmation: when the app itself crashed during testing (a stub
gap, not the feature) the launcher correctly fell back to the floating button
rather than disappearing.

---

## 12. The panel was an overlay, not its own space — fixed, version `58e4b544`

Reported after §11: *"it's like an overlay, not its own space. I see the calories
through it, and when I scroll on that page it's super glitchy."*

Both symptoms, one cause — and the same trap as §11, only one layer deeper.

### Why

`position: fixed` on the shadow host **always creates a stacking context**. So
the sheet's `z-index: 2147483001` was only ever ranked against its own siblings
*inside* that context, while the host itself joined the page at `z-index: auto`.
Every app element with a positive z-index therefore painted **over** the panel:

| App element | z-index | Effect |
|---|---|---|
| `.calorie-copy`, `.calorie-ring` | 1 | **the calories showing through** |
| `.bottom-nav button` | 1 | |
| `.target-line`, `.onboarding-brand` | 2 | |
| `.sidebar` | 20 | |
| `.mobile-bar` | 50 | the §11 symptom |
| `.saved-toast` | 60 | |
| `.photo-viewer` | 80 | |
| `.modal-backdrop` | 100 | |

Nothing the sheet could do with its own z-index would beat any of them.

The "glitchy scroll" was the same thing in motion: those layers slid across a
stationary panel as the page scrolled behind it, and the sheet's scroll chained
into the page once it hit its end.

§11 treated the `.mobile-bar` case as a layout problem and reserved space for the
bar. That was right, and it stays — but it was one instance of a general fault.

### The fix

**`position: absolute` on the host instead of `fixed`.** Absolute with `z-index:
auto` creates **no** stacking context, so the sheet competes at the root and
outranks all of the above. The host is still out of flow at 0×0, so it
contributes no line box — which was the only reason it was taken out of flow.
Fixed descendants stay viewport-anchored either way; only transform, filter or
perspective on an ancestor would change that, and there is none.

Plus `overscroll-behavior: contain` on the sheet, so a scroll that reaches the
end of the panel does not chain into the page underneath.

### Verified against the real built app

- `.calorie-ring`, `.calorie-copy` and `.macro-grid` are all **covered by the
  sheet** (before the fix, all three sat on top — the bug reproduced exactly)
- a 60-point grid sampled across the panel while scrolled to the bottom: **zero**
  bleed-through
- the panel scrolls internally (2712px of content in a 718px box) and
  `window.scrollY` does not move
- the nav bar is still reachable and all four dismissals still work
- host computes to `absolute`, sheet to `overscroll-behavior: contain`

### Also fixed in passing

`worker/progress-assets.ts` had `text.match(/rgba?\(([^)]+)\)/)` inside its
template literal. A single backslash there is eaten, so the **emitted** regex was
`/rgba?(([^)]+))/` — capturing groups, not literal parentheses. `m[1]` came out
as `"(247, 246, 243"`, whose first `parseFloat` is `NaN`, so every colour that
theme reader produced was invalid. Live in that state since 2026-08-21. Now
doubled to `\(` and verified to parse `rgb(247, 246, 243)` → `[247, 246, 243]`.

That class of bug has now bitten three times in these files (a stray backtick
closing the template literal twice, and this). Anything written inside
`*_CLIENT_SOURCE` needs its backslashes doubled and its backticks avoided.
