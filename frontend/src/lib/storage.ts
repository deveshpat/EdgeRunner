/**
 * Local persistence for chat history + non-secret prefs.
 * Uses IndexedDB (durable, large) with localStorage fallback for prefs.
 */

import type { Message, StoredPrefs } from "./types";

const DB_NAME = "edgerunner";
const DB_VERSION = 1;
const CHAT_STORE = "chats";
const PREFS_KEY = "edgerunner_prefs";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHAT_STORE)) {
        db.createObjectStore(CHAT_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

export type ChatRecord = {
  id: string;
  messages: Message[];
  updated_at: number;
  backend_url?: string;
  kernel_ref?: string;
  title?: string;
};

export async function saveChat(record: ChatRecord): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CHAT_STORE, "readwrite");
      tx.objectStore(CHAT_STORE).put({
        ...record,
        updated_at: Date.now(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // best-effort: also mirror last chat into localStorage as tiny backup
    try {
      localStorage.setItem(
        "edgerunner_last_chat",
        JSON.stringify({
          id: record.id,
          messages: record.messages.slice(-50),
          updated_at: Date.now(),
        })
      );
    } catch {
      /* ignore quota */
    }
  }
}

export async function loadChat(id: string): Promise<ChatRecord | null> {
  try {
    const db = await openDb();
    const row = await new Promise<ChatRecord | null>((resolve, reject) => {
      const tx = db.transaction(CHAT_STORE, "readonly");
      const req = tx.objectStore(CHAT_STORE).get(id);
      req.onsuccess = () => resolve((req.result as ChatRecord) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return row;
  } catch {
    try {
      const raw = localStorage.getItem("edgerunner_last_chat");
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ChatRecord;
      if (parsed.id === id) return parsed;
    } catch {
      /* ignore */
    }
    return null;
  }
}

export async function listChats(limit = 20): Promise<ChatRecord[]> {
  try {
    const db = await openDb();
    const rows = await new Promise<ChatRecord[]>((resolve, reject) => {
      const tx = db.transaction(CHAT_STORE, "readonly");
      const req = tx.objectStore(CHAT_STORE).getAll();
      req.onsuccess = () => {
        const all = (req.result as ChatRecord[]) || [];
        all.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
        resolve(all.slice(0, limit));
      };
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows;
  } catch {
    return [];
  }
}

export function loadPrefs(): StoredPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as StoredPrefs;
  } catch {
    return {};
  }
}

export function savePrefs(prefs: StoredPrefs): void {
  try {
    const prev = loadPrefs();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prev, ...prefs }));
  } catch {
    /* ignore */
  }
}

/** Secrets stay in sessionStorage only (cleared when tab closes). */
const SECRET_KEY = "edgerunner_kaggle_secret";

export type KaggleSecret = {
  username: string;
  apiToken?: string;
  apiKey?: string;
};

export function saveSecret(secret: KaggleSecret): void {
  try {
    sessionStorage.setItem(SECRET_KEY, JSON.stringify(secret));
  } catch {
    /* ignore */
  }
}

export function loadSecret(): KaggleSecret | null {
  try {
    const raw = sessionStorage.getItem(SECRET_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as KaggleSecret;
  } catch {
    return null;
  }
}

export function clearSecret(): void {
  try {
    sessionStorage.removeItem(SECRET_KEY);
  } catch {
    /* ignore */
  }
}
