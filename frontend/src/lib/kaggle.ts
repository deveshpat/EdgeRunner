/**
 * Browser-side Kaggle Public API client.
 *
 * Kaggle's API responds with CORS ACAO for github.io and localhost origins,
 * so GitHub Pages can push kernels and scrape tunnel URLs without a proxy.
 *
 * Auth: Bearer <access token>  OR  Basic username:key
 */

import type { Accelerator } from "./types";
import {
  acceleratorFromLogs,
  acceleratorFromMachineShape,
  isGpuAccelerator,
  kaggleMachineShapesToTry,
} from "./types";
import {
  STABLE_KERNEL_TITLE,
  kernelSlug,
  loadKernelBundle,
  newSessionId,
  renderWorkerSource,
} from "./packer";

const API = "https://api.kaggle.com/v1";

export type KaggleAuth = {
  username: string;
  /** Modern access token (Bearer). Preferred. */
  apiToken?: string;
  /** Legacy API key (Basic username:key). */
  apiKey?: string;
};

export type LaunchOptions = {
  auth: KaggleAuth;
  accelerator: Accelerator;
  idleTimeout?: number;
  maxLifetime?: number;
  startupGrace?: number;
  /** If GPU fails (quota etc.), automatically retry on CPU. Default true. */
  fallbackCpu?: boolean;
  onProgress?: (update: LaunchProgress) => void;
  signal?: AbortSignal;
};

export type LaunchProgress = {
  state:
    | "packing"
    | "pushing"
    | "provisioning"
    | "online"
    | "failed"
    | "retrying_cpu";
  sessionId: string;
  kernelRef: string;
  accelerator: Accelerator;
  publicUrl?: string;
  kernelStatus?: string;
  logsTail?: string;
  error?: string;
  message?: string;
};

export type LaunchResult = {
  sessionId: string;
  kernelRef: string;
  accelerator: Accelerator;
  /** Shape string actually accepted by SaveKernel, if any */
  machineShape?: string;
  publicUrl: string;
  logsTail: string;
};

function authHeaders(auth: KaggleAuth): HeadersInit {
  if (auth.apiToken) {
    return { Authorization: `Bearer ${auth.apiToken}` };
  }
  if (auth.apiKey) {
    const token = btoa(`${auth.username}:${auth.apiKey}`);
    return { Authorization: `Basic ${token}` };
  }
  throw new Error("Provide a Kaggle API token or legacy API key");
}

async function kagglePost<T = unknown>(
  path: string,
  auth: KaggleAuth,
  body: unknown,
  signal?: AbortSignal
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
      (data as { error?: { message?: string }; message?: string })?.error
        ?.message ||
      (data as { message?: string })?.message ||
      text ||
      res.statusText;
    throw new Error(`Kaggle API ${res.status}: ${msg}`);
  }
  // Some endpoints nest errors in 200 bodies
  const err = (data as { error?: string | { message?: string } })?.error;
  if (typeof err === "string" && err) throw new Error(err);
  if (err && typeof err === "object" && err.message) throw new Error(err.message);
  return data as T;
}

export async function saveKernel(
  auth: KaggleAuth,
  opts: {
    slug: string;
    title: string;
    source: string;
    enableGpu: boolean;
    /**
     * Kaggle machineShape (wire camelCase). Official: NvidiaTeslaT4,
     * NvidiaTeslaP100, Tpu1VmV38. When set, this is authoritative —
     * bare enableGpu alone often defaults to P100.
     */
    machineShape?: string;
    sessionTimeoutSeconds: number;
    /** Attach previous run output (same notebook) so models/cache persist. */
    kernelDataSources?: string[];
  },
  signal?: AbortSignal
): Promise<{ ref?: string; url?: string; error?: string; kernelId?: number }> {
  const shape = (opts.machineShape || "").trim();
  const isTpu = /^Tpu/i.test(shape);
  // enableGpu/enableTpu are deprecated in favor of machineShape, but still set
  // for older API paths. Never send enableGpu:true without a shape when caller
  // wanted a specific GPU — that path is how P100 gets selected silently.
  const body: Record<string, unknown> = {
    slug: opts.slug,
    newTitle: opts.title,
    text: opts.source,
    language: "python",
    kernelType: "script",
    isPrivate: true,
    enableGpu: Boolean(opts.enableGpu && !isTpu),
    enableTpu: isTpu,
    enableInternet: true,
    sessionTimeoutSeconds: opts.sessionTimeoutSeconds,
    datasetDataSources: [] as string[],
    // Self-source: mounts prior version's /kaggle/working under /kaggle/input/
    kernelDataSources: opts.kernelDataSources ?? [],
    competitionDataSources: [] as string[],
    modelDataSources: [] as string[],
    categoryIds: [] as string[],
  };
  if (shape) {
    body.machineShape = shape;
  }
  return kagglePost(
    "/kernels.KernelsApiService/SaveKernel",
    auth,
    body,
    signal
  );
}

export async function kernelStatus(
  auth: KaggleAuth,
  username: string,
  slug: string,
  signal?: AbortSignal
): Promise<{ status?: string; failureMessage?: string }> {
  return kagglePost(
    "/kernels.KernelsApiService/GetKernelSessionStatus",
    auth,
    { userName: username, kernelSlug: slug },
    signal
  );
}

/** Fetch logs (live SSE while running, or persisted JSON blob when done). */
export async function kernelLogs(
  auth: KaggleAuth,
  username: string,
  slug: string,
  opts?: { maxMs?: number; signal?: AbortSignal }
): Promise<string> {
  const maxMs = opts?.maxMs ?? 12_000;
  const url = `${API}/kernels/logs/stream/${encodeURIComponent(username)}/${encodeURIComponent(slug)}`;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts?.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), maxMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "text/event-stream, application/json, */*",
        ...authHeaders(auth),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`logs ${res.status}: ${t.slice(0, 200)}`);
    }
    const ctype = (res.headers.get("Content-Type") || "").toLowerCase();
    if (ctype.includes("text/event-stream") && res.body) {
      return await readSseUntilUrl(res.body, maxMs);
    }
    const text = await res.text();
    return normalizeLogs(text);
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return ""; // timeout — caller will poll again
    }
    throw e;
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onAbort);
  }
}

async function readSseUntilUrl(
  body: ReadableStream<Uint8Array>,
  maxMs: number
): Promise<string> {
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
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining)
        ),
      ]);
      if (result.done) break;
      if (!result.value) break;
      buf += dec.decode(result.value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop() || "";
      for (const raw of parts) {
        const line = raw.trimEnd();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trimStart();
        if (payload === "END_OF_LOG") {
          return lines.join("\n");
        }
        try {
          const ev = JSON.parse(payload) as {
            data?: string;
            stream_name?: string;
          };
          const prefix = ev.stream_name === "stderr" ? "ERR " : "";
          lines.push(prefix + String(ev.data ?? "").replace(/\n$/, ""));
        } catch {
          lines.push(payload);
        }
        const joined = lines.join("\n");
        if (extractTunnelUrl(joined)) {
          return joined;
        }
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
      const data = JSON.parse(text) as unknown;
      if (Array.isArray(data)) {
        return data
          .map((ev) => {
            if (ev && typeof ev === "object" && "data" in ev) {
              const e = ev as { data?: string; stream_name?: string };
              const prefix = e.stream_name === "stderr" ? "ERR " : "";
              return prefix + String(e.data ?? "").replace(/\n$/, "");
            }
            return String(ev);
          })
          .join("\n");
      }
    }
  } catch {
    /* plain text */
  }
  return text;
}

const URL_RE =
  /(?:EDGERUNNER_URL|KAGGLE_PILOT_URL)=((?:https?:\/\/)[^\s]+)|(https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com)|(https:\/\/[a-zA-Z0-9-]+\.loca\.lt)|(https:\/\/[a-zA-Z0-9-]+\.localtunnel\.me)|(https?:\/\/bore\.pub:\d+)/;

export function extractTunnelUrl(logs: string): string | null {
  for (const line of logs.split("\n")) {
    const m = URL_RE.exec(line);
    if (m) {
      const url = m[1] || m[2] || m[3] || m[4] || m[5];
      if (url) return url.replace(/[)'".,;]+$/, "");
    }
  }
  const m = URL_RE.exec(logs);
  if (m) {
    const url = m[1] || m[2] || m[3] || m[4] || m[5];
    if (url) return url.replace(/[)'".,;]+$/, "");
  }
  return null;
}

function isGpuQuotaError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("gpu") ||
    m.includes("accelerator") ||
    m.includes("quota") ||
    m.includes("not enough") ||
    m.includes("insufficient") ||
    m.includes("no capacity") ||
    m.includes("hours remaining") ||
    m.includes("enable_gpu") ||
    m.includes("machine shape")
  );
}

/**
 * Push packed worker to Kaggle, poll until tunnel URL appears.
 * On GPU failure (quota), optionally retries with CPU.
 */
export async function launchKaggleSession(
  options: LaunchOptions
): Promise<LaunchResult> {
  const {
    auth,
    accelerator: requested,
    idleTimeout = 90,
    maxLifetime = 3600,
    startupGrace = 600,
    fallbackCpu = true,
    onProgress,
    signal,
  } = options;

  if (!auth.username?.trim()) throw new Error("Kaggle username is required");
  if (!auth.apiToken && !auth.apiKey) {
    throw new Error("Kaggle API token or key is required");
  }

  const tryOnce = async (accelerator: Accelerator): Promise<LaunchResult> => {
    const sessionId = newSessionId();
    // Always the same notebook on the user's Kaggle account (no spam kernels).
    const slug = kernelSlug(sessionId);
    const kernelRef = `${auth.username.trim()}/${slug}`;

    onProgress?.({
      state: "packing",
      sessionId,
      kernelRef,
      accelerator,
      message: "Packing backend into Kaggle worker…",
    });

    const bundle = await loadKernelBundle();
    const source = renderWorkerSource({
      bundle,
      sessionId,
      accelerator,
      idleTimeout,
      maxLifetime,
      startupGrace,
    });

    onProgress?.({
      state: "pushing",
      sessionId,
      kernelRef,
      accelerator,
      message: `Updating notebook ${kernelRef} (${accelerator.toUpperCase()})…`,
    });

    // Do NOT attach prior kernel output by default.
    // Mounting multi‑GB GGUF outputs makes Kaggle session start very slow.
    //
    // GPU shape selection (critical):
    // - Official machineShape values: NvidiaTeslaT4, NvidiaTeslaP100, Tpu1VmV38
    // - Bare enableGpu:true WITHOUT machineShape → Kaggle often assigns P100
    // - Never silently fall back to bare enableGpu when user asked for T4
    const shapesToTry = isGpuAccelerator(accelerator)
      ? kaggleMachineShapesToTry(accelerator)
      : [];

    let push: { ref?: string; url?: string; error?: string; kernelId?: number } | null =
      null;
    let lastPushErr: Error | null = null;
    let acceptedShape: string | undefined;
    const tried = new Set<string>();

    if (!isGpuAccelerator(accelerator)) {
      try {
        push = await saveKernel(
          auth,
          {
            slug: kernelRef,
            title: STABLE_KERNEL_TITLE,
            source,
            enableGpu: false,
            sessionTimeoutSeconds: maxLifetime,
            kernelDataSources: [],
          },
          signal
        );
        if (push.error) throw new Error(String(push.error));
      } catch (e) {
        throw e instanceof Error ? e : new Error(String(e));
      }
    } else {
      for (const shape of shapesToTry) {
        if (tried.has(shape)) continue;
        tried.add(shape);
        onProgress?.({
          state: "pushing",
          sessionId,
          kernelRef,
          accelerator,
          message: `Requesting ${shape}…`,
        });
        try {
          push = await saveKernel(
            auth,
            {
              slug: kernelRef,
              title: STABLE_KERNEL_TITLE,
              source,
              enableGpu: true,
              machineShape: shape,
              sessionTimeoutSeconds: maxLifetime,
              kernelDataSources: [],
            },
            signal
          );
          if (push.error) {
            lastPushErr = new Error(String(push.error));
            const em = String(push.error).toLowerCase();
            if (
              em.includes("machine") ||
              em.includes("shape") ||
              em.includes("accelerator") ||
              em.includes("invalid") ||
              em.includes("unknown") ||
              em.includes("not supported") ||
              em.includes("not available")
            ) {
              continue;
            }
            throw lastPushErr;
          }
          acceptedShape = shape;
          lastPushErr = null;
          break;
        } catch (e) {
          lastPushErr = e instanceof Error ? e : new Error(String(e));
          const em = lastPushErr.message.toLowerCase();
          if (
            em.includes("machine") ||
            em.includes("shape") ||
            em.includes("invalid") ||
            em.includes("accelerator") ||
            em.includes("unknown") ||
            em.includes("not supported") ||
            em.includes("not available")
          ) {
            continue;
          }
          throw lastPushErr;
        }
      }
    }
    if (!push || push.error) {
      throw (
        lastPushErr ||
        new Error(
          String(
            push?.error ||
              (isGpuAccelerator(accelerator)
                ? `Kernel push failed — could not reserve ${shapesToTry.join(" / ")}`
                : "Kernel push failed")
          )
        )
      );
    }

    // Prefer shape-derived label; refine from logs later if possible
    let effectiveAcc: Accelerator =
      acceleratorFromMachineShape(acceptedShape) || accelerator;

    onProgress?.({
      state: "provisioning",
      sessionId,
      kernelRef,
      accelerator: effectiveAcc,
      message: acceptedShape
        ? `Kernel running on ${acceptedShape} — waiting for HTTPS tunnel…`
        : "Kernel running — waiting for HTTPS tunnel…",
    });

    const deadline = Date.now() + 15 * 60_000; // 15 min cold start
    let logsTail = "";
    let lastStatus = "";

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Launch aborted");

      try {
        const st = await kernelStatus(auth, auth.username, slug, signal);
        lastStatus = String(st.status || st.failureMessage || "");
        onProgress?.({
          state: "provisioning",
          sessionId,
          kernelRef,
          accelerator: effectiveAcc,
          kernelStatus: lastStatus,
          logsTail,
        });

        const ks = lastStatus.toLowerCase();
        if (
          ks.includes("error") ||
          ks.includes("failed") ||
          ks.includes("cancelled")
        ) {
          throw new Error(
            st.failureMessage || `Kernel failed: ${lastStatus}`
          );
        }
      } catch (e) {
        // status can 403 briefly; keep going unless hard fail message
        const msg = e instanceof Error ? e.message : String(e);
        if (
          msg.toLowerCase().includes("failed") ||
          msg.toLowerCase().includes("quota")
        ) {
          throw e;
        }
      }

      try {
        const chunk = await kernelLogs(auth, auth.username, slug, {
          maxMs: 10_000,
          signal,
        });
        if (chunk) {
          logsTail = (logsTail + "\n" + chunk).slice(-12_000);
          // Refine GPU type from nvidia-smi / worker lines when available
          const fromLogs = acceleratorFromLogs(logsTail);
          if (fromLogs) effectiveAcc = fromLogs;
          const url = extractTunnelUrl(logsTail) || extractTunnelUrl(chunk);
          if (url) {
            onProgress?.({
              state: "online",
              sessionId,
              kernelRef,
              accelerator: effectiveAcc,
              publicUrl: url,
              kernelStatus: lastStatus,
              logsTail,
              message: acceptedShape
                ? `Tunnel ready · ${acceptedShape}`
                : "Tunnel ready",
            });
            return {
              sessionId,
              kernelRef,
              accelerator: effectiveAcc,
              machineShape: acceptedShape,
              publicUrl: url,
              logsTail,
            };
          }
          onProgress?.({
            state: "provisioning",
            sessionId,
            kernelRef,
            accelerator: effectiveAcc,
            kernelStatus: lastStatus,
            logsTail,
            message: acceptedShape
              ? `Waiting for tunnel (${acceptedShape})…`
              : "Waiting for tunnel URL in logs…",
          });
        }
      } catch {
        /* transient log errors while queued */
      }

      // complete without URL = worker died early
      if (lastStatus.toLowerCase() === "complete") {
        throw new Error(
          `Kernel finished without publishing a URL.\n${logsTail.slice(-800)}`
        );
      }

      await sleep(4000, signal);
    }

    throw new Error(
      "Timed out waiting for public tunnel URL in Kaggle logs. Check kernel logs on kaggle.com."
    );
  };

  try {
    return await tryOnce(requested);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (isGpuAccelerator(requested) && fallbackCpu && isGpuQuotaError(msg)) {
      onProgress?.({
        state: "retrying_cpu",
        sessionId: "",
        kernelRef: "",
        accelerator: "cpu",
        error: msg,
        message: "GPU unavailable / quota exhausted — falling back to CPU…",
      });
      return await tryOnce("cpu");
    }
    // Also fall back on any GPU push failure if fallback enabled
    if (isGpuAccelerator(requested) && fallbackCpu) {
      onProgress?.({
        state: "retrying_cpu",
        sessionId: "",
        kernelRef: "",
        accelerator: "cpu",
        error: msg,
        message: `GPU launch failed (${msg.slice(0, 120)}) — retrying on CPU…`,
      });
      return await tryOnce("cpu");
    }
    throw e;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

export async function waitForBackendHealth(
  backendUrl: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<{ online: boolean; model_ready: boolean; model?: unknown }> {
  const timeoutMs = opts?.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  const base = backendUrl.replace(/\/$/, "");
  let sawOnline = false;
  let lastModel: unknown;
  while (Date.now() < deadline) {
    if (opts?.signal?.aborted) throw new Error("aborted");
    try {
      const res = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (res.ok) {
        sawOnline = true;
        const data = (await res.json()) as {
          model_ready?: boolean;
          model?: unknown;
        };
        lastModel = data.model;
        // Only resolve when the model is actually loaded — not on first 200.
        if (data.model_ready) {
          return { online: true, model_ready: true, model: data.model };
        }
      }
    } catch {
      /* tunnel still warming or model loading */
    }
    await sleep(2000, opts?.signal);
  }
  return { online: sawOnline, model_ready: false, model: lastModel };
}
