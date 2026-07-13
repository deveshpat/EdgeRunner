// Browser-side Kaggle Public API client.
//
// Kaggle's API (api.kaggle.com/v1) returns CORS headers for github.io and
// localhost origins, so the page calls it directly with HTTP Basic auth — no
// server, and the API key never leaves the device.

const API = "https://api.kaggle.com/v1";

export const STABLE_SLUG = "edgerunner";
export const STABLE_TITLE = "EdgeRunner";

// Official Kaggle machine shapes (enable_gpu is deprecated in favour of these).
export const SHAPE_T4 = "NvidiaTeslaT4";

export interface KaggleAuth {
  username: string;
  apiKey: string;
}

function authHeaders(auth: KaggleAuth): HeadersInit {
  return { Authorization: "Basic " + btoa(`${auth.username}:${auth.apiKey}`) };
}

async function kagglePost<T = unknown>(
  path: string,
  auth: KaggleAuth,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...authHeaders(auth),
    },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (data as { error?: { message?: string } })?.error?.message ||
      (data as { message?: string })?.message ||
      text ||
      res.statusText;
    throw new Error(`Kaggle ${res.status}: ${msg}`);
  }
  return data as T;
}

/** Cheap auth check — throws on bad credentials.
 *
 * Uses ListKernels (resource-agnostic): it succeeds for any authenticated user
 * and 401s only on bad auth. Do NOT use GetKernelSessionStatus here — Kaggle
 * returns 401 for a kernel that doesn't exist yet / isn't yours, which would
 * reject valid credentials before the first launch. */
export async function validateAuth(auth: KaggleAuth): Promise<void> {
  await kagglePost(
    "/kernels.KernelsApiService/ListKernels",
    auth,
    { userName: auth.username, pageSize: 1 },
  );
}

export async function saveKernel(
  auth: KaggleAuth,
  source: string,
  opts: { gpu: boolean; sessionTimeoutSeconds: number },
  signal?: AbortSignal,
): Promise<void> {
  const body: Record<string, unknown> = {
    slug: STABLE_SLUG,
    newTitle: STABLE_TITLE,
    text: source,
    language: "python",
    kernelType: "script",
    isPrivate: true,
    enableInternet: true,
    sessionTimeoutSeconds: opts.sessionTimeoutSeconds,
    datasetDataSources: [],
    kernelDataSources: [],
    competitionDataSources: [],
    modelDataSources: [],
    categoryIds: [],
  };
  if (opts.gpu) {
    body.machineShape = SHAPE_T4;
    body.enableGpu = true;
  } else {
    body.enableGpu = false;
  }
  await kagglePost("/kernels.KernelsApiService/SaveKernel", auth, body, signal);
}

export async function kernelStatus(
  auth: KaggleAuth,
  signal?: AbortSignal,
): Promise<string> {
  const d = await kagglePost<{ status?: string | number; failureMessage?: string }>(
    "/kernels.KernelsApiService/GetKernelSessionStatus",
    auth,
    { userName: auth.username, kernelSlug: STABLE_SLUG },
    signal,
  );
  return normalizeStatus(d.status);
}

export function normalizeStatus(status: string | number | undefined | null): string {
  if (status === null || status === undefined) return "";
  if (typeof status === "number") {
    const map = ["QUEUED", "RUNNING", "COMPLETE", "ERROR", "CANCEL_REQUESTED", "CANCELLED"];
    return map[status] ?? String(status);
  }
  return String(status).toUpperCase();
}

export function isActive(status: string): boolean {
  return ["RUNNING", "QUEUED", "STARTING", "CANCEL_REQUESTED"].some((s) =>
    status.includes(s),
  );
}

const URL_RE =
  /(?:EDGERUNNER_URL=)((?:https?:\/\/)[^\s]+)|(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/;

export function extractTunnelUrl(logs: string): string | null {
  const m = URL_RE.exec(logs);
  if (!m) return null;
  const url = m[1] || m[2];
  return url ? url.replace(/[)'".,;]+$/, "") : null;
}

/** Fetch worker logs (SSE stream while running). Returns "" on timeout. */
export async function kernelLogs(
  auth: KaggleAuth,
  opts?: { maxMs?: number; signal?: AbortSignal },
): Promise<string> {
  const maxMs = opts?.maxMs ?? 12_000;
  const url = `${API}/kernels/logs/stream/${encodeURIComponent(auth.username)}/${STABLE_SLUG}`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts?.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), maxMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream, application/json, */*", ...authHeaders(auth) },
      signal: controller.signal,
    });
    if (!res.ok) return "";
    const ctype = (res.headers.get("Content-Type") || "").toLowerCase();
    if (ctype.includes("text/event-stream") && res.body) {
      return await readSseUntilUrl(res.body, maxMs);
    }
    return normalizeLogs(await res.text());
  } catch (e) {
    if ((e as Error).name === "AbortError") return "";
    throw e;
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onAbort);
  }
}

async function readSseUntilUrl(body: ReadableStream<Uint8Array>, maxMs: number): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const lines: string[] = [];
  const deadline = Date.now() + maxMs;
  let buf = "";
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (result.done || !result.value) break;
      buf += dec.decode(result.value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() || "";
      for (const raw of parts) {
        const line = raw.trimEnd();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trimStart();
        if (payload === "END_OF_LOG") return lines.join("\n");
        try {
          const ev = JSON.parse(payload) as { data?: string; stream_name?: string };
          const prefix = ev.stream_name === "stderr" ? "ERR " : "";
          lines.push(prefix + String(ev.data ?? "").replace(/\n$/, ""));
        } catch {
          lines.push(payload);
        }
        if (extractTunnelUrl(lines.join("\n"))) return lines.join("\n");
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return lines.join("\n");
}

export function normalizeLogs(raw: string): string {
  if (!raw) return "";
  const text = raw.trim();
  try {
    if (text.startsWith("[")) {
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        return data
          .map((ev) =>
            ev && typeof ev === "object" && "data" in ev
              ? (ev.stream_name === "stderr" ? "ERR " : "") +
                String(ev.data ?? "").replace(/\n$/, "")
              : String(ev),
          )
          .join("\n");
      }
    }
  } catch {
    /* plain text */
  }
  return text;
}

/** Probe a candidate tunnel URL for a live EdgeRunner backend. */
export async function probeBackend(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/health`, {
      signal: AbortSignal.timeout(6000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
