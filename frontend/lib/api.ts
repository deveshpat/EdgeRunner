// API client for the EdgeRunner backend.

// Chat/catalog go to the *active* base — the Kaggle tunnel URL once a session
// is online, and nothing otherwise. There is deliberately NO localhost default:
// in the deployed app there is no local backend, so defaulting to localhost
// only masked bugs during local dev (catalog/chat silently hit the dev server
// while the real Kaggle path was broken). For local dev against a fixed
// backend, set NEXT_PUBLIC_API_URL explicitly.
const DEFAULT_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

let activeBase = DEFAULT_BASE;

/** Point chat/catalog at a specific backend (e.g. the Kaggle tunnel), or reset. */
export function setApiBase(url: string | null): void {
  activeBase = url || DEFAULT_BASE;
}

export function getBackendBase(): string {
  if (activeBase) return activeBase.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    const saved =
      localStorage.getItem("edgerunner.backendUrl") ||
      localStorage.getItem("edgerunner_backend_url");
    if (saved) return saved.replace(/\/$/, "");
  }
  return (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000").replace(/\/$/, "");
}

export function getApiBase(): string {
  return getBackendBase();
}

/** True when a backend endpoint is resolvable. */
export function hasBackend(): boolean {
  return Boolean(getBackendBase());
}

/** Raised when a request is attempted with no backend connected. */
export const NO_BACKEND = "No backend connected — turn on the Kaggle backend or start local server.";

export interface Model {
  id: string;
  name: string;
  description: string;
  context_length: number;
}

export interface Harness {
  id: string;
  name: string;
  description: string;
}

export interface Catalog {
  models: Model[];
  harnesses: Harness[];
}

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export type StreamEventType =
  | "token"
  | "think"
  | "tool_call"
  | "tool_result"
  | "done"
  | "error";

export interface StreamEvent {
  type: StreamEventType;
  // For "token"/"error": plain text. For "tool_call"/"tool_result": a JSON
  // string describing the tool interaction (see ToolEvent).
  data: string;
}

export interface ToolEvent {
  id: string;
  name: string;
  // present on tool_call
  arguments?: string;
  // present on tool_result
  result?: string;
}

export async function fetchCatalog(): Promise<Catalog> {
  const resp = await fetch(`${getBackendBase()}/api/catalog`);
  if (!resp.ok) throw new Error(`catalog: ${resp.status}`);
  return resp.json();
}

/**
 * POST a chat request and yield parsed SSE events as they arrive.
 */
export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

export async function* streamChat(
  body: {
    model: string;
    harness: string;
    messages: ChatMessage[];
  } & SamplingParams,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const resp = await fetch(`${getBackendBase()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`chat: ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        yield JSON.parse(line.slice("data: ".length)) as StreamEvent;
      } catch {
        // ignore malformed frame
      }
    }
  }
}

export interface HardwareInfo {
  gpu: boolean;
  gpu_name: string | null;
  vram_gb: number | null;
  ram_gb: number | null;
}

export interface BackendModelStatus {
  status: "idle" | "downloading" | "loading" | "ready" | "error";
  model_id: string | null;
  repo: string | null;
  file: string | null;
  progress: number;
  downloaded_mb: number;
  total_mb: number;
  error: string | null;
  hardware: HardwareInfo;
}

export interface HFModel {
  id: string;
  name: string;
  repo: string;
  downloads: number;
  likes: number;
  param_size: string;
  categories: string[];
  recommended_file: string;
  fits_hardware: boolean;
  tier_label?: string;
}

export interface HFTreeFile {
  path: string;
  size_bytes: number;
  size_mb: number;
  size_gb: number;
  recommended: boolean;
}

export async function fetchModelStatus(): Promise<BackendModelStatus> {
  if (!hasBackend()) throw new Error(NO_BACKEND);
  const resp = await fetch(`${getApiBase()}/api/models/status`);
  if (!resp.ok) throw new Error(`models/status: ${resp.status}`);
  return resp.json();
}

export async function loadModelOnBackend(params: {
  repo: string;
  file: string;
  model_id?: string;
  gpu?: boolean;
  n_ctx?: number;
  hf_token?: string;
}): Promise<BackendModelStatus & { message?: string }> {
  if (!hasBackend()) throw new Error(NO_BACKEND);
  const resp = await fetch(`${getApiBase()}/api/models/load`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!resp.ok) throw new Error(`models/load: ${resp.status}`);
  return resp.json();
}

export async function fetchHuggingFaceModels(
  sort: "trending" | "downloads" | "likes" = "trending",
  search?: string,
  limit: number = 25,
): Promise<{ models: HFModel[]; cached: boolean }> {
  const base = hasBackend() ? getApiBase() : "";
  const query = new URLSearchParams({ sort, limit: String(limit) });
  if (search) query.set("search", search);

  // If backend is active, use backend proxy to avoid CORS/rate-limiting
  if (base) {
    const resp = await fetch(`${base}/api/models/explore?${query.toString()}`);
    if (resp.ok) return resp.json();
  }

  // Fallback: direct fetch from HuggingFace Hub API
  const hfSort = sort === "trending" ? "trendingScore" : sort;
  const hfParams = new URLSearchParams({
    filter: "gguf",
    sort: hfSort,
    direction: "-1",
    limit: String(limit),
    full: "false",
  });
  if (search) hfParams.set("search", search);

  const res = await fetch(`https://huggingface.co/api/models?${hfParams.toString()}`);
  if (!res.ok) throw new Error(`HF API: ${res.status}`);
  const raw = (await res.json()) as Array<{
    id?: string;
    modelId?: string;
    downloads?: number;
    likes?: number;
    tags?: string[];
  }>;

  const models: HFModel[] = raw.map((item) => {
    const repoId = item.id || item.modelId || "";
    const clean = repoId.split("/").pop() || repoId;
    return {
      id: repoId,
      name: clean,
      repo: repoId,
      downloads: item.downloads || 0,
      likes: item.likes || 0,
      param_size: "GGUF",
      categories: ["General"],
      recommended_file: `${clean.toLowerCase()}-q4_k_m.gguf`,
      fits_hardware: true,
    };
  });
  return { models, cached: false };
}

export async function fetchModelFiles(repo: string): Promise<HFTreeFile[]> {
  const base = hasBackend() ? getApiBase() : "";
  if (base) {
    const resp = await fetch(`${base}/api/models/tree?repo=${encodeURIComponent(repo)}`);
    if (resp.ok) {
      const data = await resp.json();
      return data.files || [];
    }
  }

  // Direct HF fallback
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main`);
  if (!res.ok) throw new Error(`HF tree: ${res.status}`);
  const files = (await res.json()) as Array<{ path?: string; size?: number }>;
  return files
    .filter((f) => f.path?.endsWith(".gguf"))
    .map((f) => {
      const bytes = f.size || 0;
      return {
        path: f.path || "",
        size_bytes: bytes,
        size_mb: Math.round(bytes / (1024 * 1024)),
        size_gb: Math.round((bytes / 1024 ** 3) * 100) / 100,
        recommended:
          f.path?.toLowerCase().includes("q4_k_m") ||
          f.path?.toLowerCase().includes("q4_0") ||
          false,
      };
    });
}

