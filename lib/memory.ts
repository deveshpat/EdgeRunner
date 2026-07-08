import { env, pipeline } from "@huggingface/transformers";
import { openDB } from "idb";

env.allowRemoteModels = true;
env.useBrowserCache = true;

const DB_NAME = "stuni-memory";

type Wing = "technical" | "research" | "creative" | "personal" | "video";

export interface MemoryEntry {
  id: string;
  wing: Wing;
  room: string;
  content: string;
  timestamp: number;
}

type EntryInput = Omit<MemoryEntry, "id" | "wing"> & { wing?: Wing };

let dbPromise: ReturnType<typeof openDB> | null = null;

function getDbPromise(): ReturnType<typeof openDB> | null {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    return null;
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("entries")) {
          db.createObjectStore("entries", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("embeddings")) {
          db.createObjectStore("embeddings", { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

let embedder:
  | ((text: string, options?: Record<string, unknown>) => Promise<{ data: Float32Array }>)
  | null = null;

function detectWing(content: string): Wing {
  const text = content.toLowerCase();
  if (/python|javascript|typescript|sql|bug|build|worker/.test(text)) return "technical";
  if (/paper|source|news|research|arxiv|wikipedia/.test(text)) return "research";
  if (/story|script|idea|creative|design/.test(text)) return "creative";
  if (/prefer|my name|i like|personal/.test(text)) return "personal";
  return "video";
}

async function getEmbedder() {
  if (embedder) return embedder;
  const model = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  embedder = async (text: string) => {
    const output = await (model as (
      input: string,
      options: Record<string, unknown>,
    ) => Promise<{ data: Float32Array }>)(text, {
      pooling: "mean",
      normalize: true,
    });
    return output;
  };
  return embedder;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    aNorm += a[i] * a[i];
    bNorm += b[i] * b[i];
  }
  if (!aNorm || !bNorm) return 0;
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

export const memory = {
  async store(entry: EntryInput): Promise<void> {
    const promise = getDbPromise();
    if (!promise) return;
    const db = await promise;
    const id = crypto.randomUUID();
    const wing = entry.wing || detectWing(entry.content);
    const payload: MemoryEntry = {
      id,
      wing,
      room: entry.room || "general",
      content: entry.content,
      timestamp: entry.timestamp || Date.now(),
    };
    await db.put("entries", payload);

    const extractor = await getEmbedder();
    const vector = (await extractor(payload.content)).data;
    await db.put("embeddings", { id, vector: Array.from(vector) });
  },

  async search(query: string, topK: number = 5): Promise<MemoryEntry[]> {
    const promise = getDbPromise();
    if (!promise) return [];
    const db = await promise;
    const entries = (await db.getAll("entries")) as MemoryEntry[];
    if (!entries.length) return [];

    const extractor = await getEmbedder();
    const queryVector = (await extractor(query)).data;
    const embeddings = (await db.getAll("embeddings")) as Array<{ id: string; vector: number[] }>;

    const scoreMap = new Map<string, number>();
    for (const emb of embeddings) {
      const score = cosineSimilarity(queryVector, new Float32Array(emb.vector));
      scoreMap.set(emb.id, score);
    }

    return entries
      .slice()
      .sort((a, b) => (scoreMap.get(b.id) || 0) - (scoreMap.get(a.id) || 0))
      .slice(0, topK);
  },

  async getStartupContext(): Promise<string> {
    const promise = getDbPromise();
    if (!promise) {
      return "L0:\nNo personal context yet.\n\nL1:\nNo recent facts yet.";
    }
    const db = await promise;
    const entries = ((await db.getAll("entries")) as MemoryEntry[]).sort(
      (a, b) => b.timestamp - a.timestamp,
    );

    const l0 = entries
      .filter((item) => item.wing === "personal")
      .slice(0, 2)
      .map((item) => item.content)
      .join(" ")
      .slice(0, 250);

    const l1 = entries
      .slice(0, 5)
      .map((item) => `- ${item.content}`)
      .join("\n")
      .slice(0, 700);

    return `L0:\n${l0 || "No personal context yet."}\n\nL1:\n${l1 || "No recent facts yet."}`;
  },
};
