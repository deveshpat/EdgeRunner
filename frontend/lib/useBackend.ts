"use client";

// Dead-simple backend connection: the user runs EdgeRunner on Kaggle (uvicorn
// + a cloudflared tunnel) and pastes the tunnel URL here. We probe it, point
// the app at it, and heartbeat to keep the worker's watchdog alive. The URL is
// persisted so a reload reconnects. No Kaggle API, no auto-launch, no secrets.

import { useCallback, useEffect, useRef, useState } from "react";

import { setApiBase } from "./api";

export type BackendStatus = "off" | "connecting" | "online" | "error";

const KEY = "edgerunner.backendUrl";

function normalize(url: string): string {
  let u = url.trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u.replace(/\/+$/, "");
}

async function probe(url: string): Promise<boolean> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 6000);
  try {
    const r = await fetch(`${url}/api/health`, { signal: c.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export interface UseBackend {
  url: string;
  status: BackendStatus;
  error: string | null;
  hydrated: boolean;
  connect: (url: string) => Promise<boolean>;
  disconnect: () => void;
}

export function useBackend(): UseBackend {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<BackendStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopBeat = useCallback(() => {
    if (beatRef.current) {
      clearInterval(beatRef.current);
      beatRef.current = null;
    }
  }, []);

  const goOnline = useCallback(
    (u: string) => {
      setApiBase(u);
      setUrl(u);
      setStatus("online");
      setError(null);
      try {
        localStorage.setItem(KEY, u);
      } catch {
        /* ignore */
      }
      stopBeat();
      const beat = () =>
        fetch(`${u}/api/session/heartbeat`, { method: "POST" }).catch(() => {});
      beat();
      beatRef.current = setInterval(beat, 25_000);
    },
    [stopBeat],
  );

  const connect = useCallback(
    async (raw: string) => {
      const u = normalize(raw);
      if (!u) {
        setError("Enter a backend URL.");
        setStatus("error");
        return false;
      }
      setUrl(u);
      setStatus("connecting");
      setError(null);
      if (await probe(u)) {
        goOnline(u);
        return true;
      }
      setStatus("error");
      setError("Could not reach that backend URL (is the tunnel up?).");
      setApiBase(null);
      return false;
    },
    [goOnline],
  );

  const disconnect = useCallback(() => {
    stopBeat();
    setApiBase(null);
    setStatus("off");
    setError(null);
    setUrl("");
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }, [stopBeat]);

  // Reconnect to the saved URL on load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let saved = "";
      try {
        saved = localStorage.getItem(KEY) || "";
      } catch {
        /* ignore */
      }
      if (saved) {
        setUrl(saved);
        if (await probe(saved)) {
          if (!cancelled) goOnline(saved);
        } else if (!cancelled) {
          setStatus("off");
        }
      }
      if (!cancelled) setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [goOnline]);

  useEffect(() => stopBeat, [stopBeat]);

  return { url, status, error, hydrated, connect, disconnect };
}
