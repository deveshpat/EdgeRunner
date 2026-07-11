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
  acceleratorMatchesRequest,
  isGpuAccelerator,
  kaggleMachineShapesToTry,
  wantsT4,
  KAGGLE_SHAPE_T4,
} from "./types";
import {
  STABLE_KERNEL_SLUG,
  STABLE_KERNEL_TITLE,
  kernelSlug,
  loadKernelBundle,
  newSessionId,
  renderWorkerSource,
} from "./packer";
import { probeBackend } from "./session-persist";

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
  /** True when we attached to an already-running Kaggle worker (no re-push). */
  reused?: boolean;
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
     * Kaggle machineShape (wire camelCase). Official only:
     * NvidiaTeslaT4 | NvidiaTeslaP100 | Tpu1VmV38.
     * This field is authoritative; enableGpu is deprecated.
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
  const isGpuShape = /^NvidiaTesla/i.test(shape);

  // Kaggle docs: enable_gpu / enable_tpu are DEPRECATED — use machineShape.
  // Sending enableGpu:true without a valid machineShape defaults to P100.
  // When we have an official shape, always send it; set enableGpu true only
  // for Nvidia GPU shapes so older API paths still enable the accelerator.
  const body: Record<string, unknown> = {
    slug: opts.slug,
    newTitle: opts.title,
    text: opts.source,
    language: "python",
    kernelType: "script",
    isPrivate: true,
    enableInternet: true,
    sessionTimeoutSeconds: opts.sessionTimeoutSeconds,
    datasetDataSources: [] as string[],
    kernelDataSources: opts.kernelDataSources ?? [],
    competitionDataSources: [] as string[],
    modelDataSources: [] as string[],
    categoryIds: [] as string[],
  };

  if (shape) {
    // Authoritative — always set when we know the target hardware
    body.machineShape = shape;
    body.enableGpu = isGpuShape;
    body.enableTpu = isTpu;
  } else {
    // CPU only — never bare enableGpu:true (that is the P100 trap)
    body.enableGpu = false;
    body.enableTpu = false;
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
): Promise<{ status?: string | number; failureMessage?: string }> {
  return kagglePost(
    "/kernels.KernelsApiService/GetKernelSessionStatus",
    auth,
    { userName: username, kernelSlug: slug },
    signal
  );
}

/** Normalize Kaggle worker status (string or enum int) → uppercase name. */
export function normalizeKernelStatus(
  status: string | number | undefined | null
): string {
  if (status === null || status === undefined) return "";
  if (typeof status === "number") {
    // KernelWorkerStatus: QUEUED=0 RUNNING=1 COMPLETE=2 ERROR?=…
    const map = ["QUEUED", "RUNNING", "COMPLETE", "ERROR", "CANCEL_REQUESTED", "CANCELLED"];
    return map[status] || String(status);
  }
  return String(status).toUpperCase();
}

export function isKernelSessionActive(
  status: string | number | undefined | null
): boolean {
  const s = normalizeKernelStatus(status);
  return (
    s.includes("RUNNING") ||
    s.includes("QUEUED") ||
    s.includes("STARTING") ||
    s.includes("CANCEL_REQUESTED") // still up until cancelled
  );
}

/**
 * If the stable EdgeRunner notebook is already RUNNING on Kaggle, scrape the
 * tunnel URL from logs and probe /health. Returns null if nothing usable.
 *
 * When `requireAccelerator` is set (e.g. t4), sessions on the wrong GPU
 * (e.g. leftover P100) are rejected so the caller can relaunch with the
 * correct machineShape.
 */
export async function attachRunningKaggleSession(
  auth: KaggleAuth,
  opts?: {
    signal?: AbortSignal;
    onProgress?: (msg: string) => void;
    /** Prefer this URL first (from localStorage / other tab). */
    hintUrl?: string;
    maxWaitMs?: number;
    /** If set, refuse to attach when logs show a different GPU class. */
    requireAccelerator?: Accelerator;
  }
): Promise<LaunchResult | null> {
  const username = auth.username.trim();
  if (!username) return null;
  const slug = STABLE_KERNEL_SLUG;
  const kernelRef = `${username}/${slug}`;
  const signal = opts?.signal;
  const maxWaitMs = opts?.maxWaitMs ?? 45_000;
  const require = opts?.requireAccelerator;

  const accept = (
    result: LaunchResult,
    logs: string
  ): LaunchResult | null => {
    const fromLogs = acceleratorFromLogs(logs) || result.accelerator;
    const merged = { ...result, accelerator: fromLogs };
    if (
      require &&
      wantsT4(require) &&
      !acceleratorMatchesRequest(require, fromLogs)
    ) {
      opts?.onProgress?.(
        `Running session is ${fromLogs || "unknown GPU"} but you requested T4 — will relaunch`
      );
      return null;
    }
    if (
      require === "p100" &&
      fromLogs &&
      fromLogs !== "p100"
    ) {
      opts?.onProgress?.(
        `Running session is ${fromLogs} but you requested P100 — will relaunch`
      );
      return null;
    }
    return merged;
  };

  // 1) Fast path: probe known URL from another tab / prefs
  if (opts?.hintUrl) {
    opts.onProgress?.("Probing known backend URL…");
    const probe = await probeBackend(opts.hintUrl, {
      retries: 2,
      timeoutMs: 6000,
    });
    if (probe.ok) {
      // Try to learn GPU from recent logs while kernel is up
      let logs = "";
      try {
        logs = await kernelLogs(auth, username, slug, {
          maxMs: 6_000,
          signal,
        });
      } catch {
        /* ignore */
      }
      const fromLogs = acceleratorFromLogs(logs);
      // If user wants T4 and we can't confirm GPU from logs, still reject
      // when require is T4 and logs clearly say P100; if no logs, probe only
      // attaches when require is unset or logs match.
      if (require && wantsT4(require)) {
        if (fromLogs === "p100") {
          opts.onProgress?.(
            "Known URL is a P100 session — not reusing (need T4)"
          );
          // fall through to status check / relaunch
        } else if (fromLogs === "t4" || fromLogs === "t4x2") {
          return {
            sessionId: newSessionId(),
            kernelRef,
            accelerator: fromLogs,
            publicUrl: opts.hintUrl.replace(/\/$/, ""),
            logsTail: logs,
            reused: true,
          };
        } else {
          // Unknown GPU on live URL — for T4 request, scrape more logs below
          opts.onProgress?.(
            "Live URL OK but GPU type unclear — checking logs…"
          );
        }
      } else {
        return {
          sessionId: newSessionId(),
          kernelRef,
          accelerator: fromLogs || "gpu",
          publicUrl: opts.hintUrl.replace(/\/$/, ""),
          logsTail: logs,
          reused: true,
        };
      }
    }
  }

  // 2) Ask Kaggle if the stable kernel is mid-run
  opts?.onProgress?.("Checking Kaggle for an active EdgeRunner session…");
  let statusRaw: string | number | undefined;
  try {
    const st = await kernelStatus(auth, username, slug, signal);
    statusRaw = st.status;
  } catch {
    return null;
  }
  const status = normalizeKernelStatus(statusRaw);
  if (!isKernelSessionActive(statusRaw)) {
    opts?.onProgress?.(
      status ? `Kaggle kernel status: ${status} (not running)` : "No active Kaggle session"
    );
    return null;
  }

  opts?.onProgress?.(
    `Kernel ${status} — recovering tunnel URL from logs…`
  );

  const deadline = Date.now() + maxWaitMs;
  let logsTail = "";
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Launch aborted");
    try {
      const st = await kernelStatus(auth, username, slug, signal);
      if (!isKernelSessionActive(st.status)) {
        return null;
      }
      const chunk = await kernelLogs(auth, username, slug, {
        maxMs: 8_000,
        signal,
      });
      if (chunk) {
        logsTail = (logsTail + "\n" + chunk).slice(-12_000);
        const url = extractTunnelUrl(logsTail) || extractTunnelUrl(chunk);
        if (url) {
          opts?.onProgress?.(`Found tunnel — probing ${url.replace(/^https?:\/\//, "")}…`);
          const probe = await probeBackend(url, { retries: 4, timeoutMs: 8000 });
          if (probe.ok) {
            const fromLogs = acceleratorFromLogs(logsTail);
            const candidate: LaunchResult = {
              sessionId: newSessionId(),
              kernelRef,
              accelerator: fromLogs || "gpu",
              publicUrl: url.replace(/\/$/, ""),
              logsTail,
              reused: true,
            };
            const ok = accept(candidate, logsTail);
            if (ok) return ok;
            // Wrong GPU — stop waiting; caller will relaunch
            return null;
          }
        }
      }
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
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
 * Prefer an already-running EdgeRunner kernel (same notebook for the user).
 * Only push+run a new session if none is healthy.
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

  // ── Reuse existing worker (multi-tab / multi-device / re-click Launch) ──
  const sessionIdEarly = newSessionId();
  const kernelRefEarly = `${auth.username.trim()}/${kernelSlug(sessionIdEarly)}`;
  onProgress?.({
    state: "packing",
    sessionId: sessionIdEarly,
    kernelRef: kernelRefEarly,
    accelerator: requested,
    message: "Looking for an already-running EdgeRunner session…",
  });

  try {
    // Dynamic to avoid any circular init with session-persist helpers
    const sp = await import("./session-persist");
    const hint = sp.loadLiveSession()?.backendUrl;
    // Never reuse a P100 worker when the user selected T4 (common leftover
    // from older launches / bare enableGpu defaults).
    const requireAcc =
      wantsT4(requested) || requested === "p100" ? requested : undefined;
    const attached = await attachRunningKaggleSession(auth, {
      signal,
      hintUrl: hint,
      maxWaitMs: 45_000,
      requireAccelerator: requireAcc,
      onProgress: (message) =>
        onProgress?.({
          state: "provisioning",
          sessionId: sessionIdEarly,
          kernelRef: kernelRefEarly,
          accelerator: requested,
          message,
        }),
    });
    if (attached) {
      onProgress?.({
        state: "online",
        sessionId: attached.sessionId,
        kernelRef: attached.kernelRef,
        accelerator: attached.accelerator,
        publicUrl: attached.publicUrl,
        message: `Reused existing session (${attached.accelerator})`,
      });
      return attached;
    }

    // Kernel may still be RUNNING on the *wrong* GPU — SaveKernel with the
    // correct machineShape will push a new version and start a new session.
    try {
      const st = await kernelStatus(
        auth,
        auth.username.trim(),
        STABLE_KERNEL_SLUG,
        signal
      );
      if (isKernelSessionActive(st.status)) {
        // One more attach attempt only if we don't require a specific GPU class
        if (!requireAcc) {
          onProgress?.({
            state: "provisioning",
            sessionId: sessionIdEarly,
            kernelRef: kernelRefEarly,
            accelerator: requested,
            message:
              "Kernel still running — waiting longer for tunnel (not re-launching)…",
          });
          const retry = await attachRunningKaggleSession(auth, {
            signal,
            hintUrl: hint,
            maxWaitMs: 90_000,
            onProgress: (message) =>
              onProgress?.({
                state: "provisioning",
                sessionId: sessionIdEarly,
                kernelRef: kernelRefEarly,
                accelerator: requested,
                message,
              }),
          });
          if (retry) {
            onProgress?.({
              state: "online",
              sessionId: retry.sessionId,
              kernelRef: retry.kernelRef,
              accelerator: retry.accelerator,
              publicUrl: retry.publicUrl,
              message: "Reused existing Kaggle session",
            });
            return retry;
          }
          throw new Error(
            "EdgeRunner kernel is RUNNING on Kaggle but the tunnel URL could not be recovered from logs. " +
              "Open the notebook on kaggle.com or wait and try Launch again — we will not start a second session."
          );
        }
        onProgress?.({
          state: "pushing",
          sessionId: sessionIdEarly,
          kernelRef: kernelRefEarly,
          accelerator: requested,
          message: wantsT4(requested)
            ? `Active session is not T4 — relaunching with ${KAGGLE_SHAPE_T4}…`
            : `Relaunching with requested accelerator (${requested})…`,
        });
        // Fall through to SaveKernel with correct machineShape
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("will not start a second")) {
        throw e;
      }
      /* proceed to launch */
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    if (e instanceof Error && e.message.includes("will not start a second")) {
      throw e;
    }
    // Fall through to full launch
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
              // enableGpu derived from machineShape inside saveKernel
              enableGpu: true,
              machineShape: shape, // official enum only (e.g. NvidiaTeslaT4)
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
          // Hard fail if we asked for T4 but Kaggle actually gave P100
          if (
            wantsT4(accelerator) &&
            fromLogs === "p100"
          ) {
            throw new Error(
              `Kaggle assigned P100 even though machineShape=${acceptedShape || KAGGLE_SHAPE_T4} was requested. ` +
                "T4 may be unavailable on your account right now — pick P100 explicitly or retry later. " +
                "We will not pretend this is a T4 session."
            );
          }
          const url = extractTunnelUrl(logsTail) || extractTunnelUrl(chunk);
          if (url) {
            // Prefer log-detected GPU; if still unknown, trust requested shape
            if (!fromLogs && acceptedShape) {
              effectiveAcc =
                acceleratorFromMachineShape(acceptedShape) || accelerator;
            }
            onProgress?.({
              state: "online",
              sessionId,
              kernelRef,
              accelerator: effectiveAcc,
              publicUrl: url,
              kernelStatus: lastStatus,
              logsTail,
              message: acceptedShape
                ? `Tunnel ready · ${acceptedShape}${fromLogs ? ` · nvidia-smi=${fromLogs}` : ""}`
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
