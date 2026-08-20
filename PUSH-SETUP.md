# Web Push for MacroFlow — setup and wiring

Written 2026-08-18. Adds iOS PWA push notifications so the app can prompt for the
data it is missing — primarily the daily weigh-in.

---

## ⚠️ Read this first: what is and is not done

| Piece | Status |
|---|---|
| `push_subscriptions` table | ✅ **applied live** to D1 |
| Reminder schedule (weigh-in 08:00 + kinds) | ✅ **applied live** to D1 |
| `worker/push.ts` — Web Push protocol | ✅ written, crypto verified by test |
| `worker/push-assets.ts` — service worker + client | ✅ written |
| `worker/reminders.ts` — dispatcher | ✅ written |
| VAPID keys | ❌ **you must generate and set them** (§1) |
| Wiring into `worker/index.ts` | ❌ **not applied** (§2) |
| Deployment | ❌ **blocked** — see below |

**Nothing sends a notification yet.** The database is ready and the code is
written, but it is not running.

### Why it cannot be deployed from here

1. `wrangler.jsonc` deliberately omits `main` and `assets` so that
   `wrangler deploy` fails fast. That guardrail exists because the deployed
   Worker was the only copy of the source, and deploying from an incomplete
   config would have destroyed it. **I left it in place.**
2. `recovered/` is the deployed **esbuild bundle**, not buildable TypeScript —
   types are erased, imports are inlined, every function carries `__name(...)`.
   It is a faithful reference, not a source tree you can `wrangler deploy`.
3. The **frontend assets were never recovered at all.** They live in the `ASSETS`
   binding, are not part of the Worker script, and every path is behind the 401
   gate.

Point 3 is why this implementation deliberately puts *everything* in the Worker:
the service worker and the client script are served as Worker **routes**, and the
`<script>` tag is injected into the HTML with `HTMLRewriter` on the way out. **No
change to the frontend bundle is required.** When you have a buildable tree, the
three files here drop in and the wiring in §2 is the whole integration.

---

## 1. VAPID keys

VAPID is how the push service (Apple's, in your case) knows the notification came
from your server. It is one P-256 keypair, generated once. **Never regenerate it
casually** — every existing subscription is bound to the key that created it, and
changing the key silently breaks all of them.

Generate a fresh pair:

```bash
node -e "const{webcrypto:w}=require('crypto');(async()=>{const k=await w.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']);const p=new Uint8Array(await w.subtle.exportKey('raw',k.publicKey));const j=await w.subtle.exportKey('jwk',k.privateKey);const b=x=>Buffer.from(x).toString('base64url');console.log('PUBLIC :',b(p));console.log('PRIVATE:',j.d)})()"
```

The **private** key goes in a Worker secret — never in D1, never in a file in a
synced folder:

```bash
npx wrangler secret put VAPID_PRIVATE_KEY --name macroflow
```

The **public** key is not secret (the browser receives it), so it lives in
`app_secrets` alongside the OpenRouter credential. Substitute your value:

```bash
npx wrangler d1 execute macroflow --remote --command "INSERT OR REPLACE INTO app_secrets (name, value, updated_at) VALUES ('vapid_public_key', 'PASTE_PUBLIC_KEY_HERE', CURRENT_TIMESTAMP), ('vapid_subject', 'mailto:agustinmontagner@gmail.com', CURRENT_TIMESTAMP);"
```

`vapid_subject` is required by RFC 8292 — push services use it to contact you if
your pushes start misbehaving.

`getVapidKeys` reads `env.VAPID_PRIVATE_KEY` first and falls back to
`app_secrets`, the same precedence `getOpenRouterApiKey` uses, so you can move
either value between the two without a code change.

---

## 2. Wiring into `worker/index.ts`

Five edits.

### 2.1 Imports

```ts
import { checkReminders } from './reminders';   // NOT './telegram'
import { serviceWorkerResponse, clientScriptResponse, injectPushClient } from './push-assets';
import { saveSubscription, deleteSubscription, sendPushToAll, countSubscriptions, getVapidKeys } from './push';
```

The `scheduled` handler already calls `checkReminders(env)` — changing the import
is the only change it needs.

### 2.2 Make the two scripts public

```ts
const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/telegram/webhook',
  '/sw.js',              // ← add
  '/push-client.js',     // ← add
]);
```

**This is not optional.** The browser re-fetches `sw.js` roughly every 24h to
check for updates. If your session cookie has expired, a gated `/sw.js` returns
the **login page HTML** with a 401 — the browser sees a script that is not
JavaScript, the update fails, and push can stop working with no visible error.
Neither script contains anything sensitive.

### 2.3 Serve the scripts

Place these **above** the `app.all('*')` asset fallthrough:

```ts
app.get('/sw.js', () => serviceWorkerResponse());
app.get('/push-client.js', () => clientScriptResponse());
```

### 2.4 Push API routes

```ts
app.get('/api/push/key', async (c) => {
  const keys = await getVapidKeys(c.env);
  return c.json({ publicKey: keys?.publicKey ?? null });
});

app.get('/api/push/status', async (c) => {
  const keys = await getVapidKeys(c.env);
  return c.json({ configured: Boolean(keys), devices: await countSubscriptions(c.env) });
});

app.post('/api/push/subscribe', async (c) => {
  const body = await c.req.json();
  const parsed = z.object({
    endpoint: z.string().url(),
    p256dh: z.string().min(1),
    auth: z.string().min(1),
    userAgent: z.string().optional(),
  }).parse(body);
  await saveSubscription(c.env, parsed);
  return c.json({ ok: true });
});

app.post('/api/push/unsubscribe', async (c) => {
  const { endpoint } = await c.req.json();
  await deleteSubscription(c.env, String(endpoint));
  return c.json({ ok: true });
});

// Fires immediately — do not wait for a cron slot to find out it works.
app.post('/api/push/test', async (c) => {
  const results = await sendPushToAll(c.env, {
    title: '✅ MacroFlow',
    body: 'Notifications are working.',
    url: '/',
    tag: 'test',
  });
  return c.json({ sent: results.filter((r) => r.ok).length, results });
});
```

`z` is the already-vendored Zod (it appears as `external_exports` in the bundle).

### 2.5 Inject the client into served HTML

Replace the asset fallthrough:

```ts
// was: app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
app.all('*', async (c) => injectPushClient(await c.env.ASSETS.fetch(c.req.raw)));
```

`injectPushClient` returns non-HTML responses untouched, so images, CSS and JS
pass straight through.

---

## 3. iOS requirements — the ones that actually bite

Safari has supported Web Push since **iOS 16.4**, with conditions that are
stricter than on desktop:

| Requirement | Consequence if unmet |
|---|---|
| **Added to Home Screen** | In a Safari tab `PushManager` is absent. The client script detects this and stays silent rather than showing a button that cannot work. |
| **Permission from a user gesture** | `Notification.requestPermission()` called on page load is ignored. It is attached to the Enable button. |
| **A notification shown for every push** | iOS revokes the subscription for silent pushes. The service worker always calls `showNotification`, even on an unparseable payload. |
| **`userVisibleOnly: true`** | Subscription is rejected without it. Set in the client. |
| **HTTPS** | Already satisfied — `macro.montagnertudor.org`. |
| **Denial is terminal** | Once denied, the page cannot re-prompt; only iOS Settings → Notifications can reset it. The client shows nothing rather than a dead button. **Do not tap "Don't Allow" while testing.** |

The app is already installed on your Home Screen, so the manifest and
`display: standalone` are already correct — nothing to change there.

---

## 4. What you will actually receive

Reminder times are `America/Buenos_Aires`, matching `settings.timezone`.

| Time | Reminder | Enabled | Suppressed when |
|---|---|---|---|
| **08:00** | ⚖️ Morning weigh-in | **on** (new) | a weight is already logged today |
| 09:00 | 🍽️ Breakfast | off | a Breakfast meal is already logged |
| 13:00 | 🍽️ Lunch | on | a Lunch meal is already logged |
| 21:00 | 🍽️ Dinner | on | a Dinner meal is already logged |

Meal reminders carry live numbers — *"1,240 kcal · 84 g protein · 19 g fibre left
today"* — rather than a generic nag, so the notification is worth reading.

**The suppression is the point.** A tracker that pings you about a meal you
logged an hour ago gets muted within a week. Reminders only fire for something
genuinely outstanding.

---

## 5. Testing, in order

1. Deploy (once §2 is wired and you have a buildable tree).
2. Open the PWA **from the Home Screen icon**, not Safari.
3. The dark "Get reminders…" bar appears at the bottom. Tap **Enable**, then
   **Allow** at the iOS prompt.
4. Confirm the device registered:

```bash
npx wrangler d1 execute macroflow --remote --command "SELECT id, substr(endpoint,1,45) AS endpoint, created_at FROM push_subscriptions;"
```

5. Fire a test notification without waiting for a cron slot — from the PWA, so
   the session cookie is sent:

```js
await fetch('/api/push/test', { method: 'POST', credentials: 'same-origin' }).then(r => r.json())
```

6. Watch a real reminder fire:

```bash
npx wrangler tail macroflow
```

### If nothing arrives

- `SELECT * FROM sent_reminders;` — **rows present** means the cron fired and the
  fault is in delivery; **empty** means the reminder never triggered (wrong
  timezone, disabled, or already satisfied).
- `SELECT failure_count FROM push_subscriptions;` — climbing means the push
  service is rejecting. `/api/push/test` returns the status and body.
- **401 from Apple** → the VAPID `aud` claim or the key is wrong.
- **404/410** → subscription is dead; `sendToSubscription` deletes it
  automatically. Re-enable from the app.
- Nothing at all, no errors → almost always opened in a Safari tab instead of
  from the Home Screen icon.

---

## 6. Verified

`worker/push.ts`'s crypto was extracted verbatim and round-tripped against a
browser-side decrypt (17 checks, all passing):

- RFC 8188 header layout — salt 16 B, record size 4096, key id 65 B
- Ciphertext length including the AES-GCM tag
- Full decrypt back to the exact plaintext, unicode intact
- `0x02` final-record delimiter (`0x01` here is the classic bug that makes iOS
  drop the notification silently)
- Fresh salt and ephemeral key per message
- VAPID JWT verifying against its public key; ES256; 64-byte raw signature
- `aud` set to the push **origin**, not the full endpoint — a 401 if wrong
- `exp` inside Apple's 24h limit
- base64url round-trips on bytes that differ from standard base64

What is **not** verified: the routes in §2 (not wired), and end-to-end delivery
to a real device (needs a deploy).
