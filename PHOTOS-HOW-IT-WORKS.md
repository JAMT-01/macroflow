# Progress photos — how the whole thing actually works

Written 2026-08-29, after the feature looked broken and turned out not to be.

Read this before touching photos, the nav, or anything that deploys. It exists
because the same three traps have now cost several rounds of rework each.

---

## 1. The one-paragraph version

There are **two git histories** in this repo. Production runs `master`, which
patches a recovered bundle. The React frontend lives on `source`. They **share
one D1 database and one KV namespace**, so a change to either half can break the
other without touching its code. Photos are metadata in D1 + bytes in KV under
`progress-photos/`, gated by a passphrase whose only record is one D1 row.

---

## 2. The two forks

| | `master` | `source` |
|---|---|---|
| Checkout | `C:/Users/agust/OneDrive/Escritorio/macros` | `C:/Users/agust/macroflow-app` (worktree) |
| What it is | the recovered production bundle + patches | React + Vite rewrite, "Jamtytrack" |
| Holds | Worker: routes, photo lock, habits, reports, push, cron | the frontend the ASSETS binding serves |
| Deployed? | **yes — the Worker** | **yes — the frontend assets** |

They have **no common ancestor**. Neither is a superset of the other.

**Both halves are live at once.** The Worker comes from `master`; the HTML, CSS
and JS the browser runs come from `source`'s `dist/`. That is why a mismatch
between them is invisible in either checkout alone.

### How to tell what is deployed

Pull it and diff — never assume:

```bash
export CLOUDFLARE_ACCOUNT_ID=6c3b2df3d669fda007025e023ffee12c
TOKEN=$(grep '^oauth_token' "$APPDATA/xdg.config/.wrangler/config/default.toml" | sed 's/.*= *"//; s/"//')
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/services/macroflow/environments/production/content" \
  > /tmp/live.multipart
# the index.js part is the deployed Worker; diff it against dist/worker.js
```

Verified 2026-08-29: the deployed Worker is **byte-identical** to `dist/worker.js`,
and rebuilding from source reproduces it exactly (only the date stamp differs).

---

## 3. Where a photo actually lives

Three places. All three must agree or the photo is invisible.

| Piece | Where | Looks like |
|---|---|---|
| Metadata | D1 `progress_photos` | `image_path = /progress-photos/<uuid>.jpg` |
| Bytes | KV namespace `PHOTOS` | key `progress-photos/<uuid>.jpg` |
| The lock | D1 `photo_crypto`, one row, `id = 1` | salt + verifiers + wrapped keys |

**The KV prefix is `progress-photos/`, with the hyphen.** `master`'s helper
originally used `progress/`, found nothing, and reported an empty gallery while
every byte sat safely one prefix away. The prefix is `source`'s, and `source`
wrote the data first, so `source` wins.

### Checking the data is intact

```bash
npx wrangler d1 execute macroflow --remote --command \
  "SELECT id, taken_date, pose, image_path, encrypted FROM progress_photos ORDER BY taken_at;"
npx wrangler kv key list --namespace-id cafdcdcb096c4b23b5978317a08a0fa1 --remote | grep progress-photos
```

Every `image_path` must have a matching KV key. As of 2026-08-29: 3 rows, 3 keys,
all matched.

> ### `--remote` is not optional
>
> Without it, `wrangler kv key list` reads the local `.wrangler` simulation and
> returns `[]` on a namespace that is not empty. That single missing flag is what
> produced the "all the photos are gone" entry that sat in `macroflow-kb.md` §5
> for days. **An empty result without `--remote` means nothing.**

---

## 4. The lock, and the failure mode that looks like a bug

`GET /api/progress` is gated by `requirePhotoUnlock`. The gate is on whenever a
`photo_crypto` row exists — **regardless of whether any photo is encrypted.**

The unlock flow, from `src/photoSession.ts` and `worker/photo-lock.ts`:

1. Client derives keys from the passphrase + the stored salt (PBKDF2), then
   SHA-256s the auth key into a **proof**.
2. Client POSTs the proof to `/api/progress/unlock`. The passphrase itself never
   leaves the browser, so the server cannot decrypt anything.
3. Server compares the proof to `auth_verifier`, and on success returns the
   master key **still wrapped**, plus an unlock cookie.
4. Cookie is `Path=/; HttpOnly; Secure; SameSite=Lax` with **no `Domain`**, and
   expires after `UNLOCK_MINUTES` (currently **3** in `worker/photo-lock.ts`,
   though the frontend copy says 15 — cosmetic mismatch, worth aligning).

### What actually happened on 2026-08-29

Nothing was broken. The timeline from D1:

| Time (2026-08-19) | Event |
|---|---|
| 21:35:08 | photo 1 uploaded — `encrypted = 0` |
| 21:36:24 | photo 2 uploaded — `encrypted = 0` |
| 21:36:38 | photo 3 uploaded — `encrypted = 0` |
| **21:36:58** | **`photo_crypto` created — encryption switched on** |

Encryption was enabled **20 seconds after the last photo**. So all three photos
are plaintext, and the `photo_crypto` row is guarding files it never encrypted.

Then the domain changed from `macro.` to `jamtytrack.montagnertudor.org`. Because
the unlock cookie is **host-scoped**, changing the host silently discarded it —
so the passphrase prompt came back, on photos that had been visible for days.
That is the whole story: a cookie that could not follow the rename.

**Diagnosis rule:** the photo feature looking broken is far more likely to be a
lost unlock cookie than a code fault. Check `photo_crypto` and the
`encrypted` column *before* touching anything.


### Habits is a tab, not a modal

The habits panel is injected the same way, but it is presented as one of the
app's screens rather than a sheet floating over one. Two things make that true,
and both are easy to lose:

1. **The pill.** `.nav-pill` is `translateX(calc(var(--nav-index,0) * 100%))`,
   and React writes `--nav-index` as an inline style on `.bottom-nav`
   (`Layout.tsx`). On open, `claimNavHighlight()` sets that variable to the
   Habits cell index and moves the `.active` class; `releaseNavHighlight()` puts
   both back on close. Without it the pill stays under whichever tab you came
   from and two tabs look open at once — the "overlay on Settings" report.
2. **Re-asserting after a render.** React owns both values and rewrites them on
   any render, so a dashboard refresh mid-session would snap the pill back while
   the panel is still open. `settle()` re-applies the highlight on every observer
   tick; `claimNavHighlight()` keeps the *first* saved values, so close still
   restores what the app actually had.

The panel is `role="region"`, not `role="dialog"` — it behaves as a screen, and
announcing it as a modal would misdescribe it.

**Moving the pill was necessary but not sufficient.** The panel still read as an
overlay because it was shaped like a card: it stopped short of the bar
(`bottom: navReserve()`), had a 22px bottom radius and a drop shadow, and sat at
`z-index: 2147483001` — painting over the nav entirely. Three changes make it a
page:

| Was | Now | Why |
|---|---|---|
| `bottom: navReserve()` | `inset: 0` + `padding-bottom: navReserve()` | full-bleed; same clearance, no card edge |
| 22px bottom radius + shadow | neither | a radius and a shadow *are* the overlay cue |
| `z-index: 2147483001` | `z-index: 40` | the nav floats **over** it, as it does over every real page |

**The z-index is the load-bearing one.** The app's ladder in `src/styles.css` is:
content 1–2, `.mobile-bar` 50, `.saved-toast` 60, `.photo-viewer` 80,
`.modal-backdrop` 100. At 40 the panel covers all page content while the bar
stays on top. At a maximal z-index it covered the tabs — and **a panel that hides
the navigation is a modal by definition**, no matter how it is styled.

This only works because the host is `position:absolute` with `z-index:auto` and
so creates no stacking context; the sheet competes at the root. Making the host
`fixed` would trap the sheet in its own context and every app element with a
positive z-index would paint over it — see the long note in `mount()`.

Header matches `.page-header` on mobile: 27px title, `-.03em`, 58px min-height,
15px gutter, and deliberately not sticky, because the app's page headers scroll
away and a pinned bar with a close button is modal chrome.

**Verified 2026-08-29** against the real frontend: on Today, `--nav-index` 0 and
Today active; open Habits, index 4 and Habits active; clobber both to simulate a
React render and `settle()` restores index 4; close and it returns to index 0 with
Today active. Tapping any native tab closes the panel and lets the app navigate.

### Why there is no number pad

`PhotoLock.tsx` decides the input mode from one flag:

```tsx
const [typed, setTyped] = useState(!separateSecret);   // typed = text field
const showKeyboard = typed || stage === "recover";
...
: separateSecret && <button ...>Use the number pad</button>
```

`separateSecret` comes from `/api/progress/state`, and the Worker computes it as
`Boolean(env.PHOTO_PASSPHRASE)` (`hasSeparatePhotoSecret` in `worker/photo-lock.ts`).

**`PHOTO_PASSPHRASE` is not set on the Worker.** So `separateSecret` is `false`,
which does two things at once:

1. `typed` starts `true`, so the screen opens as a text password field, and
2. the "Use the number pad" swap button is **not rendered at all** —
   it is behind `separateSecret &&`.

The pad is therefore unreachable, not hidden. Verified 2026-08-29 against the
real built frontend: with `separateSecret: false` there is a password input and no
pad; with `separateSecret: true` the pad renders with 0–9, a delete key, and a
"Type a passphrase instead" toggle back to the keyboard.

**To get the pad back, set the secret:**

```bash
npx wrangler secret put PHOTO_PASSPHRASE --name macroflow
```

What this does and does not change:

- It does **not** change what unlocks the photos. While a `photo_crypto` row
  exists, `verifyUnlock` compares the client's proof to `auth_verifier` and never
  consults `photoSecret`. You still type the same code.
- It **does** change the HMAC key for the unlock cookie (`photoSecret` signs it),
  so every current unlock is invalidated — unlock once more after setting it.
- It becomes the real fallback secret **if `photo_crypto` is ever deleted**, since
  `verifyUnlock` then falls back to `verifyPassword(body.password, photoSecret(env))`.
  Choose a value accordingly; it is not merely cosmetic.
- A numeric pad can only enter digits. If the passphrase has letters, use the
  keyboard toggle the pad provides.

The alternative — always rendering the swap button regardless of `separateSecret`
— is a one-line frontend change, but shipping it means deploying `source`, which
is the fork-reconciliation problem in §8, not a quick fix.

### Resetting the lock — when it is safe, and when it destroys everything

```bash
npx wrangler d1 execute macroflow --remote --command "SELECT COUNT(*) FROM progress_photos WHERE encrypted = 1;"
```

- Result **0** — no photo is encrypted, the row decrypts nothing, and deleting it
  only removes the passphrase prompt. Safe.
- Result **anything else** — the row is the **only** key to those photos. There is
  no backup, no escrow, no recovery. Deleting it destroys them permanently.

**Never delete `photo_crypto` without running that count first.** The recovery
key shown once at setup is the only other way in.

---

## 5. Deploying without destroying the frontend

`wrangler deploy` **must never be run from `master`.** It requires an `assets`
directory; `master` does not have one, so the deploy would replace the ASSETS
binding and **delete the asset store holding the deployed frontend.**

The safe path, which never touches the asset store:

```bash
node tools/build-worker.mjs dist          # patch the recovered bundle
```

Then upload as a **staged version** with `keep_assets: true` (payload in
`dist/metadata.json`), verify, and only then promote. Full procedure in
`PROGRESS-PHOTOS.md` §8.

**Two things to re-check on every staged version before promoting:**

1. `raw_run_worker_first: true` — if this is lost, static assets are served
   *before* the Worker runs, which means **before the password gate**. The entire
   frontend goes public.
2. All six bindings present, with `APP_PASSWORD` and `OPENROUTER_API_KEY` carried
   forward as `inherit` — they have no plaintext copy anywhere.

---

## 6. The injected UI, and why it must stand down

`master` injects `/progress-client.js` into every HTML response via HTMLRewriter.
It was built when the frontend was believed unreadable and shipped its own photo
gallery and nav launcher.

**The React app now has its own Photos tab**, so the injected launcher must not
add a second one. `hasNativePhotosTab()` in `worker/progress-assets.ts` stands it
down when it sees a native tab labelled Photos.

When that guard was missing, the result was: a duplicate "Photos" tab in a nav
whose grid is hardcoded to `repeat(4, 1fr)`, pushing **Settings onto a second row
and out of the 66px bar**. Verified again on 2026-08-29 — with the current build
the guard fires, `injectedNavItems` is 0, and all four cells sit on one row.

### The real nav, as of the carrot restyle

`.mobile-bar` (fixed wrapper) contains `.bottom-nav` (`display:grid`,
`grid-template-columns:repeat(4,1fr)`, 66px) **plus** a `.scan-fab` capture button
that sits *outside* the nav. Inside `.bottom-nav` there is an absolutely
positioned `.nav-pill` that slides via `--nav-index`.

Consequences, all learned the hard way:

- The pill is positioned by an **index into the app's own tab array**. Inserting
  ahead of a native tab shifts that tab one cell right while its index stays put,
  so the highlight lands under the wrong tab. **Append, never insert.**
- The pill is `position:absolute` and must never be counted as a tab, cloned as a
  template, or laid out as a grid cell.
- `.scan-fab` is already a capture button. Adding another is a duplicate.

**Do not trust the nav description in `PROGRESS-PHOTOS.md` §9/§10** — it describes
`Today · Progress · Scan · Settings` with a lime accent, which was true before the
2026-08-20 restyle and is not true now.

---

## 7. Verify before deploying — no excuses

The frontend is readable. There is no reason to guess at it any more.

```bash
node tools/stub-frontend.mjs 8141 path/to/progress-client.js
```

Serves the real built app from `macroflow-app/dist` against stubbed APIs, and
injects the client exactly as the Worker does. Two response shapes are
load-bearing and easy to get wrong:

- **`/api/settings`** must include `today` — `App.tsx` calls
  `setSelectedDate(next.today)` on boot, and without it `Today.tsx` throws
  `RangeError: Invalid time value` in `toISOString` before React ever mounts.
- **`/api/dashboard`** returns `{ date, settings, totals, meals }` with the
  **whole settings object embedded**, not a `targets` field.

Check at 320 / 375 / 390 / 414 / 430 / 760 / 1200 px.

> ### Extract the client from the compiled module, not with a regex
>
> `PROGRESS_CLIENT_SOURCE` is a template literal inside `worker/progress-assets.ts`.
> Pulling it out by regex silently produces a **stale or truncated** file when the
> extractor fails, and you then spend an hour debugging code that is not running.
> That happened on 2026-08-29 and produced a completely fictitious bug report.
>
> Build first, then import the compiled module:
>
> ```js
> import { PROGRESS_CLIENT_SOURCE } from './mods/progress-assets.js';
> ```
>
> and assert on it — `hasNativePhotosTab` should appear twice, and the file should
> be ~38 KB. If a check like that is cheap, add it.

---

## 8. Known mismatches still outstanding

The React app calls these; `master`'s Worker does **not** serve them:

- `/api/telegram/status`
- `/api/benchmark/cases`, `/models`, `/research`, `/run`

They fail quietly in the UI. Reconciling the forks is the real fix, and per the
memory note that work **starts with a D1 export**, because `photo_crypto` is the
only key to any encrypted photo.

Also open:

- `d1_migrations` under-reports. It ends at `0004`; `0005`–`0008` are live in the
  database but absent from the ledger because they were applied with
  `d1 execute --file`. **Trust `sqlite_master`, not the ledger.**
- `UNLOCK_MINUTES` is 3 in the Worker, described as 15 in the frontend copy.

---

## 9. Checklist

Before deploying anything that touches photos or the nav:

- [ ] `SELECT COUNT(*) FROM progress_photos WHERE encrypted = 1;` before going
      anywhere near `photo_crypto`
- [ ] KV listed **with `--remote`**, every `image_path` matched
- [ ] Client extracted from the **compiled module**, size and guard asserted
- [ ] Served against `tools/stub-frontend.mjs` and checked at mobile widths
- [ ] `injectedNavItems === 0` while the app has its own Photos tab
- [ ] Staged version audited: six bindings, secrets `inherit`,
      `raw_run_worker_first: true`
- [ ] Promote, then diff the deployed script against `dist/worker.js`
