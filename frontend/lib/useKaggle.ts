"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { getApiBase, setApiBase } from "./api";
import {
  configureKaggle,
  getKaggleStatus,
  startKaggle,
  stopKaggle,
  type KaggleState,
  type KaggleStatus,
} from "./kaggle";

const ACTIVE = new Set<KaggleState>(["pushing", "provisioning"]);

export interface UseKaggle {
  status: KaggleStatus | null;
  reachable: boolean; // is the orchestrator responding?
  state: KaggleState;
  publicUrl: string | null;
  busy: boolean;
  error: string | null;
  configure: (username: string, key: string) => Promise<boolean>;
  start: (accelerator: string) => Promise<void>;
  stop: () => Promise<void>;
}

export function useKaggle(): UseKaggle {
  const [status, setStatus] = useState<KaggleStatus | null>(null);
  const [reachable, setReachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const session = status?.session;
  const state: KaggleState = session?.state ?? "idle";
  const publicUrl = session?.public_url ?? null;

  // Reflect the current backend into the shared API base.
  useEffect(() => {
    setApiBase(state === "online" ? publicUrl : null);
  }, [state, publicUrl]);

  const refresh = useCallback(async () => {
    try {
      const s = await getKaggleStatus();
      setStatus(s);
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  // Initial + interval polling (faster while a session is spinning up).
  useEffect(() => {
    refresh();
    const fast = ACTIVE.has(state);
    const id = setInterval(refresh, fast ? 4000 : 15000);
    return () => clearInterval(id);
  }, [refresh, state]);

  // Heartbeat the worker while online so its watchdog keeps it alive.
  useEffect(() => {
    if (state !== "online") return;
    const beat = () => {
      fetch(`${getApiBase()}/api/session/heartbeat`, { method: "POST" }).catch(
        () => {},
      );
    };
    beat();
    const id = setInterval(beat, 25000);
    return () => clearInterval(id);
  }, [state]);

  const configure = useCallback(
    async (username: string, key: string) => {
      setBusy(true);
      setError(null);
      try {
        setStatus(await configureKaggle(username, key));
        setReachable(true);
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const start = useCallback(
    async (accelerator: string) => {
      setBusy(true);
      setError(null);
      try {
        setStatus(await startKaggle({ accelerator }));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const stop = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await stopKaggle());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    status,
    reachable,
    state,
    publicUrl,
    busy,
    error,
    configure,
    start,
    stop,
  };
}
