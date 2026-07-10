/**
 * Web Crypto helpers — AES-256-GCM + PBKDF2-SHA-256.
 * All crypto runs on-device; keys never leave the browser origin.
 */

export type EncryptedBlob = {
  v: 1;
  /** base64 IV (12 bytes) */
  iv: string;
  /** base64 ciphertext (includes GCM tag) */
  ct: string;
};

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

export function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const u = new Uint8Array(n);
  crypto.getRandomValues(u);
  return u;
}

/** Non-extractable AES-GCM device key (origin-bound, survives reloads). */
export async function generateDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // non-extractable — cannot dump raw key from JS
    ["encrypt", "decrypt"]
  );
}

/** Extractable key for passphrase-wrapping only (wrapped immediately). */
export async function generateExtractableKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

const PBKDF2_ITERATIONS = 600_000; // OWASP-ish for SHA-256 (2023+)

export async function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    textEnc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations,
      hash: "SHA-256",
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt", "wrapKey", "unwrapKey"]
  );
}

export async function encryptJson(
  key: CryptoKey,
  data: unknown
): Promise<EncryptedBlob> {
  const iv = randomBytes(12);
  const plain = textEnc.encode(JSON.stringify(data));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    plain
  );
  return { v: 1, iv: b64encode(iv), ct: b64encode(ct) };
}

export async function decryptJson<T = unknown>(
  key: CryptoKey,
  blob: EncryptedBlob
): Promise<T> {
  if (!blob || blob.v !== 1 || !blob.iv || !blob.ct) {
    throw new Error("Invalid ciphertext");
  }
  const iv = b64decode(blob.iv);
  const ct = b64decode(blob.ct);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource
  );
  return JSON.parse(textDec.decode(plain)) as T;
}

/** Wrap (export+encrypt) a CryptoKey with a KEK for passphrase vaults. */
export async function wrapKey(
  kek: CryptoKey,
  key: CryptoKey
): Promise<EncryptedBlob> {
  const iv = randomBytes(12);
  const wrapped = await crypto.subtle.wrapKey("raw", key, kek, {
    name: "AES-GCM",
    iv: iv as BufferSource,
  });
  return { v: 1, iv: b64encode(iv), ct: b64encode(wrapped) };
}

export async function unwrapKey(
  kek: CryptoKey,
  blob: EncryptedBlob
): Promise<CryptoKey> {
  const iv = b64decode(blob.iv);
  const ct = b64decode(blob.ct);
  return crypto.subtle.unwrapKey(
    "raw",
    ct as BufferSource,
    kek,
    { name: "AES-GCM", iv: iv as BufferSource },
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export function secureClearString(s: string): void {
  // JS strings are immutable; best-effort note for callers to drop refs.
  void s;
}

export { PBKDF2_ITERATIONS };
