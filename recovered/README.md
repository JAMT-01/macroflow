# Recovered Worker source

Pulled from the live Cloudflare Worker on **2026-08-18**, when no local checkout
existed and the deployed script was the only copy of the code.

## What this is — and is not

This is the **deployed esbuild bundle**, split back into files using the
`// path/to/file.ts` markers esbuild leaves in its output. It is *not* the
original TypeScript:

- types are erased (the build strips them)
- `import`/`export` statements are gone — esbuild inlined the modules
- every function carries an `__name(...)` registration and `/* @__PURE__ */`
  annotations from the bundler
- the `.ts` extensions preserve the **original paths**, but the contents are JS

It is fully readable — the deploy was not minified, so names and structure
survived — and it is a faithful record of what is running in production. Treat it
as reference for a rewrite, not as a drop-in buildable source tree.

## Layout

| File | Lines | What it holds |
|---|---|---|
| `shared/time.ts` | 97 | timezone helpers — `partsAt`, `dateInTimeZone`, `dateRangeUtc`, `addCalendarDays`, `getTimeContext` |
| `shared/analysis-core.ts` | 409 | food matching, portion maths, vision/description prompt building |
| `worker/db.ts` | 59 | `getSettings`, `listFoods`, app-secret and photo helpers |
| `worker/analysis.ts` | 252 | OpenRouter calls for meal analysis |
| `worker/telegram.ts` | 132 | bot messaging, `checkReminders` |
| `worker/auth.ts` | 132 | password gate, sessions, per-IP lockout |
| `worker/index.ts` | 491 | Hono app, all API routes, the `fetch`/`scheduled` export |
| `BUNDLE-FULL.js` | 18,714 | the complete bundle, including vendored hono 4.13.1 and zod 4.4.3 |

Roughly 1,570 lines are application code; the remaining ~17,000 in the full
bundle are those two dependencies.

## Facts this corrected

- **`main` is `worker/index.ts`**, not `src/index.ts` as the KB previously
  reconstructed. The layout is `worker/` + `shared/`, with no `src/`.
- The stack is **Hono** (routing) and **Zod** (request validation), installed
  with **pnpm**.
- The duplicated OpenRouter credential is **deliberate**, not an accident:
  `getOpenRouterApiKey` reads `env.OPENROUTER_API_KEY` and falls back to the
  `app_secrets` row, so the env var wins and the table is the UI-settable
  fallback.

## How it was retrieved

`GET /workers/scripts/{name}/content` rejects wrangler's OAuth token with
`10405 Method not allowed for this authentication scheme`. This endpoint accepts
it:

```bash
curl -H "Authorization: Bearer $OAUTH_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/services/macroflow/environments/production/content"
```

It returns `multipart/form-data`; the `index.js` part is the bundle.

Do **not** use `wrangler init --from-dash <name> -y` — the `-y` flag skips the
download and scaffolds a hello-world project instead, carrying a `wrangler.jsonc`
with `name: macroflow` that would overwrite the live Worker if deployed.

## Not recovered

The frontend is served through the `ASSETS` binding and is not part of the script
bundle, so it is not here. Only the inline `loginPage` HTML lives in the Worker.
