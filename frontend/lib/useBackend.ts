"use client";

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
  const t = setTimeout(() => c.abort(), 4000);
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
  isLocal: boolean;
  connect: (url: string) => Promise<boolean>;
  disconnect: () => void;
}

export function useBackend(onLocalDetected?: () => void): UseBackend {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<BackendStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [isLocal, setIsLocal] = useState(false);
  const beatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onLocalDetectedRef = useRef(onLocalDetected);
  onLocalDetectedRef.current = onLocalDetected;

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
      const isLocalHost = u.includes("127.0.0.1") || u.includes("localhost");
      setIsLocal(isLocalHost);
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

      if (isLocalHost && onLocalDetectedRef.current) {
        onLocalDetectedRef.current();
      }
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
      setError("Could not reach backend server.");
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
    setIsLocal(false);
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }, [stopBeat]);

  // Automated Local Backend Auto-Detection (127.0.0.1:8000)
  useEffect(() => {
    let cancelled = false;

    async function checkLocalAndSaved() {
      // 1. Check local device backend first (http://127.0.0.1:8000)
      const localOk = await probe("http://127.0.0.1:8000");
      if (localOk && !cancelled) {
        goOnline("http://127.0.0.1:8000");
        setHydrated(true);
        return;
      }

      // 2. Check saved URL
      let saved = "";
      try {
        saved = localStorage.getItem(KEY) || "";
      } catch {
        /* ignore */
      }

      if (saved && saved !== "http://127.0.0.1:8000") {
        setUrl(saved);
        if (await probe(saved)) {
          if (!cancelled) goOnline(saved);
        } else if (!cancelled) {
          setStatus("off");
        }
      }
      if (!cancelled) setHydrated(true);
    }

    checkLocalAndSaved();

    // Periodic auto-detector for local server (every 6 seconds if offline or on cloud)
    const interval = setInterval(async () => {
      if (url === "http://127.0.0.1:8000" && status === "online") return;
      const isUp = await probe("http://127.0.0.1:8000");
      if (isUp && !cancelled) {
        goOnline("http://127.0.0.1:8000");
      }
    }, 6000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [goOnline, status, url]);

  useEffect(() => stopBeat, [stopBeat]);

  return { url, status, error, hydrated, isLocal, connect, disconnect };
}
