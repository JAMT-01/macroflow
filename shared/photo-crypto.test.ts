import { describe, expect, it } from "vitest";
import {
  authVerifier, decryptBytes, deriveKeys, encryptBytes, fromBase64, generateMasterKey,
  generateRecoveryKey, normalizeRecoveryKey, randomSalt, recoveryKeyToKey, toBase64, unwrapMasterKey, wrapMasterKey
} from "./photo-crypto";

const PASSPHRASE = "correct horse battery staple";
const salt = randomSalt();

// Derivation is deliberately expensive, so the suite derives once and shares it.
const derived = await deriveKeys(PASSPHRASE, salt);

describe("photo encryption", () => {
  it("round-trips a photo through the master key", async () => {
    const masterKey = await generateMasterKey();
    const original = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 250, 0]);
    const sealed = await encryptBytes(masterKey, original.buffer as ArrayBuffer);
    const opened = new Uint8Array(await decryptBytes(masterKey, sealed.buffer as ArrayBuffer));
    expect(opened).toEqual(original);
  });

  it("produces different ciphertext each time, so identical photos do not match", async () => {
    const masterKey = await generateMasterKey();
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer;
    const first = await encryptBytes(masterKey, bytes);
    const second = await encryptBytes(masterKey, bytes);
    expect(toBase64(first)).not.toEqual(toBase64(second));
  });

  it("rejects tampered ciphertext rather than returning wrong bytes", async () => {
    const masterKey = await generateMasterKey();
    const sealed = await encryptBytes(masterKey, new Uint8Array([9, 9, 9, 9]).buffer as ArrayBuffer);
    sealed[sealed.length - 1] ^= 0x01;
    await expect(decryptBytes(masterKey, sealed.buffer as ArrayBuffer)).rejects.toThrow();
  });

  it("cannot decrypt with a different master key", async () => {
    const sealed = await encryptBytes(await generateMasterKey(), new Uint8Array([7, 7]).buffer as ArrayBuffer);
    await expect(decryptBytes(await generateMasterKey(), sealed.buffer as ArrayBuffer)).rejects.toThrow();
  });
});

describe("key derivation", () => {
  it("is deterministic for the same passphrase and salt", async () => {
    const again = await deriveKeys(PASSPHRASE, salt);
    expect(again.authKey).toEqual(derived.authKey);
  });

  it("gives a different auth key under a different salt", async () => {
    const elsewhere = await deriveKeys(PASSPHRASE, randomSalt());
    expect(elsewhere.authKey).not.toEqual(derived.authKey);
  });

  it("gives a different auth key for a different passphrase", async () => {
    const wrong = await deriveKeys("not the passphrase", salt);
    expect(wrong.authKey).not.toEqual(derived.authKey);
  });

  it("keeps the encryption half unreadable, so it cannot leak by accident", async () => {
    expect(derived.encKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", derived.encKey)).rejects.toThrow();
  });

  it("sends the server a value that is not the encryption key", async () => {
    // The auth half is 256 of the 512 derived bits; the encryption half is the
    // other 256 and never appears in anything transmitted.
    expect(fromBase64(derived.authKey).length).toBe(32);
    const verifier = await authVerifier(derived.authKey);
    expect(verifier).not.toEqual(derived.authKey);
  });
});

describe("what the server stores", () => {
  it("verifies the right auth key and refuses a wrong one", async () => {
    const stored = await authVerifier(derived.authKey);
    const wrong = await deriveKeys("not the passphrase", salt);
    expect(await authVerifier(derived.authKey)).toEqual(stored);
    expect(await authVerifier(wrong.authKey)).not.toEqual(stored);
  });

  it("cannot unwrap the master key from the stored verifier", async () => {
    const masterKey = await generateMasterKey();
    const wrapped = await wrapMasterKey(derived.encKey, masterKey);
    // Everything the Worker holds: the verifier, the salt, the wrapped blob.
    const verifier = await authVerifier(derived.authKey);
    const asKey = await crypto.subtle.importKey("raw", fromBase64(verifier), "AES-GCM", false, ["unwrapKey"]);
    await expect(unwrapMasterKey(asKey, wrapped)).rejects.toThrow();
  });
});

describe("recovery key", () => {
  it("opens the same master key as the passphrase does", async () => {
    const masterKey = await generateMasterKey();
    const recoveryKey = generateRecoveryKey();
    const byPassphrase = await wrapMasterKey(derived.encKey, masterKey);
    const byRecovery = await wrapMasterKey(await recoveryKeyToKey(recoveryKey), masterKey);

    const sealed = await encryptBytes(masterKey, new Uint8Array([4, 2]).buffer as ArrayBuffer);

    const fromPassphrase = await unwrapMasterKey(derived.encKey, byPassphrase);
    const fromRecovery = await unwrapMasterKey(await recoveryKeyToKey(recoveryKey), byRecovery);

    expect(new Uint8Array(await decryptBytes(fromPassphrase, sealed.buffer as ArrayBuffer))).toEqual(new Uint8Array([4, 2]));
    expect(new Uint8Array(await decryptBytes(fromRecovery, sealed.buffer as ArrayBuffer))).toEqual(new Uint8Array([4, 2]));
  });

  it("survives the spacing the UI adds for readability", async () => {
    const recoveryKey = generateRecoveryKey();
    const spaced = recoveryKey.replace(/(.{8})/g, "$1 ").trim();
    const masterKey = await generateMasterKey();
    const wrapped = await wrapMasterKey(await recoveryKeyToKey(recoveryKey), masterKey);
    await expect(unwrapMasterKey(await recoveryKeyToKey(spaced), wrapped)).resolves.toBeDefined();
  });

  it("hashes to the same proof whether or not it carries display spacing", async () => {
    // Regression: the proof used to be hashed from the raw string while the
    // wrapping key was derived from the stripped one, so a key pasted back in
    // the spaced form it was shown in was rejected before it could unwrap.
    const recoveryKey = generateRecoveryKey();
    const spaced = recoveryKey.replace(/(.{8})/g, "$1 ").trim();
    const hash = async (value: string) =>
      toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeRecoveryKey(value)))));
    expect(await hash(spaced)).toEqual(await hash(recoveryKey));
  });

  it("refuses a wrong recovery key", async () => {
    const masterKey = await generateMasterKey();
    const wrapped = await wrapMasterKey(await recoveryKeyToKey(generateRecoveryKey()), masterKey);
    await expect(unwrapMasterKey(await recoveryKeyToKey(generateRecoveryKey()), wrapped)).rejects.toThrow();
  });

  it("rejects a recovery key of the wrong length outright", async () => {
    await expect(recoveryKeyToKey("tooshort")).rejects.toThrow(/length/);
  });
});

describe("the wrong passphrase", () => {
  it("cannot unwrap the master key", async () => {
    const masterKey = await generateMasterKey();
    const wrapped = await wrapMasterKey(derived.encKey, masterKey);
    const wrong = await deriveKeys("not the passphrase", salt);
    await expect(unwrapMasterKey(wrong.encKey, wrapped)).rejects.toThrow();
  });
});
