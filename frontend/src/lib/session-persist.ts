/**
 * Active backend session bookmark — shared across tabs (localStorage) and
 * mirrored to sessionStorage for same-tab refresh. Cross-device via prefs
 * lastBackendUrl + Google vault sync of prefs.
 */

import { loadPrefs, savePrefs } from "./vault";

const KEY = "edgerunner_live_session_v2";
const KEY_LEGACY = "edgerunner_live_session_v1";
const BC_NAME = "edgerunner-session";

export type LiveSession = {
  backendUrl: string;
  phase: "kaggle" | "local";
  kernelRef?: string;
  accelerator?: import("./types").Accelerator;
  machineShape?: string;
  savedAt: number;
};

function parseLive(raw: string | null): LiveSession | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as LiveSession;
    if (!j?.backendUrl) return null;
    // Max lifetime is usually ≤1h; keep bookmark up to 6h for reconnect attempts
    if (j.savedAt && Date.now() - j.savedAt > 6 * 3600_000) {
      return null;
    }
    return j;
  } catch {
    return null;
  }
}

function writeBoth(s: LiveSession | null): void {
  try {
    if (s) {
      const raw = JSON.stringify(s);
      localStorage.setItem(KEY, raw);
      sessionStorage.setItem(KEY, raw);
    } else {
      localStorage.removeItem(KEY);
      sessionStorage.removeItem(KEY);
      sessionStorage.removeItem(KEY_LEGACY);
    }
  } catch {
    /* ignore quota / private mode */
  }
}

function broadcast(s: LiveSession | null): void {
  try {
    const bc = new BroadcastChannel(BC_NAME);
    bc.postMessage({ type: "live", session: s });
    bc.close();
  } catch {
    /* BroadcastChannel unsupported */
  }
}

export function saveLiveSession(s: LiveSession): void {
  const next = { ...s, savedAt: s.savedAt || Date.now() };
  writeBoth(next);
  // Prefs = cross-tab + cloud-synced (Google) path for other devices
  try {
    savePrefs({
      lastBackendUrl: next.backendUrl,
      mode: next.phase,
      accelerator: next.accelerator,
      lastKernelRef: next.kernelRef,
    } as import("./vault").StoredPrefs & { lastKernelRef?: string });
  } catch {
    /* ignore */
  }
  broadcast(next);
}

export function loadLiveSession(): LiveSession | null {
  // Prefer localStorage (shared tabs) → sessionStorage → prefs
  try {
    const fromLs = parseLive(localStorage.getItem(KEY));
    if (fromLs) return fromLs;
  } catch {
    /* ignore */
  }
  try {
    const fromSs =
      parseLive(sessionStorage.getItem(KEY)) ||
      parseLive(sessionStorage.getItem(KEY_LEGACY));
    if (fromSs) {
      // Promote to localStorage for other tabs
      writeBoth(fromSs);
      return fromSs;
    }
  } catch {
    /* ignore */
  }
  try {
    const prefs = loadPrefs() as import("./vault").StoredPrefs & {
      lastKernelRef?: string;
    };
    if (prefs.lastBackendUrl) {
      return {
        backendUrl: prefs.lastBackendUrl,
        phase: prefs.mode === "local" ? "local" : "kaggle",
        kernelRef: prefs.lastKernelRef,
        accelerator: prefs.accelerator,
        savedAt: Date.now() - 60_000, // unknown age — still try probe
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function clearLiveSession(): void {
  writeBoth(null);
  try {
    savePrefs({ lastBackendUrl: undefined, lastKernelRef: undefined } as import("./vault").StoredPrefs & {
      lastKernelRef?: string;
    });
  } catch {
    /* ignore */
  }
  broadcast(null);
}

/** Subscribe to live-session updates from other tabs. */
export function onLiveSessionChange(
  cb: (s: LiveSession | null) => void
): () => void {
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(BC_NAME);
    bc.onmessage = (ev) => {
      const data = ev.data as { type?: string; session?: LiveSession | null };
      if (data?.type === "live") cb(data.session ?? null);
    };
  } catch {
    /* ignore */
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cb(parseLive(e.newValue));
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("storage", onStorage);
    try {
      bc?.close();
    } catch {
      /* ignore */
    }
  };
}

/** Fire-and-forget heartbeat so idle watchdog doesn't kill during reconnect. */
export function pokeHeartbeat(backendUrl: string): void {
  const base = backendUrl.replace(/\/$/, "");
  if (!base) return;
  try {
    const img = new Image();
    img.src = `${base}/session/heartbeat?t=${Date.now()}`;
  } catch {
    /* ignore */
  }
  fetch(`${base}/session/heartbeat`, {
    method: "GET",
    keepalive: true,
    mode: "cors",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  }).catch(() => {});
}

export async function probeBackend(
  backendUrl: string,
  opts?: { retries?: number; timeoutMs?: number }
): Promise<{
  ok: boolean;
  model_ready: boolean;
  modelName: string | null;
}> {
  const base = backendUrl.replace(/\/$/, "");
  const retries = opts?.retries ?? 5;
  const timeoutMs = opts?.timeoutMs ?? 8000;

  for (let i = 0; i < retries; i++) {
    pokeHeartbeat(base);
    try {
      const res = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (res.ok) {
        const data = (await res.json()) as {
          model_ready?: boolean;
          model?: { ready?: boolean; name?: string };
        };
        return {
          ok: true,
          model_ready: !!(data.model_ready || data.model?.ready),
          modelName: data.model?.name || null,
        };
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 600 + i * 400));
  }
  return { ok: false, model_ready: false, modelName: null };
}
