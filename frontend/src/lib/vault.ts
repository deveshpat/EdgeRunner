/**
 * Device vault — encrypted credentials + chat at rest (IndexedDB).
 *
 * Modes:
 *  - device: non-extractable AES key stored in IDB (auto-unlock same browser)
 *  - passphrase: key wrapped with PBKDF2-derived KEK (user unlocks once per session)
 *
 * Nothing sensitive is written to localStorage in plaintext.
 */

import {
  PBKDF2_ITERATIONS,
  type EncryptedBlob,
  decryptJson,
  deriveKeyFromPassphrase,
  encryptJson,
  generateDeviceKey,
  generateExtractableKey,
  randomBytes,
  b64encode,
  b64decode,
  wrapKey,
  unwrapKey,
} from "./crypto";
import type { Message } from "./types";

const DB_NAME = "edgerunner_vault";
const DB_VERSION = 2;
const STORE = "vault";

export type VaultMode = "device" | "passphrase";

export type VaultMeta = {
  version: 2;
  mode: VaultMode;
  saltB64?: string;
  iterations?: number;
  createdAt: number;
  /** Wrapped DEK when mode=passphrase */
  wrappedDek?: EncryptedBlob;
};

export type KaggleSecret = {
  username: string;
  apiToken?: string;
  apiKey?: string;
};

export type ChatRecord = {
  id: string;
  messages: Message[];
  updated_at: number;
  backend_url?: string;
  kernel_ref?: string;
  title?: string;
};

type VaultState = {
  meta: VaultMeta;
  key: CryptoKey;
  unlocked: true;
};

let memory: VaultState | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "k" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("vault db open failed"));
  });
}

async function idbPut(k: string, v: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ k, v });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet<T>(k: string): Promise<T | undefined> {
  const db = await openDb();
  const row = await new Promise<{ k: string; v: T } | undefined>(
    (resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(k);
      req.onsuccess = () => resolve(req.result as { k: string; v: T } | undefined);
      req.onerror = () => reject(req.error);
    }
  );
  db.close();
  return row?.v;
}

async function idbDel(k: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbKeys(): Promise<string[]> {
  const db = await openDb();
  const keys = await new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () =>
      resolve((req.result as IDBValidKey[]).map((k) => String(k)));
    req.onerror = () => reject(req.error);
  });
  db.close();
  return keys;
}

export type ChatSummary = {
  id: string;
  title: string;
  updated_at: number;
  count: number;
};

/** List saved chat sessions (metadata only), newest first. */
export async function listChats(): Promise<ChatSummary[]> {
  if (!memory && !(await tryAutoUnlock())) return [];
  if (!memory) return [];
  const keys = (await idbKeys()).filter(
    (k) => k.startsWith("chat:") && k !== "chat:lastId"
  );
  const out: ChatSummary[] = [];
  for (const k of keys) {
    const blob = await idbGet<EncryptedBlob>(k);
    if (!blob) continue;
    try {
      const rec = await decryptJson<ChatRecord>(memory.key, blob);
      const firstUser = rec.messages?.find(
        (m) => m.role === "user" && (m.content || "").trim()
      );
      out.push({
        id: rec.id,
        title:
          rec.title ||
          (firstUser?.content || "").slice(0, 48) ||
          rec.id,
        updated_at: rec.updated_at || 0,
        count: rec.messages?.length || 0,
      });
    } catch {
      /* undecryptable record — skip */
    }
  }
  out.sort((a, b) => b.updated_at - a.updated_at);
  return out;
}

export async function deleteChat(id: string): Promise<void> {
  await idbDel(`chat:${id}`);
}

/** Id of the most recently saved chat session (survives reloads). */
export async function getLastChatId(): Promise<string | null> {
  return (await idbGet<string>("chat:lastId")) || null;
}

export function isUnlocked(): boolean {
  return memory !== null;
}

export function getVaultMode(): VaultMode | null {
  return memory?.meta.mode ?? null;
}

export async function readMeta(): Promise<VaultMeta | null> {
  return (await idbGet<VaultMeta>("meta")) || null;
}

export async function vaultExists(): Promise<boolean> {
  return !!(await readMeta());
}

/** Create a new vault. Destroys any previous vault data. */
export async function createVault(opts: {
  mode: VaultMode;
  passphrase?: string;
}): Promise<void> {
  await wipeVault();

  if (opts.mode === "device") {
    const key = await generateDeviceKey();
    // Store CryptoKey directly in IDB (structured clone of CryptoKey)
    await idbPut("deviceKey", key);
    const meta: VaultMeta = {
      version: 2,
      mode: "device",
      createdAt: Date.now(),
    };
    await idbPut("meta", meta);
    memory = { meta, key, unlocked: true };
    clearLockFlag();
    return;
  }

  if (!opts.passphrase || opts.passphrase.length < 8) {
    throw new Error("Passphrase must be at least 8 characters");
  }
  const salt = randomBytes(16);
  const kek = await deriveKeyFromPassphrase(opts.passphrase, salt);
  const dek = await generateExtractableKey();
  const wrappedDek = await wrapKey(kek, dek);
  // Re-import as non-extractable for session use
  const raw = await crypto.subtle.exportKey("raw", dek);
  const sessionKey = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
  const meta: VaultMeta = {
    version: 2,
    mode: "passphrase",
    saltB64: b64encode(salt),
    iterations: PBKDF2_ITERATIONS,
    wrappedDek,
    createdAt: Date.now(),
  };
  await idbPut("meta", meta);
  memory = { meta, key: sessionKey, unlocked: true };
  clearLockFlag();
}

/** Auto-unlock device vault; returns false if passphrase required, session-locked, or missing. */
export async function tryAutoUnlock(): Promise<boolean> {
  if (memory) return true;
  if (isSessionLocked()) return false;
  const meta = await readMeta();
  if (!meta) return false;
  if (meta.mode === "passphrase") return false;
  const key = await idbGet<CryptoKey>("deviceKey");
  if (!key) return false;
  memory = { meta, key, unlocked: true };
  clearLockFlag();
  return true;
}

/** Re-open a device vault after session lock (no passphrase). */
export async function unlockDeviceVault(): Promise<void> {
  const meta = await readMeta();
  if (!meta || meta.mode !== "device") {
    throw new Error("Not a device vault");
  }
  const key = await idbGet<CryptoKey>("deviceKey");
  if (!key) throw new Error("Device key missing");
  memory = { meta, key, unlocked: true };
  clearLockFlag();
}

export async function unlockWithPassphrase(passphrase: string): Promise<void> {
  const meta = await readMeta();
  if (!meta || meta.mode !== "passphrase" || !meta.saltB64 || !meta.wrappedDek) {
    throw new Error("No passphrase vault on this device");
  }
  const salt = b64decode(meta.saltB64);
  const kek = await deriveKeyFromPassphrase(
    passphrase,
    salt,
    meta.iterations || PBKDF2_ITERATIONS
  );
  try {
    const key = await unwrapKey(kek, meta.wrappedDek);
    memory = { meta, key, unlocked: true };
    clearLockFlag();
  } catch {
    throw new Error("Wrong passphrase");
  }
}

const LOCK_FLAG = "edgerunner_vault_locked";

export function lockVault(): void {
  memory = null;
  try {
    sessionStorage.setItem(LOCK_FLAG, "1");
  } catch {
    /* ignore */
  }
}

function clearLockFlag(): void {
  try {
    sessionStorage.removeItem(LOCK_FLAG);
  } catch {
    /* ignore */
  }
}

export function isSessionLocked(): boolean {
  try {
    return sessionStorage.getItem(LOCK_FLAG) === "1";
  } catch {
    return false;
  }
}

export async function wipeVault(): Promise<void> {
  memory = null;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
  // scrub legacy plaintext stores
  try {
    sessionStorage.removeItem("edgerunner_kaggle_secret");
    localStorage.removeItem("edgerunner_last_chat");
  } catch {
    /* ignore */
  }
}

function requireKey(): CryptoKey {
  if (!memory) throw new Error("Vault is locked");
  return memory.key;
}

const SYNC_META_KEY = "edgerunner_sync_meta";

export function touchSyncMeta(): void {
  try {
    localStorage.setItem(
      SYNC_META_KEY,
      JSON.stringify({ updatedAt: Date.now() })
    );
  } catch {
    /* ignore */
  }
}

export function getLocalSyncUpdatedAt(): number {
  try {
    const raw = localStorage.getItem(SYNC_META_KEY);
    if (raw) {
      const j = JSON.parse(raw) as { updatedAt?: number };
      if (j.updatedAt) return j.updatedAt;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

async function pushCloudIfSignedIn(): Promise<void> {
  try {
    const { isGoogleSignedIn } = await import("./google-auth");
    if (!isGoogleSignedIn()) return;
    const { pushCloudSync } = await import("./cloud-sync");
    const secret = await loadSecret();
    const prefs = loadPrefs();
    await pushCloudSync({
      v: 1,
      updatedAt: Date.now(),
      secret,
      prefs,
    });
    touchSyncMeta();
  } catch (e) {
    console.warn("[EdgeRunner] cloud push skipped:", e);
  }
}

export async function saveSecret(secret: KaggleSecret): Promise<void> {
  const key = requireKey();
  const blob = await encryptJson(key, secret);
  await idbPut("credentials", blob);
  touchSyncMeta();
  void pushCloudIfSignedIn();
}

export async function loadSecret(): Promise<KaggleSecret | null> {
  if (!memory) return null;
  const blob = await idbGet<EncryptedBlob>("credentials");
  if (!blob) return null;
  try {
    return await decryptJson<KaggleSecret>(memory.key, blob);
  } catch {
    return null;
  }
}

export async function clearSecret(): Promise<void> {
  await idbDel("credentials");
  touchSyncMeta();
  void pushCloudIfSignedIn();
}

export async function saveChat(record: ChatRecord): Promise<void> {
  if (!memory) {
    // Ensure vault exists for chat encryption
    const exists = await vaultExists();
    if (!exists) {
      await createVault({ mode: "device" });
    } else if (!(await tryAutoUnlock())) {
      return; // locked passphrase vault — skip persist
    }
  }
  const key = requireKey();
  const blob = await encryptJson(key, record);
  await idbPut(`chat:${record.id}`, blob);
  await idbPut("chat:lastId", record.id);
}

export async function loadChat(id: string): Promise<ChatRecord | null> {
  if (!memory) {
    if (!(await tryAutoUnlock())) return null;
  }
  if (!memory) return null;
  const blob = await idbGet<EncryptedBlob>(`chat:${id}`);
  if (!blob) return null;
  try {
    return await decryptJson<ChatRecord>(memory.key, blob);
  } catch {
    return null;
  }
}

export async function listChatIds(): Promise<string[]> {
  // Simple: only track last id for now; expand later
  const last = await idbGet<string>("chat:lastId");
  return last ? [last] : [];
}

/** Non-secret prefs only (never tokens or message bodies). */
const PREFS_KEY = "edgerunner_prefs_v2";

export type StoredPrefs = {
  username?: string;
  mode?: "local" | "kaggle";
  localBackendUrl?: string;
  accelerator?: import("./types").Accelerator;
  idleTimeout?: number;
  maxLifetime?: number;
  /** Last known public tunnel / local backend URL (shared across tabs + cloud) */
  lastBackendUrl?: string;
  /** Stable kernel ref e.g. user/edgerunner */
  lastKernelRef?: string;
  rememberCredentials?: boolean;
  vaultMode?: VaultMode;
  /** OpenCode-inspired UI (see ui-prefs.ts) */
  uiView?: "cli" | "chat";
  agentMode?: "build" | "plan";
  showThinking?: boolean;
  showToolDetails?: boolean;
  showTimestamps?: boolean;
  /** /memory — persistent notes sent with every request */
  memoryNotes?: string[];
  /** /system — user's custom system-prompt addition */
  systemPrompt?: string;
  /** /engine — hermes (real Hermes Agent loop) or native harness */
  engine?: "hermes" | "native";
};

export function loadPrefs(): StoredPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) {
      // migrate old prefs key
      const old = localStorage.getItem("edgerunner_prefs");
      if (old) return JSON.parse(old) as StoredPrefs;
      return {};
    }
    return JSON.parse(raw) as StoredPrefs;
  } catch {
    return {};
  }
}

export function savePrefs(prefs: StoredPrefs): void {
  try {
    const prev = loadPrefs();
    // never allow secrets into prefs
    const clean: Record<string, unknown> = { ...prev, ...prefs };
    // Explicit undefined clears a key (e.g. lastBackendUrl after stop)
    for (const [k, v] of Object.entries(prefs)) {
      if (v === undefined) delete clean[k];
    }
    delete clean.apiToken;
    delete clean.apiKey;
    localStorage.setItem(PREFS_KEY, JSON.stringify(clean));
    touchSyncMeta();
    // Fire-and-forget cloud prefs sync when signed in
    void pushCloudIfSignedIn();
  } catch {
    /* ignore */
  }
}

/** One-time migration from legacy plaintext sessionStorage / IDB chats. */
export async function migrateLegacyIfNeeded(): Promise<void> {
  try {
    const legacy = sessionStorage.getItem("edgerunner_kaggle_secret");
    if (legacy && memory) {
      const parsed = JSON.parse(legacy) as KaggleSecret;
      if (parsed.username || parsed.apiToken || parsed.apiKey) {
        await saveSecret(parsed);
      }
      sessionStorage.removeItem("edgerunner_kaggle_secret");
    }
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem("edgerunner_last_chat");
  } catch {
    /* ignore */
  }
}
