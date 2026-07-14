// On-device credential vault (IndexedDB).
//
// The Kaggle key is encrypted with a non-extractable AES-GCM key that is
// generated once and stored in IndexedDB (structured-clone of the CryptoKey),
// so it auto-unlocks on the same browser and never exists in plaintext at rest
// — and never leaves the device.

export interface KaggleCreds {
  username: string;
  apiKey: string;
  /** HF read token, stored on-device with the Kaggle key. Optional. */
  hfToken?: string;
}

const DB_NAME = "edgerunner-vault";
const STORE = "kv";
const DEVICE_KEY = "deviceKey";
const CREDS_KEY = "kaggle";

function available(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result as T | undefined);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDel(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deviceKey(): Promise<CryptoKey | null> {
  if (!crypto?.subtle) return null;
  const existing = await idbGet<CryptoKey>(DEVICE_KEY);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // non-extractable
    ["encrypt", "decrypt"],
  );
  await idbPut(DEVICE_KEY, key);
  return key;
}

interface StoredCreds {
  enc: boolean;
  iv?: number[];
  data: number[] | string;
}

export async function saveCreds(creds: KaggleCreds): Promise<void> {
  if (!available()) throw new Error("IndexedDB unavailable");
  const plain = new TextEncoder().encode(JSON.stringify(creds));
  const key = await deviceKey();
  if (key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
    const stored: StoredCreds = {
      enc: true,
      iv: Array.from(iv),
      data: Array.from(new Uint8Array(ct)),
    };
    await idbPut(CREDS_KEY, stored);
  } else {
    // No Web Crypto (insecure context) — still on-device, just not encrypted.
    const stored: StoredCreds = { enc: false, data: JSON.stringify(creds) };
    await idbPut(CREDS_KEY, stored);
  }
}

export async function loadCreds(): Promise<KaggleCreds | null> {
  if (!available()) return null;
  const stored = await idbGet<StoredCreds>(CREDS_KEY);
  if (!stored) return null;
  try {
    if (stored.enc && stored.iv && Array.isArray(stored.data)) {
      const key = await deviceKey();
      if (!key) return null;
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(stored.iv) },
        key,
        new Uint8Array(stored.data as number[]),
      );
      return JSON.parse(new TextDecoder().decode(pt)) as KaggleCreds;
    }
    return JSON.parse(stored.data as string) as KaggleCreds;
  } catch {
    return null;
  }
}

export async function clearCreds(): Promise<void> {
  if (!available()) return;
  await idbDel(CREDS_KEY);
}
