import { openDB } from "idb";

const JINA_READ = "https://r.jina.ai/";
const CACHE_DB = "jina-cache";
const CACHE_TTL = 3_600_000;

type CacheRecord = {
  key: string;
  value: string;
  timestamp: number;
};

function canUseIndexedDb(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

let dbPromise: ReturnType<typeof openDB> | null = null;

function getDbPromise(): ReturnType<typeof openDB> | null {
  if (!canUseIndexedDb()) {
    return null;
  }

  if (!dbPromise) {
    dbPromise = openDB(CACHE_DB, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("pages")) {
          db.createObjectStore("pages", { keyPath: "key" });
        }
      },
    });
  }

  return dbPromise;
}

async function getCached(key: string): Promise<string | null> {
  const promise = getDbPromise();
  if (!promise) return null;
  const db = await promise;
  const record = (await db.get("pages", key)) as CacheRecord | undefined;
  if (!record) return null;
  if (Date.now() - record.timestamp > CACHE_TTL) {
    await db.delete("pages", key);
    return null;
  }
  return record.value;
}

async function setCached(key: string, value: string): Promise<void> {
  const promise = getDbPromise();
  if (!promise) return;
  const db = await promise;
  await db.put("pages", { key, value, timestamp: Date.now() } as CacheRecord);
}

export async function fetchUrl(url: string): Promise<string> {
  const normalized = url.trim();
  const cached = await getCached(normalized);
  if (cached) return cached;

  const res = await fetch(`${JINA_READ}${normalized}`, {
    headers: { Accept: "text/plain", "X-Return-Format": "markdown" },
  });

  if (!res.ok) {
    throw new Error(`Jina fetch failed: ${res.status}`);
  }

  const text = await res.text();
  await setCached(normalized, text);
  return text;
}
