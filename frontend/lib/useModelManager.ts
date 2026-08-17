"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  fetchModelStatus,
  hasBackend,
  loadModelOnBackend,
  type BackendModelStatus,
} from "@/lib/api";

export interface UseModelManager {
  modelStatus: BackendModelStatus | null;
  isSwitching: boolean;
  activeModelId: string | null;
  downloadProgress: number;
  downloadedMb: number;
  totalMb: number;
  loadingMessage: string;
  error: string | null;
  switchModel: (params: {
    repo: string;
    file: string;
    modelId?: string;
    gpu?: boolean;
    hfToken?: string;
  }) => Promise<boolean>;
  refreshStatus: () => Promise<void>;
}

export function useModelManager(backendOnline: boolean): UseModelManager {
  const [modelStatus, setModelStatus] = useState<BackendModelStatus | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!hasBackend() || !backendOnline) {
      setModelStatus(null);
      return;
    }
    try {
      const status = await fetchModelStatus();
      setModelStatus(status);
      if (status.status === "ready") {
        setIsSwitching(false);
        setLoadingMessage("");
        setError(null);
      } else if (status.status === "downloading") {
        setIsSwitching(true);
        setLoadingMessage(
          `Downloading model ${status.progress ? `(${status.progress}%)` : "…"}`
        );
      } else if (status.status === "loading") {
        setIsSwitching(true);
        setLoadingMessage("Starting llama-server…");
      } else if (status.status === "error") {
        setIsSwitching(false);
        setError(status.error || "Failed to load model on backend.");
      }
    } catch {
      // Backend not responsive or route missing
    }
  }, [backendOnline]);

  // Initial and periodic poll when backend is online or switching
  useEffect(() => {
    if (!backendOnline) {
      setIsSwitching(false);
      return;
    }

    refreshStatus();

    const intervalMs = isSwitching ? 1500 : 8000;
    const timer = setInterval(refreshStatus, intervalMs);
    return () => clearInterval(timer);
  }, [backendOnline, isSwitching, refreshStatus]);

  const switchModel = useCallback(
    async (params: {
      repo: string;
      file: string;
      modelId?: string;
      gpu?: boolean;
      hfToken?: string;
    }): Promise<boolean> => {
      if (!hasBackend() || !backendOnline) return false;

      setIsSwitching(true);
      setError(null);
      setLoadingMessage(`Requesting ${params.file}…`);

      try {
        const res = await loadModelOnBackend({
          repo: params.repo,
          file: params.file,
          model_id: params.modelId,
          gpu: params.gpu,
          hf_token: params.hfToken,
        });

        if (res.status === "ready") {
          setIsSwitching(false);
          setLoadingMessage("");
          await refreshStatus();
          return true;
        }

        // Poll actively until ready or error
        const startTime = Date.now();
        const timeoutMs = 600_000; // 10 mins for large downloads

        while (Date.now() - startTime < timeoutMs) {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const st = await fetchModelStatus();
            setModelStatus(st);

            if (st.status === "ready" && st.file === params.file) {
              setIsSwitching(false);
              setLoadingMessage("");
              return true;
            }

            if (st.status === "downloading") {
              setLoadingMessage(
                `Downloading ${st.file || "model"} (${st.progress}% - ${Math.round(
                  st.downloaded_mb
                )}/${Math.round(st.total_mb)}MB)`
              );
            } else if (st.status === "loading") {
              setLoadingMessage("Starting llama-server with new model…");
            } else if (st.status === "error") {
              setIsSwitching(false);
              setError(st.error || "Model loading failed on backend.");
              return false;
            }
          } catch {
            /* retry next cycle */
          }
        }

        setIsSwitching(false);
        setError("Timed out waiting for model to load.");
        return false;
      } catch (e) {
        setIsSwitching(false);
        setError((e as Error).message);
        return false;
      }
    },
    [backendOnline, refreshStatus]
  );

  return {
    modelStatus,
    isSwitching,
    activeModelId: modelStatus?.model_id || null,
    downloadProgress: modelStatus?.progress || 0,
    downloadedMb: modelStatus?.downloaded_mb || 0,
    totalMb: modelStatus?.total_mb || 0,
    loadingMessage,
    error,
    switchModel,
    refreshStatus,
  };
}
