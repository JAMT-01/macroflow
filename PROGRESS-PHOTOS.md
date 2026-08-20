# Progress photos — setup, and who can actually see them

Body progress photos for MacroFlow: capture, timeline, and a same-pose
before/after comparison with the bodyweight delta.

`macros.md` §10 lists **Photos — every 4 weeks — same light, pose, time of day**
as the metric that "catches what the scale can't", and it was the only row in
that table with nowhere to go. Weight has `weight_entries`; this is the visual
companion to it.

| Piece | Status |
|---|---|
| `migrations/0007_progress_photos.sql` | ✅ **applied** 2026-08-19 (§3) |
| `worker/progress.ts` — storage + CRUD | ✅ **deployed** |
| `worker/progress-assets.ts` — injected UI | ✅ **deployed**; client verified in a browser (§6) |
| Routes wired into the Worker | ✅ **deployed** 2026-08-19, version `605f2295` (v18) |

**Live since 2026-08-19.** Deployed without a source-tree rebuild — see §8 for
how, and why that was the lower-risk option. The launcher is a **nav-bar tab
built by cloning one of the app's own**, and the palette is read from the running
app rather than hardcoded — §9.

§2 below documents the wiring as source edits, for whenever the real tree does
get rebuilt. It is a description of what is already running, not a to-do.

---

## 1. How it is put together

Three pieces, following patterns already in the codebase:

- **Metadata in D1, bytes in KV.** Identical to meal photos, and forced by the
  same constraint — R2 is not enabled on this account (API error 10042,
  re-confirmed 2026-08-19). Images in D1 would bloat the database and land in
  `/api/export`'s JSON.
- **UI injected with HTMLRewriter into a shadow root.** Copied wholesale from
  `worker/push-assets.ts`, for the same reason: the frontend lives in the
  `ASSETS` binding and there is no local copy of that source, so a feature that
  needs UI has to bring its own.
- **A separate KV prefix, `progress/` rather than `uploads/`.** This is the
  privacy boundary, not a naming preference — see §4.

The client downscales to a 1600 px long edge and re-encodes as JPEG before
upload. That is mostly about **stripping EXIF** (§4.4); the ~10x size reduction
is a side benefit.

Styling is **read from the running app**, not hardcoded — see §9.

---

## 2. Wiring into `worker/index.ts`

Four edits.

### 2.1 Imports

```ts
import {
  saveProgressPhoto,
  listProgressPhotos,
  getProgressPhotoBytes,
  deleteProgressPhoto,
  isPose,
} from './progress';
import { progressClientResponse, injectProgressClient } from './progress-assets';
```

### 2.2 API routes

Place these with the other `/api/` routes:

```ts
app.get('/api/progress', async (c) => c.json({ photos: await listProgressPhotos(c.env) }));

app.post('/api/progress', async (c) => {
  const form = await c.req.formData();
  const image = form.get('image');
  if (!image || typeof image === 'string') return c.json({ error: 'Add a photo' }, 400);
  // Check size before arrayBuffer(), as /api/analyze does — otherwise a huge
  // upload is fully buffered into memory just to be rejected afterwards.
  if (image.size > 15 * 1024 * 1024) return c.json({ error: 'That photo is larger than 15 MB' }, 400);

  const pose = String(form.get('pose') || 'front');
  if (!isPose(pose)) return c.json({ error: 'Unknown pose' }, 400);

  const rawWeight = form.get('weightKg');
  const weightKg = rawWeight ? Number(rawWeight) : null;
  if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 20 || weightKg > 400)) {
    return c.json({ error: 'Enter a valid weight' }, 400);
  }

  const photo = await saveProgressPhoto(c.env, {
    bytes: await image.arrayBuffer(),
    contentType: image.type,
    pose,
    takenAt: String(form.get('takenAt') || '') || undefined,
    weightKg,
    notes: String(form.get('notes') || ''),
  });
  return c.json(photo, 201);
});

app.delete('/api/progress/:id', async (c) => {
  const deleted = await deleteProgressPhoto(c.env, c.req.param('id'));
  return deleted ? c.json({ ok: true }) : c.notFound();
});
```

The weight bounds (20–400 kg) are copied verbatim from `POST /api/weight` so the
two entry points cannot disagree about what a plausible bodyweight is.

### 2.3 Serve the bytes and the client script

Both must sit **above** the `app.all('*')` asset fallthrough:

```ts
app.get('/progress-client.js', () => progressClientResponse());

app.get('/progress-photos/:key', async (c) => {
  const photo = await getProgressPhotoBytes(c.env, c.req.param('key'));
  if (!photo) return c.notFound();
  return c.body(photo.bytes, 200, {
    'content-type': photo.contentType,
    'cache-control': 'private, max-age=31536000, immutable',
    'vary': 'Cookie',
  });
});
```

**Do not add either path to `PUBLIC_PATHS`.** Push had to exempt `/sw.js`
because the browser re-fetches it on a schedule and a gated one breaks silently.
Neither of these has that problem, and both should stay behind the gate.

Headers match the existing `/uploads/:key` route. `private` keeps the image out
of any shared cache; `Vary: Cookie` means a cache that does store one keys it on
the session rather than handing it to a signed-out visitor. If you would rather
no copy touched disk at all, swap in `no-store` — the cost is that every gallery
open re-downloads every thumbnail over mobile data.

### 2.4 Inject the client

```ts
app.all('*', async (c) => injectProgressClient(await c.env.ASSETS.fetch(c.req.raw)));
```

`ASSETS.fetch` returns a Promise, so this handler has to be `async` — the
current one is not. If push is wired up too, chain them in one handler:

```ts
app.all('*', async (c) =>
  injectProgressClient(injectPushClient(await c.env.ASSETS.fetch(c.req.raw))));
```

---

## 3. The migration — applied 2026-08-19

```bash
export CLOUDFLARE_ACCOUNT_ID=6c3b2df3d669fda007025e023ffee12c
npx wrangler d1 execute macroflow --remote --file migrations/0007_progress_photos.sql
```

Done. `progress_photos` exists with 0 rows, alongside both indexes
(`progress_photos_taken`, `progress_photos_pose_taken`) — confirmed by reading
back `sqlite_master`. The database is now 13 tables.

Applied directly rather than via `d1 migrations apply`, matching what was done
for `0005` and `0006` — both are live in the database but absent from
`d1_migrations`, which still ends at `0004`. Worth knowing before trusting that
ledger: **it under-reports by three migrations.**

The routes are live (§8), so this table is now writable from the app. Dropping it
would break them — only do this alongside a Worker rollback:

```bash
npx wrangler d1 execute macroflow --remote --command "DROP TABLE progress_photos;"
```

---

## 4. Privacy — the actual answer

You asked whether these photos are only for you. Split into the parts you
control and the parts Cloudflare controls, because the honest answer differs.

### 4.1 Who can fetch them

Only a signed-in session. `worker/index.ts` gates everything except
`/api/health`, `/api/auth/login`, and the Telegram webhook, and neither
`/progress-photos/:key` nor `/api/progress` is exempt. A signed-out request gets
`401`, not the image.

There is no public URL for a KV object — KV is reachable only through a Worker
binding or an authenticated API call with your account credentials. The
filenames are UUIDs, but that is not what is protecting them; the password gate
is.

Practical consequences worth naming:

- **The gate is one shared password.** Anyone who has it has every photo. That
  is the whole access-control model — there are no per-object permissions.
- **`login_attempts` gives per-IP lockout** after repeated failures, so the
  password is not brute-forceable at speed.
- **A stolen session cookie is enough.** It is a signed cookie with no device
  binding.

### 4.2 What Cloudflare's terms say

From the [Self-Serve Subscription Agreement](https://www.cloudflare.com/terms/):

> You and your End Users…will retain all right, title and interest in and to any
> data, content, code, video, images or other materials of any type that you or
> your End Users transmit to or through the Services

Cloudflare takes a licence to "collect, use, copy, store, transmit, modify and
create derivative works of Customer Content, **in each case to the extent
necessary to provide the Services**." That trailing clause is the load-bearing
part: it is a licence to operate the storage, not to do anything else with the
contents. Their [GDPR trust page](https://www.cloudflare.com/trust-hub/gdpr/)
adds that they "do not sell personal data we process, or use it for any purpose
other than delivering our services."

Cloudflare also reserves ownership of statistics and models *derived from*
server, network and traffic data — that is aggregate operational telemetry
(request counts, latencies), not your image contents.

Nothing in the self-serve terms grants training rights over customer content,
and Workers AI is documented as a separate service that does not train on
customer data. You are not using Workers AI here in any case.

### 4.3 What that does and does not guarantee

Accurate version, since this is the part that is easy to overstate:

- **Encrypted at rest**, AES-256-GCM, automatic, no configuration
  ([KV data security docs](https://developers.cloudflare.com/kv/reference/data-security/)).
- **Encrypted in transit**, TLS, both Worker↔KV and any API access.
- **Decrypted only by the process running your Worker** or answering your
  authenticated API requests.
- **Cloudflare holds the encryption keys.** This is not end-to-end or
  zero-knowledge encryption. It protects against a stolen disk or an intercepted
  network path; it does not make it mathematically impossible for Cloudflare to
  read the bytes. What stops that is contractual and procedural, not
  cryptographic.
- **Valid legal process can still compel disclosure.** No storage provider is an
  exception to that.

So: private in the ordinary sense, and Cloudflare has committed not to look at
or monetise them. Not private in the "nobody physically could" sense. If you
want that property, the photos would have to be encrypted in the browser with a
key that never reaches the Worker — a real change, and it would break
server-side thumbnailing forever. Given the threat model here (a personal
tracker on your own domain), the current design is a reasonable place to stop.

### 4.4 The parts that actually matter more

Three concrete things, in rough order of how much they matter:

**1. Progress photos never go to the LLM.** This is the real risk in this app,
and it is worth being blunt about: **meal photos are uploaded to OpenRouter**, a
third party, on every analysis — that is the app's core feature working as
designed. Body photos have no reason to leave Cloudflare, and no code path in
`worker/progress.ts` gives them one.

The separation is enforced by the KV prefix. Meal photos are `uploads/…`,
these are `progress/…`, and `/api/analyze` only ever analyses paths it minted
itself.

**One gap, worth closing while you are in there.** `POST /api/analyze/refine`
takes the whole `analysis` object from the request body and re-sends every path
in `imagePaths` to OpenRouter (`worker/analysis.ts`, the loop calling
`imageContent`). It trusts a client-supplied path, so anything in KV — including
a progress photo — could be pushed to OpenRouter by a request naming it. Only a
signed-in caller can do that, so this is not a hole an outsider can reach, and
today's frontend never sends such a path. But it is one frontend bug away from
mattering, and the fix is two lines in `imageContent`:

```ts
async function imageContent(env, imagePath) {
  // Meal photos only. Body photos live under progress/ and must never be
  // uploaded to a third-party model.
  if (!imagePath.startsWith('/uploads/')) return null;
  const photo = await getPhoto(env, photoKey(imagePath));
  …
}
```

That turns the prefix convention into an enforced boundary.

**2. GPS coordinates are stripped before upload.** iPhone photos carry the
location they were taken in, in the EXIF block. Nothing upstream removes it, so
a photo taken at home would otherwise store your home address alongside it. The
client re-encodes through a canvas, which drops EXIF entirely — verified by
inspecting the output bytes (§6). EXIF *orientation* is applied before it is
discarded, so portrait photos are not stored sideways.

**3. Deletion removes the bytes first, then the row.** The reverse of how
`DELETE /api/meals/:id` does it, on purpose. If the second statement fails you
get a row rendering a broken thumbnail — annoying, deletable. Row-first would
fail the other way: gone from the UI, still in KV, with nothing left pointing at
it to ever clean it up.

### 4.5 Two things outside Cloudflare

- **This directory is in OneDrive.** Anything written here syncs to Microsoft.
  No photos are stored locally by this feature, so that is fine today — but do
  not export images into this folder without meaning to.
- **`/api/export` does not include progress photos.** It dumps meals, items,
  weights and memories. If you add progress photos to it, you are creating a
  file that leaves the app with your body photos in it, so decide that
  deliberately.

---

## 5. Storage budget

At three poses every four weeks, downscaled to ~250 kB each:

| | Photos | Storage |
|---|---|---|
| Per session | 3 | ~0.75 MB |
| Per year | 39 | ~10 MB |
| KV free-tier limit | — | 1 GB |

Not a constraint this decade. Writes are ~39/year against a 1,000/day limit.

If an upload ever half-fails, the KV object is written before the row, so the
leftover is an unreferenced object rather than a broken row. To find them:

```bash
npx wrangler kv key list --namespace-id cafdcdcb096c4b23b5978317a08a0fa1 --remote \
  | grep '"progress/'
npx wrangler d1 execute macroflow --remote --command "SELECT image_path FROM progress_photos;"
```

Anything in the first list and not the second is orphaned and safe to delete.

> **`--remote` is not optional in those commands.** Without it, `wrangler kv key
> list` reads the local `.wrangler` simulation and returns `[]` on a namespace
> that is not empty. That is exactly what produced "Known issue #1: orphaned meal
> photos, PHOTOS contains zero keys" in `macroflow-kb.md` §5 — the namespace
> actually holds all 6 meal photos. That issue is retracted; see §7.

---

## 6. What is verified, and what is not

**Verified** — the client script was extracted from the template literal and
driven in a real browser against a stub of the API:

- mounts, opens, and renders the timeline grouped by local date, newest first
- weight and photo count per session, with correct singular/plural
- compare view pairs oldest against newest **of the same pose**, and computes
  the delta: two front shots four weeks apart at 94.2 → 96.4 kg rendered
  `4 weeks apart · +2.2 kg (+0.55 kg/week)`
- refuses to compare a pose with fewer than two photos
- a 4032×3024 upload is resized to exactly 1600×1200, aspect preserved
- the re-encoded JPEG contains only APP0 (JFIF) and APP2 (ICC) segments — **no
  APP1**, which is where EXIF and GPS live; no `Exif` header, no `GPS` tag
- delete removes the photo and falls back to the empty state
- no console errors through any of it

**Verified after deployment** — see §8 for the full list, including that the live
script is byte-identical to `dist/worker.js` and all five routes answer.

**Still not verified** — everything behind the password gate, which no automated
check can reach:

- `saveProgressPhoto` / `deleteProgressPhoto` against real D1 and KV
- the HTMLRewriter injection against the real asset HTML
- that the frontend still renders at all (the 401 login page is inline in the
  Worker and never touches the `ASSETS` binding)
- the FAB's position against the real app UI. It sits bottom-right, 88 px above
  the safe-area inset, which should clear a bottom tab bar — but the app's
  layout is unknown, so this may need nudging. It is one `bottom:` value in
  `worker/progress-assets.ts`, rebuilt with `node tools/build-worker.mjs dist`.

---

## 7. Correction to `macroflow-kb.md` §5

Known issue #1 — "Orphaned meal photos… the `PHOTOS` KV namespace contains
**zero keys**" — is **wrong**, and was wrong when written.

The namespace holds all 6 meal photos. The finding came from a
`wrangler kv key list` run without `--remote`, which silently reads the local
`.wrangler` simulation instead of the real namespace and returns `[]`. Confirmed
2026-08-19 by listing with `--remote` and by a write/read/delete round-trip.

No meal photos are missing and no image references are dangling.

---

## 8. How this was deployed without a source tree

`macroflow-kb.md` §10 listed "rebuild a buildable source tree" as the blocker for
every pending feature. That turned out not to be the only option, and the
alternative is lower risk.

### The problem

`wrangler deploy` needs `main` **and** `assets`. The frontend exists only in
Cloudflare's asset store attached to the Worker. There is no local copy, no API
to download it back (the `/assets` endpoints just return script content), and the
site is 401-gated so it cannot be scraped. Wrangler has no `--keep-assets` flag.

A normal deploy would therefore drop the `ASSETS` binding **and delete the asset
store** — old assets are deleted immediately by default, which is what
`--old-asset-ttl` exists to defer. With no copy anywhere, that is unrecoverable.
This is what the comment in `wrangler.jsonc` was warning about.

### What was done instead

Two things, neither of which touches the asset store.

**1. Patch the production bundle rather than rewrite it.** `recovered/BUNDLE-FULL.js`
is the exact non-minified bundle pulled from the live Worker. `tools/build-worker.mjs`
compiles `worker/progress.ts` and `worker/progress-assets.ts`, strips their module
syntax (the bundle is one flat scope and `getSettings`, `dateInTimeZone` and the
photo helpers are already top-level in it), and splices them in at a single anchor:

```js
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
```

The anchor must match **exactly once** or the build aborts. The resulting diff
against production is *one removed line* — that anchor — with everything else
byte-identical. Rerun it with:

```bash
node tools/build-worker.mjs dist
```

**2. Upload as a staged version with `keep_assets`.** Wrangler cannot express
this, so it went through the raw API (`dist/metadata.json` is the exact payload):

```jsonc
{
  "main_module": "index.js",
  "keep_assets": true,                    // reuse the existing asset store
  "assets": { "config": {                 // preserve the serving behaviour
    "not_found_handling": "single-page-application",
    "run_worker_first": true } },
  "bindings": [
    { "type": "inherit", "name": "APP_PASSWORD" },        // secrets carried
    { "type": "inherit", "name": "OPENROUTER_API_KEY" },  // forward by value-less
    …                                                     // inherit
  ]
}
```

`POST …/workers/scripts/macroflow/versions` creates a version that serves **no
traffic**. That made the bindings auditable before anything went live — and they
came back an exact structural match to production: all six bindings, both secrets
inherited, `ASSETS` present, and `raw_run_worker_first: true` preserved.

That last one matters for more than behaviour. If `run_worker_first` were lost,
static assets would be served **before** the Worker runs, which means **before the
password gate** — the whole frontend would go public. Worth re-checking on any
future deploy that goes through this path.

Only then was it promoted with `POST …/deployments` at 100%.

### Verified after promotion

- `/api/health` → `200 {"ok":true,"storage":"d1"}` — boots, D1 reachable
- `/` → `401` serving the 2,242-byte login page, not a 500
- `/api/progress`, `/progress-client.js`, `/progress-photos/:key` → `401` (gated)
- `/api/settings`, `/api/dashboard`, `/uploads/:key` → `401`, unchanged
- the deployed script pulled back down is **byte-identical** to `dist/worker.js`

### Not verified

Everything behind the password gate, because the gate is a secret and correctly
so. Nobody has confirmed by eye that the camera button appears, that an upload
round-trips, or — the one that matters most — **that the frontend still renders**.
The login page is inline in the Worker, so a 401 does not exercise the `ASSETS`
binding at all. `keep_assets` and the binding audit are strong evidence, not
proof.

**Sign in and load the app.** If anything is wrong, roll back:

```bash
npx wrangler rollback --name macroflow
```

The previous version is `1f24e9ee-7d5f-43ed-adb0-5286f8b118ff`. Rollback is safe:
nothing in this deploy wrote to or deleted the asset store.

### The single point of failure is smaller now

`dist/worker.js` is a local copy of exactly what is running — the first time that
has been true. `recovered/BUNDLE-FULL.js` stays as the pristine pre-feature base
that `tools/build-worker.mjs` patches; do not overwrite it (the build would abort
on a missing anchor rather than double-apply, but keep it clean anyway).

The **frontend** is still the real exposure. It exists in exactly one place, and
this deploy did not change that. Backing it up is now the most valuable
outstanding task in the project.

---

## 9. Theming — read from the app, not hardcoded

The first version shipped a fixed iOS-dark palette: `#0b0b0c` surfaces, `#0a84ff`
accent, system font. `settings.theme` is **light**, so it looked pasted in from a
different app. It was.

The cause is structural, not carelessness. There is still no local copy of the
frontend (`macroflow-kb.md` §9) and the site is 401-gated, so the design could
not be looked at — and the UI renders into a **shadow root**, which was chosen
precisely so it would inherit none of the app's CSS. Isolation was doing exactly
its job, and its job was wrong here.

### What it does instead

`readTheme()` samples the live page at mount and `buildStyle()` builds the
stylesheet from the result:

| Token | Where it comes from |
|---|---|
| `bg` | first ancestor of `body` with a non-transparent `background-color` |
| `text` | `body`'s computed `color` |
| `font` | `body`'s computed `font-family` |
| `accent` | `:root` custom property (`--accent`, `--primary`, `--brand`, …), else the most common saturated `button` background, else a neutral blue |
| `radius` | majority vote of non-zero `border-radius` across real controls |
| `surface` | `bg` shifted one step — lighter on a dark page, darker on a light one |
| `muted` / `border` | `text` blended toward `bg` at 45% / 86% |
| `onAccent` | black or white, chosen by the accent's luminance |

Three details that matter:

- **Light/dark is derived, not assumed.** Luminance of the page background
  decides which way `surface` moves. Flip the app's theme and this follows, with
  no redeploy.
- **The accent is validated, not just read.** A candidate under 0.15 saturation
  is rejected — a grey "accent" would make every primary control disappear.
- **`radius` is a majority vote.** Sampling the first control found returned
  `0px` from an unstyled ghost button in testing, losing the app's real `4px`.

### Verified

Against two synthetic host pages, since the real one is unreachable:

- **Light host** (`#f7f7f5`, Georgia, `--accent: #16a34a`) → sheet background
  `rgb(247,247,245)`, text `rgb(28,27,25)`, accent green, Georgia inherited.
- **Dark host** (`#121214`, Inter, no custom property, yellow `#ffd60a` buttons)
  → accent found by button-scan, `onAccent` correctly flipped to **black**,
  surface (luminance 0.14) correctly *lighter* than background (0.07), radius
  `4px` picked over the ghost button's `0px`.
- Timeline, compare (`4 weeks apart · +2.2 kg (+0.55 kg/week)`) and the add form
  all still work after the refactor; no console errors.

### If it still looks wrong

Most likely causes, in order:

1. **The app paints its background on an inner container**, not `body` or `html`
   — the walk up from `body` would find the wrong colour. Fix: extend
   `pageBackground()` to sample the largest visible element instead.
2. **The accent lives in a class, not a custom property, on elements that are not
   `button`/`a`/`[role=button]`** — widen the selector in `accentColor()`.
3. **The floating button itself is the problem.** It is a deliberate compromise:
   with no frontend source there is no navigation to hang a menu item off. When
   the frontend is recovered, move the launcher into the real nav and delete
   `.fab` entirely.

All three are edits to `worker/progress-assets.ts`, then:

```bash
node tools/build-worker.mjs dist
```

and redeploy via §8. A screenshot of the app would settle which one applies in
about ten seconds.

---

## 10. The nav item, and the end of building blind

A screenshot of the running app finally arrived on 2026-08-19. Three of the four
problems it revealed were things no amount of local testing could have caught,
because they were all facts about an app that could not be seen.

### What the screenshot showed

The real nav is a fixed bottom bar: **Today · Progress · Scan · Settings**, with
a raised dark circle for Scan. The palette is a warm off-white page with a
**lime-green** accent (`#c5f04a`-ish) that appears on a chip inside a pale card,
on small heading text, and as the Scan icon colour — **never as a button's own
background**.

| Problem | Cause | Fix |
|---|---|---|
| Blue floating button in a lime app | `accentColor()` read only `backgroundColor` **of controls themselves**. Every button here is near-white; the accent lives on a child chip. Nothing matched, so it fell through to a hardcoded blue. | Scan control **descendants** for saturated backgrounds and text, plus saturated headings. Fall back to the app's own text colour, never a hue. |
| Floating button over content | No nav to attach to — it was the only option available without the frontend source. | Clone a real nav item (below). |
| Label would have read "Progress" | The nav **already has** a Progress tab (the charts). | Label it **Photos**. |
| Native file input, unstyleable, wrong locale | A bare `<input type=file>` renders browser chrome. | Hide it; drive it from a styled button that shows the chosen filename. |

### Why the item is cloned, not built

`buildNavItem()` takes an existing nav child, `cloneNode(true)`s it, strips the
active-state attributes and classes, swaps the icon for an outline camera SVG
using `currentColor`, and relabels the deepest text node.

A hand-built item would need the app's class names, icon sizing and active-state
markup — none of which are knowable from here. The clone carries all of it for
free, so it matches whatever the nav happens to look like. Verified: the injected
item's computed `display`, `flex-direction`, `font-size`, `padding` and `flex`
are **identical** to its siblings.

It is inserted **second-to-last**, not appended: Settings conventionally sits
last, and at five items this also puts the raised Scan button dead centre
instead of right-of-centre.

### The glitches

Two real bugs, both mine:

1. **Mounted on `DOMContentLoaded`.** In an SPA the body is still empty then, so
   `readTheme()` sampled an unpainted page and `accentColor()` had no buttons to
   scan. `start()` now polls for the nav (150 ms, 6 s ceiling) before mounting.
2. **The host contributed a line box.** It is now zero-sized and
   `position:fixed`, so it cannot affect the app's layout. A fixed ancestor does
   not create a containing block for fixed descendants, so the sheet still
   covers the viewport.

An SPA re-render replaces the nav and takes the item with it, so a
`MutationObserver` re-inserts it — **coalesced to one check per animation frame**,
because re-inserting on every mutation is itself a source of flicker.
`ensureNavItem()` no-ops when the item is already present.

Verified: exactly **one** item after three full re-renders and 60 DOM mutations.

### If the nav is ever not found

`findNav()` scores candidates (wide, short, ≥2 controls, fixed or bottom-anchored)
rather than matching a selector. If nothing scores, the floating button returns as
a fallback and the observer swaps it for a nav item the moment one appears.

The width floor is `min(50% of viewport, 280px)` — a plain 50% gate rejected a
legitimate 336 px bar in a 966 px window during testing.

### Still worth doing

A screenshot settled in one message what three deploys of inference could not.
**The frontend is still unreadable from here**, so anything below the level of
"clone what is already there" remains inference. Backing up the frontend would
end that permanently, and it is still the highest-value task in the project.
