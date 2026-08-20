# Deploying the redesign without losing what production already has

A runbook for shipping the carrot/warm-off-white restyle to
`jamtytrack.montagnertudor.org`. It assumes [ENGINEERING.md](ENGINEERING.md) for
everything general and only covers what is specific to this change.

Read §1 before touching anything. It is the part that can actually cost you
data, and it is not about the restyle.

---

## 1. Stop: confirm which code is live

**This repository holds two unrelated histories.** `master` and `source` have no
common ancestor — `git merge-base master origin/source` returns nothing. They are
parallel forks of the same product, and **neither is a superset of the other**:

| | `source` | `master` |
| --- | --- | --- |
| App | React + Vite SPA, renamed **Jamtytrack** | recovered production bundle (`recovered/BUNDLE-FULL.js`) |
| Has | photo encryption, onboarding, benchmark lab | push notifications, weekly reports, fibre foods |
| Worker | `worker/{analysis,auth,db,index,telegram}.ts` | `worker/{progress,push,reminders,reports}.ts` |
| Migrations | `0001`–`0005` | `0004`–`0007`, **different files, colliding numbers** |
| `wrangler.jsonc` | complete: `main`, `assets`, `routes` | **deliberately partial** — no `main`, no `assets` |

The restyle lives on **`source`**.

`master`'s config omits `main` and `assets` on purpose, and its own comment says
why: when it was written the deployed Worker was the only copy of the source, so
a config complete enough to deploy from could have overwritten production with an
assets-only build. **Leave it partial.** It is a guard, not an oversight.

### What you must check before deploying

Nothing in the repo records which fork is running in production. Find out:

```bash
npx wrangler deployments list
```

```bash
npx wrangler versions list
```

If you need to see the actual running code, the dashboard under **Workers &
Pages → macroflow** shows it. Pulling the deployed bundle from the API is also
possible; the endpoint and the token caveat are written up in `recovered/README.md`
**on the `master` branch** (that directory does not exist here).

> **If production is currently running `master`'s feature set, deploying
> `source` removes push notifications, weekly reports and the reminder cron.**
> The D1 rows behind those features survive untouched — the endpoints and the
> scheduled behaviour do not. That is a feature loss, not a data loss, but it is
> the single most likely way this deploy hurts. Reconcile the forks first if so.

---

## 2. What the restyle actually changes

Six files, all presentation:

| File | Change |
| --- | --- |
| `src/styles.css` | palette, type, radii, shadows, floating nav rules |
| `src/components/Layout.tsx` | bottom bar → floating pill + detached capture button |
| `src/screens/Today.tsx` | macro ring colours read from CSS tokens |
| `worker/auth.ts` | login gate `<style>` block, `theme-color`, font `<link>`s |
| `index.html` | `theme-color`, iOS status bar style |
| `public/manifest.webmanifest` | PWA theme and background colour |

**No schema. No migrations. No auth logic. No API contracts. No data access.**
The `worker/auth.ts` diff touches only the inline CSS and `<head>` of the login
page — session signing, `verifyPassword`, `constantTimeEquals` and the lockout
are byte-identical.

So the deploy itself cannot lose diary data. Everything dangerous below is a
thing you might do *around* it.

---

## 3. What can actually destroy data

### The `photo_crypto` row is the only key to every body photo

Photos are encrypted in the browser with a random master key. That key is never
sent to the Worker — it exists only as **two wrapped copies** in the
`photo_crypto` table in D1 (one wrapped by the passphrase-derived key, one by the
recovery key shown once at setup). KV holds ciphertext that Cloudflare cannot
read.

**Drop or recreate that row and every body photo becomes permanently
unrecoverable**, even though the KV blobs are still sitting there intact. There
is no backup path other than the recovery key.

Never `DROP`/recreate it, and back it up before any manual D1 work.

### Secrets you should not touch for this deploy

- **`APP_PASSWORD`** — the session signing key is derived from it, so changing it
  signs out every device. Not data loss, but not needed here either.
- **`PHOTO_PASSPHRASE`** — changing the passphrase is a *re-wrap performed in the
  browser* through the app's own flow. Rotating the Cloudflare secret on its own
  re-wraps nothing and will not match the verifier stored in D1.

### Both checkouts point at live storage

`master` and `source` both carry D1 `978a69cc-…` and KV `cafdcdcb…`. **Any
`--remote` D1 command from either folder hits production**, including from
`Escritorio\macros`. Local work must use `--local`.

### `dist/` is gitignored

Anything hand-dropped there disappears on the next build and never shows in
`git status`. Static files belong in `public/`.

---

## 4. Back up first

```bash
npx wrangler d1 export macroflow --remote --output backup-before-redesign.sql
```

Keep it outside the repo. It is a full copy of your diary.

---

## 5. Migrations: not required for this change

The restyle adds none, so **skip this step**.

For reference, if you ever do run `source`'s migrations against a database that
already has data: they are non-destructive. All eight `CREATE TABLE` statements
in `0001_init.sql` use `IF NOT EXISTS`, the food seed is `INSERT OR IGNORE`, and
there is no standalone `DELETE`, `DROP`, `TRUNCATE` or `UPDATE` anywhere in the
set — the only match for those keywords is an `ON DELETE CASCADE` foreign-key
clause on `meal_items`, which is table definition, not a deletion.

The catch is bookkeeping, not destruction: **D1 tracks applied migrations by
filename, not by number.** Because the two forks reused `0004` and `0005` for
different files, running `source`'s set against a database migrated by `master`
applies all five as new names. Harmless given the above, but it makes the
`d1_migrations` table a poor record of what the schema actually is.

```bash
pnpm d1:migrate
```

---

## 6. Deploy

```bash
pnpm run deploy
```

**The `run` is not optional.** `deploy` is also a built-in pnpm command and the
built-in shadows the script, so bare `pnpm deploy` never reaches it.

That runs `pnpm check` (typechecks app *and* Worker), then `vite build`, then
`wrangler deploy`.

Both gates pass on this change: `pnpm check` is clean and `vite build` succeeds.
`pnpm test` shows 20 passing with one suite failing to *load* —
`server/analysis.test.ts` needs `node:sqlite`, which does not exist before Node
22.12. That failure predates the restyle and is environmental; upgrading Node
clears it, and it does not block the build.

### If you need to set a secret — the versions trap

This Worker is managed as **versions**. `wrangler secret put` fails outright, and
the versioned form creates a version *without rolling it out*:

```bash
npx wrangler versions secret put APP_PASSWORD
```

```bash
npx wrangler versions deploy PASTE_THE_PRINTED_ID@100% --yes
```

The id and `@100%` are **one token with no space**. `wrangler secret list` reads
the newest version, so a secret can look configured while the running code cannot
see it. The dashboard — **Settings → Variables and Secrets** — saves and deploys
in one step and sidesteps all of it.

---

## 7. Rollback

```bash
npx wrangler versions list
```

```bash
npx wrangler rollback PASTE_THE_PREVIOUS_VERSION_ID
```

Because this change is presentation-only, rolling the Worker back is a complete
undo — there is no schema or data migration to reverse.

---

## 8. Verify after deploying

1. The login gate is dark warm ink with a carrot pill button, not green.
2. Sign in with your **existing** production passphrase — it is unchanged.
3. Today: calorie hero is a white card, macro rings are carrot / gold / blue /
   sage.
4. On a phone: the nav floats clear of the edge and the capture button sits
   outside the pill.
5. **Unlock body photos with your existing passphrase.** This is the check that
   proves the encryption path is untouched — do not skip it.
6. If production runs the Telegram or reminder features, confirm they still
   respond.

---

## 9. Windows / PowerShell

This project is developed on Windows and these have all cost time before:

- `&&` is not a separator in Windows PowerShell 5.1. Use `;`, or
  `A; if ($?) { B }` when the second depends on the first.
- `<` is reserved, so any `<placeholder>` fails before wrangler runs. That is why
  every placeholder above is written as `PASTE_THE_…`.
- `curl` is an alias for `Invoke-WebRequest` and has no `-X`. Use
  `Invoke-RestMethod -Method Post`, or call `curl.exe` explicitly.
- `pnpm` may not be on PATH. `npx --yes pnpm@10 …` works, and
  `npx --yes pnpm@10 --dir C:\path\to\repo <script>` avoids `cd` entirely.
