import { bytesToBase64Url, constantTimeEquals, verifyPassword } from './auth';

/**
 * The progress-photo lock, ported from the `source` fork.
 *
 * WHY THIS EXISTS. The deployed frontend is `source`'s React app, whose Photos
 * tab is built around an end-to-end encrypted gallery: a passphrase is turned
 * into a key in the browser, the master key is stored only as two wrapped blobs
 * in `photo_crypto`, and the Worker never sees anything it could decrypt with.
 * `master`'s Worker never had those routes, so when master's bundle was
 * deployed over source's on 2026-08-21 (with `keep_assets`, which preserved
 * source's frontend) the Photos tab lost its server and has been dead since.
 *
 * This is the missing half. Every route matches source's contract exactly,
 * because the client is source's and cannot be changed from here.
 *
 * WHAT THE WORKER CAN AND CANNOT DO, unchanged from source's design:
 *   * it stores `salt` (public by design), two SHA-256 verifiers, and two
 *     wrapped copies of the master key
 *   * none of that decrypts a photo — losing those rows costs the photos,
 *     leaking them reveals nothing
 *   * the wrapped key is withheld until an unlock succeeds, so a stolen session
 *     cannot carry it off for an offline attack
 *
 * `photo_crypto` IS THE ONLY KEY TO EVERY ENCRYPTED PHOTO. Nothing here writes
 * to it except `/api/progress/setup`, which refuses when a row already exists.
 * Never add an update path.
 */

interface Env {
  DB: D1Database;
  APP_PASSWORD?: string;
  PHOTO_PASSPHRASE?: string;
}

const UNLOCK_COOKIE = 'mf_photos';
const UNLOCK_MINUTES = 3;

/*
 * A photo passphrase is often a short PIN, whose keyspace is small enough that
 * per-IP limits alone mean nothing — an attacker with a few hundred proxies
 * gets hundreds of guesses a minute. This caps attempts across every IP, which
 * is what actually bounds the search. Set high enough that ordinary fumbling
 * never trips it, accepting that someone who can reach the endpoint can
 * deliberately exhaust it and lock the owner out for an hour.
 */
const GLOBAL_FAILURES = 20;
const GLOBAL_WINDOW_MINUTES = 60;
const GLOBAL_KEY = '|photos-global';

export const PHOTO_UNLOCK_MINUTES = UNLOCK_MINUTES;

/** The photo secret, falling back to the app passphrase when none is set. */
export function photoSecret(env: Env): string {
  return env.PHOTO_PASSPHRASE || env.APP_PASSWORD || '';
}

export function hasSeparatePhotoSecret(env: Env): boolean {
  return Boolean(env.PHOTO_PASSPHRASE);
}

/* ------------------------------------------------------------ unlock cookie */

/** Distinct from the session key: `-photos-v1`, not `-session-v1`, so an unlock
 *  cookie can never be produced from, or mistaken for, a session cookie. */
async function signUnlock(password: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${password}::macroflow-photos-v1`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return bytesToBase64Url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
}

export async function createUnlockCookie(password: string): Promise<{ cookie: string; expiresAt: number }> {
  const expiresAt = Date.now() + UNLOCK_MINUTES * 60 * 1000;
  const value = `${expiresAt}.${await signUnlock(password, String(expiresAt))}`;
  return { cookie: `${UNLOCK_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax`, expiresAt };
}

export function clearUnlockCookie(): string {
  return `${UNLOCK_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * The instant the current unlock lapses, or null when there is not a valid one.
 *
 * The client needs the real expiry rather than just "unlocked": a tab opened
 * partway through a window has to close the photos when THAT window ends, not
 * UNLOCK_MINUTES after the page happened to load.
 */
export async function photoUnlockExpiry(request: Request, password: string): Promise<number | null> {
  const header = request.headers.get('cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${UNLOCK_COOKIE}=([^;]+)`));
  if (!match) return null;

  const [expiresAt, signature] = match[1].split('.');
  if (!expiresAt || !signature) return null;
  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return null;

  return constantTimeEquals(signature, await signUnlock(password, expiresAt)) ? expiry : null;
}

/* ----------------------------------------------------------- global lockout */

export async function isGloballyLockedOut(env: Env): Promise<boolean> {
  const row = await env.DB.prepare('SELECT locked_until FROM login_attempts WHERE ip = ?')
    .bind(GLOBAL_KEY)
    .first<{ locked_until: string | null }>();
  if (!row?.locked_until) return false;
  return new Date(row.locked_until).getTime() > Date.now();
}

export async function recordGlobalFailure(env: Env): Promise<void> {
  const now = Date.now();
  const windowStart = new Date(now - GLOBAL_WINDOW_MINUTES * 60 * 1000).toISOString();
  const row = await env.DB.prepare('SELECT failures, window_started_at FROM login_attempts WHERE ip = ?')
    .bind(GLOBAL_KEY)
    .first<{ failures: number; window_started_at: string }>();

  const withinWindow = Boolean(row && row.window_started_at > windowStart);
  const failures = withinWindow ? Number(row!.failures) + 1 : 1;
  const lockedUntil =
    failures >= GLOBAL_FAILURES ? new Date(now + GLOBAL_WINDOW_MINUTES * 60 * 1000).toISOString() : null;

  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, failures, window_started_at, locked_until) VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures,
       window_started_at = excluded.window_started_at, locked_until = excluded.locked_until`
  )
    .bind(GLOBAL_KEY, failures, withinWindow ? row!.window_started_at : new Date(now).toISOString(), lockedUntil)
    .run();
}

export async function clearGlobalFailures(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(GLOBAL_KEY).run();
}

/* ----------------------------------------------------------- crypto record */

export interface PhotoCryptoRow {
  salt: string;
  auth_verifier: string;
  recovery_verifier: string;
  wrapped_passphrase: string;
  wrapped_recovery: string;
}

export function getPhotoCrypto(env: Env): Promise<PhotoCryptoRow | null> {
  return env.DB.prepare(
    'SELECT salt, auth_verifier, recovery_verifier, wrapped_passphrase, wrapped_recovery FROM photo_crypto WHERE id = 1'
  ).first<PhotoCryptoRow>();
}

/* ------------------------------------------------------------------- gate */

export const PHOTO_LOCKED_RESPONSE = { error: 'Progress photos are locked', locked: true };

/** Every photo route sits behind this, including the bytes themselves. */
export async function requirePhotoUnlock(env: Env, request: Request): Promise<boolean> {
  const secret = photoSecret(env);
  if (!secret) return false;
  return (await photoUnlockExpiry(request, secret)) !== null;
}

/**
 * Verify an unlock attempt.
 *
 * With encryption configured the browser sends a PROOF — SHA-256 of either the
 * auth half of the derived key or of the recovery key — never the passphrase.
 * That is the whole point: the Worker can check it and still not decrypt
 * anything. Without encryption the legacy path compares the plaintext
 * passphrase against the configured secret, which is what pre-encryption photos
 * still use.
 *
 * Returns the wrapped master key only on success, and only the half that the
 * presented proof unlocks.
 */
export async function verifyUnlock(
  env: Env,
  body: { password?: string; proof?: string; kind?: string }
): Promise<{ ok: boolean; wrappedKey: string | null }> {
  const record = await getPhotoCrypto(env);
  if (record) {
    const proof = String(body.proof || '');
    const recovery = body.kind === 'recovery';
    const expected = recovery ? record.recovery_verifier : record.auth_verifier;
    const ok = Boolean(proof) && verifyPassword(proof, expected);
    return { ok, wrappedKey: ok ? (recovery ? record.wrapped_recovery : record.wrapped_passphrase) : null };
  }
  return { ok: verifyPassword(String(body.password || ''), photoSecret(env)), wrappedKey: null };
}
