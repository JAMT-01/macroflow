/**
 * Web Push for MacroFlow — RFC 8291 (payload encryption) + RFC 8292 (VAPID).
 *
 * Implemented directly on Web Crypto because the usual libraries (web-push,
 * web-push-libs) reach for Node's `crypto` module and do not run on Workers even
 * with nodejs_compat. Everything here is standard SubtleCrypto and works on the
 * Workers runtime unchanged.
 *
 * Delivery targets APNs for iOS home-screen PWAs (endpoints on
 * web.push.apple.com) but nothing here is Apple-specific — the same code reaches
 * FCM and Mozilla's autopush.
 */

import { getSettings } from './db';

interface Env {
  DB: D1Database;
  APP_URL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushNotification {
  title: string;
  body: string;
  /** Path opened on tap. Relative to the app origin. */
  url?: string;
  /** Collapse key — a later notification with the same tag replaces the earlier. */
  tag?: string;
}

/* ---------------------------------------------------------------- base64url */

const te = (s: string) => new TextEncoder().encode(s);

function b64urlEncode(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/* -------------------------------------------------------------- VAPID keys */

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/**
 * Env var wins, `app_secrets` row is the fallback — the same precedence
 * getOpenRouterApiKey uses, so both credentials behave the same way.
 */
export async function getVapidKeys(env: Env): Promise<VapidKeys | null> {
  const row = await env.DB.prepare(
    `SELECT name, value FROM app_secrets WHERE name IN ('vapid_public_key','vapid_private_key','vapid_subject')`,
  ).all<{ name: string; value: string }>();

  const stored = new Map((row.results ?? []).map((r) => [r.name, r.value]));

  const publicKey = env.VAPID_PUBLIC_KEY || stored.get('vapid_public_key');
  const privateKey = env.VAPID_PRIVATE_KEY || stored.get('vapid_private_key');
  const subject = env.VAPID_SUBJECT || stored.get('vapid_subject') || 'mailto:admin@example.com';

  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}

/**
 * Rebuild the signing key from the raw `d` scalar plus the public point. Web
 * Crypto will not import a bare private scalar, so the JWK carries x and y
 * sliced out of the uncompressed public key (0x04 || x[32] || y[32]).
 */
async function importSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const publicBytes = b64urlDecode(keys.publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  }
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64urlEncode(publicBytes.slice(1, 33)),
      y: b64urlEncode(publicBytes.slice(33, 65)),
      ext: false,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/**
 * Signed JWT proving we own the VAPID key. `aud` must be the push service
 * origin — not the full endpoint — or the service rejects it with 401.
 */
async function buildVapidToken(keys: VapidKeys, audience: string): Promise<string> {
  const header = b64urlEncode(te(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(
    te(
      JSON.stringify({
        aud: audience,
        // Apple rejects anything beyond 24h. 12h leaves room for clock skew.
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: keys.subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await importSigningKey(keys),
    te(signingInput),
  );
  // SubtleCrypto already returns raw r||s, which is exactly what ES256 wants.
  return `${signingInput}.${b64urlEncode(signature)}`;
}

/* ------------------------------------------------------ payload encryption */

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * RFC 8291 §3.4 + RFC 8188 aes128gcm content coding.
 *
 * Output layout:
 *   salt[16] || record_size[4] || key_id_len[1] || server_public[65] || ciphertext
 */
async function encryptPayload(
  plaintext: Uint8Array,
  p256dh: string,
  authSecret: string,
): Promise<Uint8Array> {
  const clientPublic = b64urlDecode(p256dh);
  const auth = b64urlDecode(authSecret);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Ephemeral keypair — a fresh one per message, per spec.
  const serverKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));

  const clientKey = await crypto.subtle.importKey(
    'raw',
    clientPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKeys.privateKey, 256),
  );

  // The auth secret is the HKDF *salt* in this first step, not the random salt.
  const ikm = await hkdf(
    auth,
    sharedSecret,
    concat(te('WebPush: info'), new Uint8Array([0]), clientPublic, serverPublic),
    32,
  );

  const contentKey = await hkdf(
    salt,
    ikm,
    concat(te('Content-Encoding: aes128gcm'), new Uint8Array([0])),
    16,
  );
  const nonce = await hkdf(salt, ikm, concat(te('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  const aesKey = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      aesKey,
      // 0x02 is the final-record delimiter. A single-record message must use
      // 0x02, not 0x01 — 0x01 makes the browser wait for a record that never
      // arrives and the notification is silently dropped.
      concat(plaintext, new Uint8Array([2])),
    ),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096, false);

  return concat(
    salt,
    recordSize,
    new Uint8Array([serverPublic.length]),
    serverPublic,
    ciphertext,
  );
}

/* ----------------------------------------------------------------- sending */

export interface SendResult {
  endpoint: string;
  ok: boolean;
  status: number;
  /** Subscription is dead and was deleted. */
  gone: boolean;
  error?: string;
}

export async function sendToSubscription(
  env: Env,
  subscription: PushSubscriptionRow,
  notification: PushNotification,
): Promise<SendResult> {
  const keys = await getVapidKeys(env);
  if (!keys) {
    return { endpoint: subscription.endpoint, ok: false, status: 0, gone: false, error: 'VAPID keys not configured' };
  }

  const payload = te(
    JSON.stringify({
      title: notification.title,
      body: notification.body,
      url: notification.url ?? '/',
      tag: notification.tag,
    }),
  );

  let response: Response;
  try {
    const audience = new URL(subscription.endpoint).origin;
    response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `vapid t=${await buildVapidToken(keys, audience)}, k=${keys.publicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        // Hold for 24h if the device is offline; a stale meal reminder is
        // useless but a stale weigh-in reminder still lands on the right day.
        TTL: '86400',
        Urgency: 'normal',
      },
      body: await encryptPayload(payload, subscription.p256dh, subscription.auth),
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    await env.DB.prepare(
      'UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?',
    ).bind(subscription.id).run();
    return {
      endpoint: subscription.endpoint,
      ok: false,
      status: 0,
      gone: false,
      error: error instanceof Error ? error.message : 'network error',
    };
  }

  // 404/410 mean the user deleted the PWA or the subscription expired. Anything
  // else might be transient, so only these two prune.
  if (response.status === 404 || response.status === 410) {
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(subscription.id).run();
    return { endpoint: subscription.endpoint, ok: false, status: response.status, gone: true };
  }

  if (!response.ok) {
    await env.DB.prepare(
      'UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ?',
    ).bind(subscription.id).run();
    return {
      endpoint: subscription.endpoint,
      ok: false,
      status: response.status,
      gone: false,
      error: (await response.text().catch(() => '')).slice(0, 200),
    };
  }

  await env.DB.prepare(
    'UPDATE push_subscriptions SET last_success = ?, failure_count = 0 WHERE id = ?',
  ).bind(new Date().toISOString(), subscription.id).run();

  return { endpoint: subscription.endpoint, ok: true, status: response.status, gone: false };
}

/** Fan out to every registered device. Never throws — one dead phone must not
 *  stop the others, and a reminder failure must not break the cron tick. */
export async function sendPushToAll(
  env: Env,
  notification: PushNotification,
): Promise<SendResult[]> {
  const rows = await env.DB.prepare(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions',
  ).all<PushSubscriptionRow>();

  const subscriptions = rows.results ?? [];
  if (!subscriptions.length) return [];

  const settled = await Promise.allSettled(
    subscriptions.map((subscription) => sendToSubscription(env, subscription, notification)),
  );

  return settled.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : {
          endpoint: subscriptions[index].endpoint,
          ok: false,
          status: 0,
          gone: false,
          error: String(result.reason),
        },
  );
}

export async function countSubscriptions(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export async function saveSubscription(
  env: Env,
  input: { endpoint: string; p256dh: string; auth: string; userAgent?: string },
): Promise<void> {
  // Re-subscribing on the same device returns the same endpoint, so upsert on
  // it rather than accumulating duplicate rows that all push the same phone.
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       user_agent = excluded.user_agent,
       failure_count = 0`,
  ).bind(crypto.randomUUID(), input.endpoint, input.p256dh, input.auth, input.userAgent ?? '').run();
}

export async function deleteSubscription(env: Env, endpoint: string): Promise<void> {
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
}
