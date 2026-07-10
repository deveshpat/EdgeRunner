/**
 * Keep the active Kaggle/local backend alive across page refresh.
 *
 * sessionStorage survives refresh in the same tab and is cleared when the tab
 * is closed — so we can reconnect automatically on refresh without re-launch.
 */

const KEY = "edgerunner_live_session_v1";

export type LiveSession = {
  backendUrl: string;
  phase: "kaggle" | "local";
  kernelRef?: string;
  accelerator?: "cpu" | "gpu";
  savedAt: number;
};

export function saveLiveSession(s: LiveSession): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function loadLiveSession(): LiveSession | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as LiveSession;
    if (!j?.backendUrl) return null;
    // Discard absurdly old (e.g. > 6h) — max lifetime is usually 1h
    if (j.savedAt && Date.now() - j.savedAt > 6 * 3600_000) {
      clearLiveSession();
      return null;
    }
    return j;
  } catch {
    return null;
  }
}

export function clearLiveSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
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
