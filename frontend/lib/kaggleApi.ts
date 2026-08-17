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

function authValue(auth: KaggleAuth): string {
  const secret = auth.apiKey.trim();
  // New-style API tokens (kaggle.com → Settings → API) are prefixed "KGAT_"
  // and authenticate as Bearer. Legacy 32-hex keys use Basic username:key.
  if (secret.startsWith("KGAT")) return `Bearer ${secret}`;
  return "Basic " + btoa(`${auth.username.trim()}:${secret}`);
}

function authHeaders(auth: KaggleAuth): HeadersInit {
  return { Authorization: authValue(auth) };
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
    // SaveKernel requires the owner-qualified slug ("username/edgerunner").
    slug: `${auth.username}/${STABLE_SLUG}`,
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
  /(?:EDGERUNNER_URL=\s*)(https?:\/\/[^\s"'\\]+)|(https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com)\b/i;

export function extractTunnelUrl(logs: string): string | null {
  if (!logs) return null;
  const lines = logs.split("\n").reverse();
  for (const line of lines) {
    const m = URL_RE.exec(line);
    if (m) {
      const candidate = (m[1] || m[2]).trim().replace(/[)'".,;]+$/, "");
      if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
        return candidate;
      }
    }
  }
  const m = URL_RE.exec(logs);
  if (!m) return null;
  const url = (m[1] || m[2]).trim().replace(/[)'".,;]+$/, "");
  return url.startsWith("http://") || url.startsWith("https://") ? url : null;
}

/** Fetch worker logs from Kaggle API using all available endpoints (RPC, REST, and stream). */
export async function kernelLogs(
  auth: KaggleAuth,
  opts?: { maxMs?: number; signal?: AbortSignal },
): Promise<string> {
  // 1. Try GetKernelSessionOutput RPC
  try {
    const d = await kagglePost<{
      log?: string;
      output?: string;
      sessionOutput?: string;
      consoleOutput?: string;
      data?: string;
      stream?: string;
      text?: string;
      lines?: string[];
      files?: { data?: string; text?: string; content?: string }[];
    }>(
      "/kernels.KernelsApiService/GetKernelSessionOutput",
      auth,
      { userName: auth.username, kernelSlug: STABLE_SLUG },
      opts?.signal,
    );
    if (d) {
      if (d.log) return parseSse(d.log);
      if (d.output) return parseSse(d.output);
      if (d.sessionOutput) return parseSse(d.sessionOutput);
      if (d.consoleOutput) return parseSse(d.consoleOutput);
      if (d.text) return parseSse(d.text);
      if (d.data) return parseSse(d.data);
      if (d.stream) return parseSse(d.stream);
      if (Array.isArray(d.lines)) return d.lines.join("\n");
      if (Array.isArray(d.files)) {
        const fileContent = d.files.map((f) => f.content || f.text || f.data || "").join("\n");
        if (fileContent) return fileContent;
      }
    }
  } catch {
    /* fallback */
  }

  // 2. Try GetKernelOutput RPC
  try {
    const d = await kagglePost<{ log?: string; output?: string; text?: string }>(
      "/kernels.KernelsApiService/GetKernelOutput",
      auth,
      { userName: auth.username, kernelSlug: STABLE_SLUG },
      opts?.signal,
    );
    if (d?.log) return parseSse(d.log);
    if (d?.output) return parseSse(d.output);
    if (d?.text) return parseSse(d.text);
  } catch {
    /* fallback */
  }

  // 3. Try REST GET /kernels/output
  try {
    const res = await fetch(
      `${API}/kernels/output?userName=${encodeURIComponent(auth.username)}&kernelSlug=${STABLE_SLUG}`,
      {
        headers: {
          Accept: "application/json, text/plain, */*",
          ...authHeaders(auth),
        },
        signal: opts?.signal,
      },
    );
    if (res.ok) {
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json.log) return parseSse(json.log);
        if (json.output) return parseSse(json.output);
        if (json.text) return parseSse(json.text);
      } catch {
        if (text) return parseSse(text);
      }
    }
  } catch {
    /* fallback */
  }

  // 4. Try streaming XHR endpoint
  return kernelLogsStream(auth, opts);
}

/** Fallback XHR SSE stream reader */
export function kernelLogsStream(
  auth: KaggleAuth,
  opts?: { maxMs?: number; signal?: AbortSignal },
): Promise<string> {
  const maxMs = opts?.maxMs ?? 8000;
  const url = `${API}/kernels/logs/stream/${encodeURIComponent(auth.username)}/${STABLE_SLUG}`;
  return new Promise((resolve) => {
    if (typeof XMLHttpRequest === "undefined") return resolve("");
    const xhr = new XMLHttpRequest();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", finish);
      try {
        xhr.abort();
      } catch {
        /* ignore */
      }
      resolve(parseSse(xhr.responseText || ""));
    };
    const timer = setTimeout(finish, maxMs);
    opts?.signal?.addEventListener("abort", finish);
    try {
      xhr.open("GET", url, true);
      xhr.setRequestHeader("Authorization", authValue(auth));
      xhr.setRequestHeader("Accept", "text/event-stream, application/json, */*");
      // Stop as soon as the tunnel URL shows up in the stream so far.
      xhr.onprogress = () => {
        if (extractTunnelUrl(xhr.responseText || "")) finish();
      };
      xhr.onload = finish;
      xhr.onerror = finish;
      xhr.ontimeout = finish;
      xhr.timeout = maxMs + 2000;
      xhr.send();
    } catch {
      finish();
    }
  });
}

/** Turn a raw SSE body ("data: {json}\n\n"…) or raw log into readable log text. */
export function parseSse(raw: string): string {
  if (!raw) return "";
  const out: string[] = [];
  let foundSse = false;
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:")) continue;
    foundSse = true;
    const p = s.slice(5).trim();
    if (p === "END_OF_LOG") break;
    try {
      const ev = JSON.parse(p) as {
        data?: string;
        stream_name?: string;
        message?: string;
        text?: string;
      };
      const content = ev.data ?? ev.message ?? ev.text ?? "";
      out.push((ev.stream_name === "stderr" ? "ERR " : "") + String(content).replace(/\n$/, ""));
    } catch {
      out.push(p);
    }
  }
  if (!foundSse) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
          .join("\n");
      }
      if (parsed && typeof parsed === "object") {
        if ("text" in parsed) return String(parsed.text);
        if ("data" in parsed) return String(parsed.data);
      }
    } catch {
      return raw;
    }
  }
  return out.join("\n");
}

/** Probe a candidate tunnel URL for a live EdgeRunner backend.
 *
 * Uses a manual AbortController timeout, NOT AbortSignal.timeout(), which is
 * unsupported on older mobile Safari (iOS < 16) — there it throws and the probe
 * would always fail, leaving the mobile UI stuck on "starting". */
export async function probeBackend(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/health`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
