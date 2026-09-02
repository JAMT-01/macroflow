# The live site on 2026-09-02 — what actually changed

An audit of https://jamtytrack.montagnertudor.org taken 2026-09-02, four days
after `PHOTOS-HOW-IT-WORKS.md` was written. It exists to answer one question the
other documents cannot: **is what is deployed still what they describe?**

**Short answer: no code has changed. The data has, and four documented claims
have gone stale.** Nothing needs deploying. Two things need correcting, and one
gap is worth a decision.

**But GitHub is 13 days behind, and the deployed frontend's source is not in it
at all** — see §8. That is the one urgent item here.

---

## 1. Nothing was deployed between 2026-08-29 and 2026-09-02

Both halves are the same builds the repo already describes.

| Half | Evidence | Verdict |
|---|---|---|
| Frontend | serves `assets/index-Cmxhdy_b.js` + `index-KAmyQSRD.css` — the **same content-hashed filenames** as `macroflow-app/dist/assets/`, built 2026-08-20 19:46 | unchanged since 2026-08-20 |
| Worker | the login gate served live is byte-identical to the one compiled into `dist/worker.js` (only the `${message}` placeholder differs) | matches the local build |

The Worker's live route table also matches `dist/worker.js` exactly — 54 unique
routes, including the habit and photo-lock routes added on 2026-08-27/28. So the
build stamped `Habits: full-bleed page under the nav, not a floating card`
(2026-08-29 16:36) is what is running, and the uncommitted working tree
reproduces it.

**Verified in the browser:** the Habits panel opens full-bleed, not as a floating
card. `--nav-index` is 4, the pill sits at the Habits column, and only Habits
carries `.active`. The nav is a **5-column grid** with a matching 55px pill — the
regression described in `HABITS.md` §10 has stayed fixed.

> Both injected clients load cleanly: `/progress-client.js` and
> `/habits-client.js` both 200. The only console error on a cold load is the
> pre-auth 401 on `/`, which is the password gate doing its job.

---

## 2. What did change: the app is in daily use

`macroflow-kb.md` §4 still says *"Logged meals — 12, spanning 2026-08-13 →
2026-08-16"* and *"Last 24h: 1,409 reads / 0 writes"*. That snapshot is three
weeks old and no longer resembles the database.

**Nutrition — 16 logged days, 48 meals, spanning 2026-08-13 → 2026-09-02:**

| Window | Value |
|---|---|
| Days tracked (last 14) | 10 / 14 — 71% consistency |
| Daily average | 2,117 kcal against a 3,110 target |
| Protein average | 138 g against a 192 g target |
| Today (2026-09-02) | 1 meal, 620 kcal |

Gap days in the last 30: 2026-08-17, 22, 23, 26, 28.

**Habits — "Walk 10 km", day 8:**

| Field | Value |
|---|---|
| Started | 2026-08-26 |
| Check-ins | 6 (Aug 26, 27, 28, 30, 31, Sep 1) |
| Missed | **2026-08-29** |
| Current streak | 3 · longest 3 |
| Total | 60 km |
| Today | not yet checked in |
| Reminder | 21:00, enabled |

The habit is real, it is being used, and the reminder is on. This is the single
biggest change since the docs were written — they describe it at day 1–4.

### The weigh-in is still the hole PUSH-SETUP.md was written to fill

`weight_entries` holds **exactly one row**, and it has not moved:

```
2026-08-13T16:21:04Z — 96 kg
```

That is 20 days ago. The 08:00 weigh-in reminder has been firing daily since at
least 2026-08-24 (`HABITS.md` §4: 29 rows in `sent_reminders`), and it has
produced zero additional entries. The Progress tab's *"0.0 kg overall"* is not a
plateau — it is one data point being compared to itself.

`PUSH-SETUP.md` opens by saying the app should *"prompt for the data it is
missing — primarily the daily weigh-in."* The prompt now goes out and the data
still is not there, so the reminder is not the missing piece.

---

## 3. Four documented claims that are now wrong

Every one of these is a doc-only fix. No code is involved.

### 3.1 `macroflow-kb.md` §12 — Telegram is connected, and has been since August

The heading reads *"Telegram is still not connected — §4 is unchanged and this is
now blocking"*, and the body says the token and chat id are **still empty**.

Live `/api/settings` returns `telegramTokenConfigured` set and
a populated `telegramChatId` (value withheld — this repo is public).

`HABITS.md` §4 already caught this on 2026-08-28 under *"Correction: the bot IS
connected, and outbound already works"*. The correction never made it into
`macroflow-kb.md`, so the two documents now contradict each other, and the kb —
the longer, more authoritative-looking one — is the wrong half. **Fix the kb.**

### 3.2 `macroflow-kb.md` §10 — the vision model moved

Documented as `google/gemini-3.6-flash`. Live `settings.openrouter_model` is
**`google/gemini-3.7-flash`**, and Settings shows it. The report model
(`moonshotai/kimi-k3`) is a separate column and is not affected.

### 3.3 `PHOTOS-HOW-IT-WORKS.md` §8 — the 3-vs-15 mismatch does not exist

§8 lists: *"`UNLOCK_MINUTES` is 3 in the Worker, described as 15 in the frontend
copy."*

There is no mismatch. The frontend **interpolates the value it is given**:

```js
they close again after ${j} minutes, when you close the browser, ...
```

`j` comes from `unlockMinutes` in `/api/progress/state`, which returns 3. The
lock screen on the live site reads *"they close again after 3 minutes"*. There is
no hardcoded 15 anywhere in the bundle. **Delete the item** rather than chasing
it.

### 3.4 `macroflow-kb.md` §4 — the activity figures

*"Last write 2026-08-17, 0 writes in 24h"* is stale on its face given 48 logged
meals through 2026-09-02. Either refresh it or mark it as a dated snapshot.

---

## 4. The missing routes: §8's list is exactly right

Worth stating plainly, because it is easy to over-report. The frontend bundle
references **30** API paths. Cross-referencing them against the Worker's 54
registered routes, exactly **five** are unserved:

| Route | Used by |
|---|---|
| `GET /api/telegram/status` | the Telegram card in Settings |
| `GET /api/benchmark/cases` | benchmark screen |
| `GET /api/benchmark/models` | benchmark screen |
| `GET /api/benchmark/research` | benchmark screen |
| `POST /api/benchmark/run` | benchmark screen |

That is the same list `PHOTOS-HOW-IT-WORKS.md` §8 gives. Nothing has been added
or resolved.

> **A trap worth writing down.** Probing for missing routes by hand overstates
> the problem badly. `not_found_handling: single-page-application` means *any*
> unrouted GET returns **`200 text/html`** with the SPA shell — so `/api/weight`
> and `/api/meals` look broken when probed with GET, but the client only ever
> calls them with POST, and both POST routes exist. Check what the bundle
> actually calls before believing a probe.

### What it looks like to a user

Because the fallback returns `200`, `response.ok` is **true** and the failure
lands on `response.json()` instead:

```
SyntaxError: Unexpected token '<', "<!doctype "... is not valid JSON
```

The Telegram card handles it with `.catch(() => setStatus(null))`, and its label
is computed as:

```js
telegramChatId ? (status ? … : "Checking…") : "Awaiting /start"
```

With `status` permanently `null`, the chip reads **"Checking…" forever**. The
card body still renders — *"Save Telegram"*, *"Register webhook"* and *"Send
test"* are all present and clickable. Only the status readout is dead.

**Why this matters more than it looks.** `HABITS.md` says the one remaining
blocker is Telegram **webhook registration**, without which `/done`, `/habits`
and `/undo` never reach the Worker. That chip is the only thing in the app that
would tell you whether the webhook is registered — it is the branch that would
otherwise say *"Webhook not registered"*, *"Delivery failing"* or *"Connected"*.
So the missing route hides exactly the answer you need.

`POST /api/telegram/webhook/register` **is** served, and the button that calls it
works. Pressing it is a blind action with no feedback, but it is not blocked.

---

## 5. Habits is unreachable on desktop

Undocumented, and a real gap.

| Viewport | Habits |
|---|---|
| 389px (mobile) | present — 5th tab in the bottom bar |
| 1200px (desktop) | **absent everywhere** |

At 1200px the sidebar lists Today · Progress · Photos · Settings and nothing
else. `.mobile-bar` is `display: none` and `.bottom-nav` measures 0×0, so the
injector — which is required to find a real, visible nav before it will clone a
tab — correctly stands down and adds nothing. `habits-client.js` still loads
(200); it just has nowhere to attach.

The result is that the habit cannot be checked off from a laptop at all. There is
no error and no fallback, which is the right behaviour for the injector but
probably not the intended behaviour for the feature.

**This is a decision, not a bug.** If the app is only ever used as a phone PWA it
is fine as-is. If not, the injector needs a sidebar branch for the ≥760px layout
— and per §6 of `PHOTOS-HOW-IT-WORKS.md`, that must be built against
`macroflow-app/dist` served locally, never against a screenshot.

---

## 6. Photo lock: working exactly as documented

No action needed; recorded so the next person does not re-diagnose it.

| Check | Value |
|---|---|
| `/api/progress/state` | `configured: true`, `unlocked: false`, `unlockMinutes: 3` |
| `/api/progress` | `403 {"error":"Progress photos are locked","locked":true}` |
| Photos tab | renders the passphrase screen with the recovery-key link |

This is the normal locked state, not the false alarm from 2026-08-29. The lock
screen appearing is what the lock is supposed to do.

---

## 7. Re-running this audit

Nothing here needed `wrangler`, which is not installed. Sign in, then from the
page console:

```js
await (await fetch('/api/settings',   {credentials:'same-origin'})).json()
await (await fetch('/api/habits',     {credentials:'same-origin'})).json()
await (await fetch('/api/history?days=30', {credentials:'same-origin'})).json()
await (await fetch('/api/progress/state',  {credentials:'same-origin'})).json()
```

To re-derive the missing-route list instead of guessing it, diff the two sides:

```js
const src = await (await fetch('/assets/index-Cmxhdy_b.js')).text();
[...new Set((src.match(/["'`]\/api\/[\w\/${}.:?=-]*/g)||[]).map(s => s.slice(1)))].sort()
```

and compare against the Worker's registrations:

```bash
grep -oE 'app\.(get|post|put|patch|delete)\("[^"]+"' dist/worker.js | sort -u
```

Confirming the frontend build without deploying anything: the asset filenames are
content-hashed, so `assets/index-*.js` on the live page matching
`macroflow-app/dist/assets/` proves the frontend is unchanged.

---

## 8. GitHub — `JAMT-01/macroflow` is 13 days behind reality

Checked 2026-09-02. Both branches report **0 ahead, 0 behind** their remotes,
which looks reassuring and is misleading: nothing is ahead because nothing has
been **committed**. The last push was **2026-08-20T21:23Z**.

| Branch | Remote HEAD | Committed | Uncommitted in the worktree |
|---|---|---|---|
| `master` | `d965e6d` (2026-08-20 16:06) | recovered bundle + progress photos | 6 modified, 13 untracked — **~2,900 insertions** |
| `source` | `00901a2` (2026-08-20 18:23) | carrot restyle + deploy runbook | 15 modified, 1 untracked |

**Everything described in this document is missing from GitHub**: the habits
feature (`worker/habits.ts`, `habit-reminders.ts`, `habits-assets.ts`),
`worker/photo-lock.ts`, `migrations/0008_habits.sql`, the rebuilt
`dist/worker.js` that is actually deployed, `HABITS.md`,
`PHOTOS-HOW-IT-WORKS.md`, and the security patches in `tools/build-worker.mjs`.

### The part that matters: the deployed frontend is not in git

`source`'s last commit is **18:23**. The modified files in that worktree are
stamped **18:51–19:45**. `macroflow-app/dist/assets/` was built at **19:46** —
*after* those edits, and from them.

Verified rather than assumed: the bundle served right now by
`jamtytrack.montagnertudor.org` contains the carrot glyph — `viewBox="0 0 318
916"`, path opening `M 156 0C 162 1.5` — and that artwork exists in exactly one
file, `src/components/CarrotMark.tsx`, which is **untracked**. The committed
`Layout.tsx` still renders lucide's `Sparkles` instead.

**So the live UI cannot be rebuilt from GitHub.** Its only source is the
uncommitted working tree at `C:/Users/agust/macroflow-app`, on one machine, in
OneDrive. That is the same failure `macroflow-kb.md` §9 was written about — *"there
is no local source checkout — the deployed Worker is currently the only copy of
the code"* — reappearing on the other fork. Committing that worktree is the
single highest-value action in this document.

### The repo is public

`JAMT-01/macroflow` is **public**, default branch `source`.

**Secret scan: clean.** No API keys, bot tokens, VAPID private keys, or the app
passphrase are committed on either branch. The single `sk-or-v1-` match is an
input placeholder in `SettingsScreen.tsx`. `.gitignore` correctly covers
`.dev.vars`, `.env`, `*.pem` and `.wrangler/`.

**Exposed, but not credentials.** The Cloudflare account ID, the D1 database ID
and the KV namespace ID appear in `macroflow-kb.md`, `wrangler.jsonc`,
`dist/metadata.json`, `PROGRESS-PHOTOS.md` and `tools/README.md`. These are
identifiers, not secrets — they cannot be used without an API token — so this is
a judgement call about how much of your infrastructure you want indexed, not an
incident.

**One genuine wrinkle.** The publicly committed `dist/worker.js` and
`tools/build-worker.mjs` are the **pre-patch** versions. The Telegram
sender-authorization hole, the `onError` message leak and the `image/svg+xml`
upload hole are all still readable there in their unfixed form, while the
deployed Worker has been patched since 2026-08-21. Not exploitable against the
live site — but a public repo currently advertises the unfixed shape of your own
app, and the fixes exist on one machine only. Pushing resolves both halves.

> When committing, decide deliberately about `PWA Design Styles.zip` (394 KB) and
> `pics/`. They are untracked binaries with no build role and probably do not
> belong in a public repo.

---

## 9. What to do

**First, before anything else:**

- [ ] **Commit the `macroflow-app` worktree**, `CarrotMark.tsx` included — it is
      the only copy of the deployed frontend's source (§8)
- [ ] Commit and push the `master` worktree — habits, photo lock, security
      patches, migration 0008, and the docs (§8)

**Then:**

- [ ] Correct `macroflow-kb.md` §12 — the bot is connected; point it at `HABITS.md` §4
- [ ] Correct `macroflow-kb.md` §10 — vision model is `gemini-3.7-flash`
- [ ] Delete the 3-vs-15 item from `PHOTOS-HOW-IT-WORKS.md` §8 — it is not a mismatch
- [ ] Re-date or refresh `macroflow-kb.md` §4's activity figures
- [ ] Decide whether Habits should exist on the desktop sidebar
- [ ] Press **Register webhook** in Settings to unblock `/done`, `/habits`, `/undo` —
      the status chip cannot confirm it worked, so verify by replying `/done` in Telegram
- [ ] Nothing to deploy

Also worth noting, though outside this audit's scope: intake is averaging
2,117 kcal against a 3,110 target, and the only weight on record is 20 days old —
so there is currently no data with which to tell whether the target is right.
