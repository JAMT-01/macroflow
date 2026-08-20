/**
 * Build a deployable Worker bundle: the exact production bundle recovered from
 * Cloudflare, plus the progress-photo modules and routes wired in.
 *
 * Deliberately additive. The base is byte-for-byte what is running now, so the
 * diff is only what this script inserts — far lower risk than rewriting a
 * source tree from the decompiled output.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^//, '');
const OUT_DIR = process.argv[2];

// 1. Compile the two TS modules to plain JS.
execSync(
  `npx --yes esbuild@0.25.0 "${ROOT}/worker/progress.ts" "${ROOT}/worker/progress-assets.ts" ` +
    `--outdir="${OUT_DIR}/mods" --format=esm --platform=neutral --log-level=warning`,
  { stdio: 'inherit' }
);

/** Strip module syntax — the bundle is one flat scope and the deps are already in it. */
function flatten(file) {
  return readFileSync(file, 'utf8')
    // `import { a, b } from "./x";`
    .replace(/^import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?[ \t]*\r?$/gm, '')
    // `export const foo = …` -> `const foo = …`
    .replace(/^export\s+(?=(const|function|async function|class|var|let))/gm, '')
    // esbuild's trailing `export {\n  a,\n  b\n};` block
    .replace(/^export\s*\{[\s\S]*?\};?[ \t]*\r?$/gm, '')
    .trim();
}

const progress = flatten(`${OUT_DIR}/mods/progress.js`);
const progressAssets = flatten(`${OUT_DIR}/mods/progress-assets.js`);

// Nothing should survive that would break a flat scope.
for (const [name, code] of [['progress', progress], ['progress-assets', progressAssets]]) {
  if (/^\s*(import|export)\s/m.test(code)) throw new Error(`${name}: leftover module syntax`);
}

const ROUTES = `
// ---- progress photos (added ${new Date().toISOString().slice(0, 10)}) ----
app.get("/progress-client.js", () => progressClientResponse());
app.get("/api/progress", async (c) => c.json({ photos: await listProgressPhotos(c.env) }));
app.post("/api/progress", async (c) => {
  const form = await c.req.formData();
  const image = form.get("image");
  if (!image || typeof image === "string") return c.json({ error: "Add a photo" }, 400);
  if (image.size > 15 * 1024 * 1024) return c.json({ error: "That photo is larger than 15 MB" }, 400);
  const pose = String(form.get("pose") || "front");
  if (!isPose(pose)) return c.json({ error: "Unknown pose" }, 400);
  const rawWeight = form.get("weightKg");
  const weightKg = rawWeight ? Number(rawWeight) : null;
  if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 20 || weightKg > 400)) {
    return c.json({ error: "Enter a valid weight" }, 400);
  }
  const photo = await saveProgressPhoto(c.env, {
    bytes: await image.arrayBuffer(),
    contentType: image.type,
    pose,
    takenAt: String(form.get("takenAt") || "") || void 0,
    weightKg,
    notes: String(form.get("notes") || "")
  });
  return c.json(photo, 201);
});
app.delete("/api/progress/:id", async (c) => {
  const deleted = await deleteProgressPhoto(c.env, c.req.param("id"));
  return deleted ? c.json({ ok: true }) : c.notFound();
});
app.get("/progress-photos/:key", async (c) => {
  const photo = await getProgressPhotoBytes(c.env, c.req.param("key"));
  if (!photo) return c.notFound();
  return c.body(photo.bytes, 200, {
    "content-type": photo.contentType,
    "cache-control": "private, max-age=31536000, immutable",
    "vary": "Cookie"
  });
});
`;

const ANCHOR = 'app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));';
const REPLACEMENT = `${progress}

${progressAssets}
${ROUTES}
app.all("*", async (c) => injectProgressClient(await c.env.ASSETS.fetch(c.req.raw)));`;

const bundle = readFileSync(`${ROOT}/recovered/BUNDLE-FULL.js`, 'utf8');
const hits = bundle.split(ANCHOR).length - 1;
if (hits !== 1) throw new Error(`anchor matched ${hits} times, expected exactly 1`);

const out = bundle.replace(ANCHOR, REPLACEMENT);
writeFileSync(`${OUT_DIR}/index.js`, out);

console.log(JSON.stringify({
  baseBytes: bundle.length,
  outBytes: out.length,
  addedBytes: out.length - bundle.length,
  progressModuleBytes: progress.length,
  assetsModuleBytes: progressAssets.length,
}, null, 2));
