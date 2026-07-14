"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getApiBase, setApiBase } from "./api";
import {
  extractTunnelUrl,
  isActive,
  kernelLogs,
  kernelStatus,
  probeBackend,
  saveKernel,
  validateAuth,
  type KaggleAuth,
} from "./kaggleApi";
import { loadWorkerTemplate, renderWorker, type WorkerConfig } from "./kernelBundle";
import { clearLiveSession, loadLiveSession, saveLiveSession } from "./liveSession";
import { DEFAULT_MODEL_ID, modelById } from "./models";
import { clearCreds, loadCreds, saveCreds as vaultSave } from "./vault";

export type KaggleState =
  | "idle"
  | "packing"
  | "pushing"
  | "provisioning"
  | "online"
  | "stopped"
  | "failed";

export interface UseKaggle {
  hydrated: boolean;
  configured: boolean;
  username: string | null;
  state: KaggleState;
  publicUrl: string | null;
  logs: string;
  busy: boolean;
  error: string | null;
  accelerator: string;
  setAccelerator: (a: string) => void;
  launchModel: string;
  setLaunchModel: (id: string) => void;
  hfToken: string;
  saveCreds: (username: string, key: string, hfToken: string) => Promise<boolean>;
  forget: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

// Die 90s after the last heartbeat (or if no client ever connects), so an
// orphaned/backgrounded session frees Kaggle quota fast. The frontend beats
// every 25s, so 90s tolerates a few missed beats.
const IDLE_TIMEOUT = 90;
const MAX_LIFETIME = 3600;
// Generous startup window: boot + deps + tunnel self-verify (which can respawn
// a born-dead tunnel) must all finish and the browser must connect before the
// idle-watchdog reaps the kernel. Too short → "starting" forever then COMPLETE.
const STARTUP_GRACE = 300;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

export function useKaggle(): UseKaggle {
  const [hydrated, setHydrated] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  const [state, setState] = useState<KaggleState>("idle");
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accelerator, setAcceleratorState] = useState("cpu");
  const [launchModel, setLaunchModelState] = useState(DEFAULT_MODEL_ID);
  const [hfToken, setHfToken] = useState("");

  const authRef = useRef<KaggleAuth | null>(null);
  const hfTokenRef = useRef("");
  hfTokenRef.current = hfToken;
  const abortRef = useRef<AbortController | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const setAccelerator = useCallback((a: string) => {
    setAcceleratorState(a);
    try {
      localStorage.setItem("edgerunner.accelerator", a);
    } catch {
      /* ignore */
    }
  }, []);

  const setLaunchModel = useCallback((id: string) => {
    setLaunchModelState(id);
    try {
      localStorage.setItem("edgerunner.launchModel", id);
    } catch {
      /* ignore */
    }
  }, []);

  // Restore the last-chosen accelerator + model on mount.
  useEffect(() => {
    try {
      const m = localStorage.getItem("edgerunner.launchModel");
      if (m) setLaunchModelState(m);
      const saved = localStorage.getItem("edgerunner.accelerator");
      if (saved) setAcceleratorState(saved);
    } catch {
      /* ignore */
    }
  }, []);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const goOnline = useCallback(
    (url: string) => {
      setPublicUrl(url);
      setState("online");
      setApiBase(url);
      saveLiveSession(url); // bookmark so a reload probes it directly
      stopHeartbeat();
      const beat = () =>
        fetch(`${getApiBase()}/api/session/heartbeat`, { method: "POST" }).catch(
          () => {},
        );
      beat();
      heartbeatRef.current = setInterval(beat, 25_000);
    },
    [stopHeartbeat],
  );

  // Scrape logs/status until the tunnel URL appears (shared by start + attach).
  const provision = useCallback(
    async (auth: KaggleAuth, signal: AbortSignal) => {
      setState("provisioning");
      const deadline = Date.now() + 900_000;
      while (Date.now() < deadline && !signal.aborted) {
        const status = await kernelStatus(auth, signal).catch(() => "");
        const log = await kernelLogs(auth, { signal, maxMs: 10_000 }).catch(() => "");
        if (log) setLogs(log.slice(-8000));
        const url = extractTunnelUrl(log);
        if (url && (await probeBackend(url))) {
          goOnline(url);
          return;
        }
        if (status.includes("ERROR") || status.includes("CANCEL")) {
          setState("failed");
          setError(`Kaggle kernel ${status || "failed"}`);
          return;
        }
        if (status.includes("COMPLETE") && !url) {
          setState("failed");
          setError("Kernel finished without publishing a URL (see logs).");
          return;
        }
        await sleep(6000, signal);
      }
      if (!signal.aborted) {
        setState("failed");
        setError("Timed out waiting for the tunnel URL.");
      }
    },
    [goOnline],
  );

  // Bounded log scrape → the tunnel URL, or null. Used by attach (short budget).
  const discoverUrl = useCallback(
    async (auth: KaggleAuth, signal: AbortSignal, budgetMs: number) => {
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline && !signal.aborted) {
        const log = await kernelLogs(auth, { signal, maxMs: 10_000 }).catch(() => "");
        if (log) setLogs(log.slice(-8000));
        const url = extractTunnelUrl(log);
        if (url) return url;
        await sleep(4000, signal);
      }
      return null;
    },
    [],
  );

  // Hydrate creds and attach to a running session — resolving to online or off
  // quickly, never leaving the UI stuck on "starting".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // 1) Fast path: probe the bookmarked URL directly (no log scraping).
      const bookmark = loadLiveSession();
      if (bookmark && (await probeBackend(bookmark))) {
        if (!cancelled) goOnline(bookmark);
      }

      const creds = await loadCreds();
      if (cancelled) return;
      if (creds) {
        authRef.current = { username: creds.username, apiKey: creds.apiKey };
        setUsername(creds.username);
        if (creds.hfToken) setHfToken(creds.hfToken);
      }

      // 2) If not already online via bookmark, do ONE bounded discovery pass:
      //    a running session → scrape+probe (~30s), else settle on "off".
      if (!cancelled && stateRef.current !== "online" && authRef.current) {
        const status = await kernelStatus(authRef.current).catch(() => "");
        if (!cancelled && isActive(status)) {
          const controller = new AbortController();
          abortRef.current = controller;
          const url = await discoverUrl(authRef.current, controller.signal, 30_000);
          if (!cancelled) {
            if (url && (await probeBackend(url))) goOnline(url);
            else setState("stopped"); // reachable? no → show "off", not "starting"
          }
        }
      }
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [goOnline, discoverUrl]);

  useEffect(() => stopHeartbeat, [stopHeartbeat]);

  const saveCreds = useCallback(async (u: string, key: string, hf: string) => {
    setBusy(true);
    setError(null);
    const auth: KaggleAuth = { username: u, apiKey: key };
    try {
      await validateAuth(auth);
      await vaultSave({ username: u, apiKey: key, hfToken: hf.trim() });
      authRef.current = auth;
      setUsername(u);
      setHfToken(hf.trim());
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const forget = useCallback(async () => {
    abortRef.current?.abort();
    stopHeartbeat();
    await clearCreds();
    clearLiveSession();
    authRef.current = null;
    setUsername(null);
    setHfToken("");
    setState("idle");
    setPublicUrl(null);
    setLogs("");
    setApiBase(null);
  }, [stopHeartbeat]);

  const start = useCallback(
    async () => {
      const auth = authRef.current;
      if (!auth) return;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setBusy(true);
      setError(null);
      setLogs("");
      try {
        // Reuse an already-running session for this account instead of
        // launching a second kernel (one kernel per API key).
        const existing = await kernelStatus(auth, controller.signal).catch(
          () => "",
        );
        if (isActive(existing)) {
          setLogs("Reconnecting to your running EdgeRunner session…");
          await provision(auth, controller.signal);
          return;
        }

        setState("packing");
        const template = await loadWorkerTemplate();
        const model = modelById(launchModel);
        const config: WorkerConfig = {
          gpu: accelerator === "gpu",
          cuda: "cu124",
          model_repo: model.repo,
          model_file: model.file,
          idle_timeout: IDLE_TIMEOUT,
          max_lifetime: MAX_LIFETIME,
          startup_grace: STARTUP_GRACE,
          hf_token: hfTokenRef.current.trim(),
        };
        const source = renderWorker(template, config);

        setState("pushing");
        await saveKernel(
          auth,
          source,
          { gpu: config.gpu, sessionTimeoutSeconds: MAX_LIFETIME },
          controller.signal,
        );
        await provision(auth, controller.signal);
      } catch (e) {
        if (!controller.signal.aborted) {
          setState("failed");
          setError((e as Error).message);
        }
      } finally {
        setBusy(false);
      }
    },
    [provision, accelerator, launchModel],
  );

  const stop = useCallback(async () => {
    abortRef.current?.abort();
    stopHeartbeat();
    setBusy(true);
    const url = publicUrl;
    if (url) {
      // Ask the worker to self-terminate (it also dies on idle timeout).
      try {
        await fetch(`${url.replace(/\/$/, "")}/api/session/shutdown`, {
          method: "POST",
        });
      } catch {
        /* ignore */
      }
    }
    clearLiveSession();
    setApiBase(null);
    setPublicUrl(null);
    setState("stopped");
    setBusy(false);
  }, [publicUrl, stopHeartbeat]);

  return {
    hydrated,
    configured: username !== null,
    username,
    state,
    publicUrl,
    logs,
    busy,
    error,
    accelerator,
    setAccelerator,
    launchModel,
    setLaunchModel,
    hfToken,
    saveCreds,
    forget,
    start,
    stop,
  };
}
