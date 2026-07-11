/**
 * Cross-device / cross-tab backend discovery.
 *
 * Priority:
 *  1. Hint URL (prefs / live / Google cloud) → probe /health
 *  2. Kaggle API (same API token/key on any device) → kernel RUNNING?
 *     scrape EDGERUNNER_URL from logs → probe
 *
 * Google login is only for syncing prefs/secret; discovery itself is
 * credential-based so "not signed in but same Kaggle key" still works.
 */

import {
  attachRunningKaggleSession,
  type KaggleAuth,
  type LaunchResult,
} from "./kaggle";
import {
  loadLiveSession,
  probeBackend,
  saveLiveSession,
  type LiveSession,
} from "./session-persist";
import { loadPrefs, loadSecret, type KaggleSecret, type StoredPrefs } from "./vault";
import { getGoogleUser, isGoogleSignedIn } from "./google-auth";

export type DiscoverAuth = KaggleAuth & { source: "secret" | "prefs" | "form" };

export type DiscoverResult = {
  backendUrl: string;
  phase: "kaggle" | "local";
  kernelRef?: string;
  accelerator?: import("./types").Accelerator;
  modelReady: boolean;
  modelName: string | null;
  via: "hint" | "kaggle" | "live";
  googleEmail?: string | null;
};

export async function resolveKaggleAuth(
  form?: { username?: string; apiToken?: string; apiKey?: string }
): Promise<DiscoverAuth | null> {
  let secret: KaggleSecret | null = null;
  try {
    secret = await loadSecret();
  } catch {
    secret = null;
  }
  const prefs = loadPrefs();
  const username = (
    form?.username ||
    secret?.username ||
    prefs.username ||
    ""
  ).trim();
  const apiToken = (form?.apiToken || secret?.apiToken || "").trim() || undefined;
  const apiKey = (form?.apiKey || secret?.apiKey || "").trim() || undefined;
  if (!username || (!apiToken && !apiKey)) return null;
  const source: DiscoverAuth["source"] = secret?.apiToken || secret?.apiKey
    ? "secret"
    : form?.apiToken || form?.apiKey
      ? "form"
      : "prefs";
  return { username, apiToken, apiKey, source };
}

function collectHintUrls(extra?: string | null): string[] {
  const out: string[] = [];
  const add = (u?: string | null) => {
    const x = (u || "").replace(/\/$/, "").trim();
    if (x && !out.includes(x)) out.push(x);
  };
  add(extra);
  add(loadLiveSession()?.backendUrl);
  add(loadPrefs().lastBackendUrl);
  return out;
}

/**
 * Find a healthy EdgeRunner backend for this user.
 * Works with Google-synced prefs and/or the same Kaggle API credentials.
 */
export async function discoverActiveBackend(opts?: {
  form?: { username?: string; apiToken?: string; apiKey?: string };
  hintUrl?: string | null;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
  /** How long to wait for logs if kernel is RUNNING */
  kaggleWaitMs?: number;
}): Promise<DiscoverResult | null> {
  const googleEmail = isGoogleSignedIn() ? getGoogleUser()?.email ?? null : null;
  const hints = collectHintUrls(opts?.hintUrl);

  opts?.onProgress?.(
    googleEmail
      ? `Discovering session for ${googleEmail}…`
      : "Discovering session via Kaggle credentials…"
  );

  // 1) Probe all known URLs (local live + prefs + cloud-synced lastBackendUrl)
  for (const url of hints) {
    opts?.onProgress?.(`Probing ${url.replace(/^https?:\/\//, "")}…`);
    const probe = await probeBackend(url, { retries: 2, timeoutMs: 6000 });
    if (probe.ok) {
      const isTunnel =
        /trycloudflare\.com|loca\.lt|localtunnel\.me|bore\.pub/i.test(url);
      const live = loadLiveSession();
      const prefs = loadPrefs();
      const phase: "kaggle" | "local" =
        live?.phase ||
        (isTunnel ? "kaggle" : prefs.mode === "local" ? "local" : "kaggle");
      return {
        backendUrl: url,
        phase,
        kernelRef: live?.kernelRef || prefs.lastKernelRef,
        accelerator: live?.accelerator || prefs.accelerator,
        modelReady: probe.model_ready,
        modelName: probe.modelName,
        via: live?.backendUrl?.replace(/\/$/, "") === url ? "live" : "hint",
        googleEmail,
      };
    }
  }

  // 2) Same Kaggle API key on any device → status + logs (no Google required)
  const auth = await resolveKaggleAuth(opts?.form);
  if (!auth) {
    opts?.onProgress?.(
      "No Kaggle credentials on this device — sign in with Google or paste API token"
    );
    return null;
  }

  opts?.onProgress?.(
    `Kaggle API (${auth.username}) — checking for running EdgeRunner…`
  );

  const attached = await attachRunningKaggleSession(auth, {
    signal: opts?.signal,
    hintUrl: hints[0],
    maxWaitMs: opts?.kaggleWaitMs ?? 75_000,
    onProgress: opts?.onProgress,
  });

  if (!attached) return null;

  // Persist for this device + cloud prefs (if Google signed in, vault push fires)
  const session: LiveSession = {
    backendUrl: attached.publicUrl,
    phase: "kaggle",
    kernelRef: attached.kernelRef,
    accelerator: attached.accelerator,
    savedAt: Date.now(),
  };
  saveLiveSession(session);

  // Probe already done inside attach; re-probe lightly for model name
  const probe = await probeBackend(attached.publicUrl, {
    retries: 1,
    timeoutMs: 5000,
  });

  return {
    backendUrl: attached.publicUrl,
    phase: "kaggle",
    kernelRef: attached.kernelRef,
    accelerator: attached.accelerator,
    modelReady: probe.model_ready,
    modelName: probe.modelName,
    via: "kaggle",
    googleEmail,
  };
}

/** Apply discovery result into a compact note for the chat. */
export function discoverNote(r: DiscoverResult): string {
  const host = r.backendUrl.replace(/^https?:\/\//, "");
  const who = r.googleEmail ? ` · ${r.googleEmail}` : "";
  if (r.via === "kaggle") {
    return `linked via Kaggle API · ${host}${who}`;
  }
  if (r.via === "hint") {
    return `linked via synced prefs · ${host}${who}`;
  }
  return `session restored · ${host}${who}`;
}
