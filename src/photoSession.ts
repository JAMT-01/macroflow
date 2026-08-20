import { api } from "./api";
import {
  authVerifier, decryptBytes, deriveKeys, encryptBytes, fromBase64, generateMasterKey,
  generateRecoveryKey, normalizeRecoveryKey, randomSalt, recoveryKeyToKey, toBase64,
  unwrapMasterKey, wrapMasterKey
} from "../shared/photo-crypto";

/**
 * The browser half of the photo encryption.
 *
 * The master key lives in a module variable and nowhere else — not
 * localStorage, not sessionStorage, not a cookie. That is deliberate: anything
 * persisted would outlive the unlock window and undo the point of it. A refresh
 * costs you the passphrase again, which is the correct trade.
 */
let masterKey: CryptoKey | null = null;

export const hasMasterKey = () => masterKey !== null;

export function forgetMasterKey() {
  masterKey = null;
}

/**
 * First-time setup. Everything here happens before anything is sent: the server
 * receives two hashes and two wrapped blobs, and could not decrypt a photo with
 * all of them combined.
 *
 * Returns the recovery key for one-time display. It is never stored anywhere,
 * so if the user closes that screen without saving it, only the passphrase
 * remains — which is why the UI makes them confirm.
 */
export async function setUpEncryption(passphrase: string) {
  const salt = randomSalt();
  const { authKey, encKey } = await deriveKeys(passphrase, salt);
  const recoveryKey = generateRecoveryKey();
  const recoveryWrapper = await recoveryKeyToKey(recoveryKey);
  const freshMasterKey = await generateMasterKey();

  const proof = await authVerifier(authKey);
  await api.setupPhotoEncryption({
    salt: toBase64(salt),
    authVerifier: proof,
    recoveryVerifier: await sha256Base64(normalizeRecoveryKey(recoveryKey)),
    wrappedPassphrase: await wrapMasterKey(encKey, freshMasterKey),
    wrappedRecovery: await wrapMasterKey(recoveryWrapper, freshMasterKey)
  });

  masterKey = freshMasterKey;
  // Setup stores keys but issues no cookie, so without this the gallery would
  // 403 the moment the recovery key screen was dismissed.
  const state = await api.unlockPhotosWithProof(proof, "passphrase");
  return { recoveryKey, expiresAt: state.expiresAt };
}

/** SHA-256 of the recovery key: provable to the server, useless to it. */
async function sha256Base64(value: string) {
  return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

/**
 * Unlock with the passphrase. The passphrase never leaves this function — only
 * a hash of the auth half does, and the master key comes back still wrapped.
 */
export async function unlockWithPassphrase(passphrase: string, saltBase64: string) {
  const { authKey, encKey } = await deriveKeys(passphrase, fromBase64(saltBase64));
  const state = await api.unlockPhotosWithProof(await authVerifier(authKey), "passphrase");
  masterKey = await unwrapMasterKey(encKey, state.wrappedKey);
  return state;
}

export async function unlockWithRecoveryKey(recoveryKey: string) {
  const wrapper = await recoveryKeyToKey(recoveryKey);
  const state = await api.unlockPhotosWithProof(await sha256Base64(normalizeRecoveryKey(recoveryKey)), "recovery");
  masterKey = await unwrapMasterKey(wrapper, state.wrappedKey);
  return state;
}

export async function encryptForUpload(file: File) {
  if (!masterKey) throw new Error("Photos are locked.");
  const sealed = await encryptBytes(masterKey, await file.arrayBuffer());
  return new File([sealed as unknown as BlobPart], "photo.enc", { type: "application/octet-stream" });
}

/**
 * Fetches one photo and turns it into a blob URL the <img> can use.
 *
 * Plaintext photos from before encryption was switched on are passed straight
 * through, which is what `encrypted` on the row is for — the two kinds coexist
 * rather than forcing a migration that would need the passphrase to run.
 */
export async function loadPhotoUrl(imagePath: string, encrypted: boolean) {
  if (!encrypted) return imagePath;
  if (!masterKey) throw new Error("Photos are locked.");
  const response = await fetch(imagePath);
  if (!response.ok) throw new Error(response.status === 403 ? "locked" : "Could not load that photo");
  const plain = await decryptBytes(masterKey, await response.arrayBuffer());
  return URL.createObjectURL(new Blob([plain], { type: "image/jpeg" }));
}

/** Blob URLs are leaked memory until revoked, and hold decrypted bytes. */
export function releasePhotoUrl(url: string) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}
