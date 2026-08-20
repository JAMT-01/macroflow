/**
 * End-to-end encryption for the body photos.
 *
 * The point is that Cloudflare cannot read them. Photos are encrypted in the
 * browser before upload and decrypted in the browser after download; KV only
 * ever holds ciphertext, and no key material capable of decrypting them ever
 * reaches the Worker.
 *
 * ## How one passphrase does both jobs
 *
 * PBKDF2 stretches the passphrase into 512 bits, split in half:
 *
 *   authKey  (first 256 bits)  — sent to the Worker to prove you know the
 *                                passphrase. The Worker stores only SHA-256 of
 *                                it, so a database dump does not yield a token.
 *   encKey   (second 256 bits) — never leaves the browser. Unwraps the master
 *                                key that photos are actually encrypted with.
 *
 * Halving one derivation is what lets a single passphrase authenticate without
 * handing the server anything that decrypts. The Worker seeing `authKey` learns
 * nothing about `encKey`: they are independent outputs of the same KDF.
 *
 * ## Why a master key rather than encrypting with encKey directly
 *
 * Photos are encrypted with a random 256-bit master key, and that master key is
 * stored twice, wrapped once by `encKey` and once by the recovery key. Two
 * consequences: the recovery key can open the photos without knowing the
 * passphrase, and changing the passphrase only re-wraps the master key rather
 * than re-encrypting every photo.
 *
 * ## What this does not protect against
 *
 * The passphrase is still the root of the whole thing. Anyone who captures
 * `authKey` and the salt can mount an offline guess-and-derive attack, so a weak
 * passphrase is weak here too — the PBKDF2 iteration count only makes each guess
 * expensive. It also cannot protect a session already open on an unlocked
 * device, which is what the short unlock window is for.
 */

/** OWASP's floor for PBKDF2-HMAC-SHA256; ~0.5-2s on a phone, paid once per unlock. */
export const PBKDF2_ITERATIONS = 310_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
/** Bumped only if the scheme changes, so stored blobs can be told apart. */
export const CRYPTO_VERSION = 1;

const encoder = new TextEncoder();

export function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concat(head: Uint8Array, tail: Uint8Array) {
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/**
 * Splits the stretched passphrase into the half that is sent and the half that
 * stays. `encKey` is deliberately non-extractable: nothing in the app can read
 * its bytes back out, so it cannot be logged, posted, or serialised by mistake.
 */
export async function deriveKeys(passphrase: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    base,
    512
  ));
  const encKey = await crypto.subtle.importKey("raw", bits.slice(32, 64), "AES-GCM", false, ["wrapKey", "unwrapKey"]);
  return { authKey: toBase64(bits.slice(0, 32)), encKey };
}

/**
 * What the Worker stores and compares. Hashing means a leaked database does not
 * hand over a replayable unlock token; it does not need to be slow, because
 * `authKey` is a 256-bit KDF output rather than something guessable.
 */
export async function authVerifier(authKey: string) {
  return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", fromBase64(authKey) as unknown as BufferSource)));
}

/** Extractable so it can be wrapped; the wrapped copies are all that is stored. */
export async function generateMasterKey() {
  // generateKey is typed as key-or-keypair for the asymmetric algorithms; AES
  // always yields a single key.
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]) as Promise<CryptoKey>;
}

/** 256 random bits, shown once. Long, because it lives in a password manager. */
export function generateRecoveryKey() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/=+$/, "");
}

/**
 * Strips the grouping spaces the UI adds for readability.
 *
 * Every use of the recovery key goes through this, including the hash sent as
 * proof — otherwise a key pasted back in the spaced form it was displayed in
 * would derive the right wrapping key but the wrong proof, and be rejected
 * before it ever got to unwrap anything.
 */
export function normalizeRecoveryKey(recoveryKey: string) {
  return recoveryKey.replace(/[^A-Za-z0-9+/=]/g, "");
}

export async function recoveryKeyToKey(recoveryKey: string) {
  const cleaned = normalizeRecoveryKey(recoveryKey);
  const bytes = fromBase64(cleaned.padEnd(Math.ceil(cleaned.length / 4) * 4, "="));
  if (bytes.length !== 32) throw new Error("That recovery key is not the right length.");
  return crypto.subtle.importKey("raw", bytes as unknown as BufferSource, "AES-GCM", false, ["wrapKey", "unwrapKey"]);
}

export async function wrapMasterKey(wrappingKey: CryptoKey, masterKey: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const wrapped = await crypto.subtle.wrapKey("raw", masterKey, wrappingKey, { name: "AES-GCM", iv });
  return toBase64(concat(iv, new Uint8Array(wrapped)));
}

export async function unwrapMasterKey(wrappingKey: CryptoKey, wrapped: string) {
  const blob = fromBase64(wrapped);
  return crypto.subtle.unwrapKey(
    "raw",
    blob.slice(IV_BYTES) as unknown as BufferSource,
    wrappingKey,
    { name: "AES-GCM", iv: blob.slice(0, IV_BYTES) },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

/** IV prepended to the ciphertext, so one opaque blob is all KV has to hold. */
export async function encryptBytes(masterKey: CryptoKey, bytes: ArrayBuffer) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, masterKey, bytes);
  return concat(iv, new Uint8Array(ciphertext));
}

export async function decryptBytes(masterKey: CryptoKey, payload: ArrayBuffer) {
  const blob = new Uint8Array(payload);
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.slice(0, IV_BYTES) },
    masterKey,
    blob.slice(IV_BYTES) as unknown as BufferSource
  );
}
