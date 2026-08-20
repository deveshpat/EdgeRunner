"use client";

import { useEffect, useState } from "react";

import { LAUNCH_MODELS, type LaunchModel } from "@/lib/models";
import type { UseModelManager } from "@/lib/useModelManager";
import type { UseKaggle } from "@/lib/useKaggle";
import type { UseBackend } from "@/lib/useBackend";

interface ModelPickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentModelId: string;
  onSelectModel: (model: {
    id: string;
    name: string;
    repo: string;
    file: string;
    gpu?: boolean;
  }) => void;
  modelManager: UseModelManager;
  hfToken?: string | null;
  gpuActive?: boolean;
  kaggle?: UseKaggle;
  backend?: UseBackend;
}

interface HfModelSummary {
  id: string;
  name: string;
  repo: string;
  downloads: number;
  likes: number;
  param_size: string;
  tier_label: string;
  fits_hardware: boolean;
  recommended_file: string;
}

interface QuantFile {
  path: string;
  size_mb: number;
  size_gb: number;
  recommended: boolean;
}

export function ModelPickerModal({
  isOpen,
  onClose,
  currentModelId,
  onSelectModel,
  modelManager,
  hfToken,
  gpuActive,
  kaggle,
  backend,
}: ModelPickerModalProps) {
  const [tab, setTab] = useState<"curated" | "hf">("curated");

  // HF Trending State
  const [hfModels, setHfModels] = useState<HfModelSummary[]>([]);
  const [hfSort, setHfSort] = useState<"trending" | "downloads" | "likes">("trending");
  const [search, setSearch] = useState("");
  const [loadingHf, setLoadingHf] = useState(false);

  // HF Quant inspect
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [repoFiles, setRepoFiles] = useState<QuantFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);

  // Fetch HF models when tab is open or search/sort changes
  useEffect(() => {
    if (!isOpen || tab !== "hf") return;
    const timer = setTimeout(() => {
      fetchHfModels();
    }, 250);
    return () => clearTimeout(timer);
  }, [isOpen, tab, hfSort, search]);

  async function fetchHfModels() {
    setLoadingHf(true);
    try {
      const q = new URLSearchParams({
        sort: hfSort,
        limit: "30",
      });
      if (search.trim()) q.set("search", search.trim());

      let data: { models?: HfModelSummary[] } | null = null;

      // 1. Try backend proxy if active
      try {
        const base = typeof window !== "undefined" ? localStorage.getItem("edgerunner_backend_url") || "" : "";
        const url = base ? `${base.replace(/\/$/, "")}/api/models/explore?${q.toString()}` : `/api/models/explore?${q.toString()}`;
        const res = await fetch(url, {
          headers: hfToken ? { Authorization: `Bearer ${hfToken}` } : {},
        });
        if (res.ok) {
          data = await res.json();
        }
      } catch {
        // Fallback to direct HF Hub API
      }

      // 2. Direct HF Hub API fallback
      if (!data || !data.models || data.models.length === 0) {
        const hfSortKey = hfSort === "trending" ? "trendingScore" : hfSort;
        const hfParams = new URLSearchParams({
          filter: "gguf",
          sort: hfSortKey,
          direction: "-1",
          limit: "30",
          full: "false",
        });
        if (search.trim()) hfParams.set("search", search.trim());
        const res = await fetch(`https://huggingface.co/api/models?${hfParams.toString()}`, {
          headers: hfToken ? { Authorization: `Bearer ${hfToken}` } : {},
        });
        if (res.ok) {
          const raw = (await res.json()) as Array<{
            id?: string;
            modelId?: string;
            downloads?: number;
            likes?: number;
            tags?: string[];
          }>;
          const models: HfModelSummary[] = raw.map((item) => {
            const repoId = item.id || item.modelId || "";
            const clean = repoId.split("/").pop() || repoId;
            const cleanName = clean.replace(/-GGUF$/i, "").replace(/-gguf$/i, "");
            return {
              id: repoId,
              name: cleanName,
              repo: repoId,
              downloads: item.downloads || 0,
              likes: item.likes || 0,
              param_size: "GGUF",
              tier_label: "COMPATIBLE",
              fits_hardware: true,
              recommended_file: `${cleanName.toLowerCase()}-q4_k_m.gguf`,
            };
          });
          data = { models };
        }
      }

      if (data && data.models) {
        setHfModels(data.models);
      }
    } catch {
      // ignore
    } finally {
      setLoadingHf(false);
    }
  }

  async function handleInspectRepo(repo: string) {
    if (selectedRepo === repo) {
      setSelectedRepo(null);
      setRepoFiles([]);
      return;
    }
    setSelectedRepo(repo);
    setLoadingFiles(true);
    try {
      let files: QuantFile[] | null = null;

      // 1. Try backend proxy
      try {
        const base = typeof window !== "undefined" ? localStorage.getItem("edgerunner_backend_url") || "" : "";
        const url = base
          ? `${base.replace(/\/$/, "")}/api/models/tree?repo=${encodeURIComponent(repo)}`
          : `/api/models/tree?repo=${encodeURIComponent(repo)}`;
        const res = await fetch(url, {
          headers: hfToken ? { Authorization: `Bearer ${hfToken}` } : {},
        });
        if (res.ok) {
          const data = await res.json();
          files = data.files || [];
        }
      } catch {
        // Fallback
      }

      // 2. Direct HF Hub API fallback
      if (!files || files.length === 0) {
        const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main`, {
          headers: hfToken ? { Authorization: `Bearer ${hfToken}` } : {},
        });
        if (res.ok) {
          const raw = (await res.json()) as Array<{ path?: string; size?: number }>;
          files = raw
            .filter((f) => f.path?.endsWith(".gguf"))
            .map((f) => {
              const bytes = f.size || 0;
              return {
                path: f.path || "",
                size_mb: Math.round((bytes / (1024 * 1024)) * 10) / 10,
                size_gb: Math.round((bytes / 1024 ** 3) * 100) / 100,
                recommended:
                  f.path?.toLowerCase().includes("q4_k_m") ||
                  f.path?.toLowerCase().includes("q4_0") ||
                  false,
              };
            });
        }
      }

      setRepoFiles(files || []);
    } catch {
      setRepoFiles([]);
    } finally {
      setLoadingFiles(false);
    }
  }

  function handleChooseCurated(m: LaunchModel) {
    const cleanId = m.file.replace(/\.gguf$/i, "");
    onSelectModel({
      id: cleanId,
      name: m.label,
      repo: m.repo,
      file: m.file,
      gpu: m.gpu,
    });
    onClose();
  }

  function handleChooseHfFile(repo: string, filePath: string) {
    const cleanId = filePath.replace(/\.gguf$/i, "");
    onSelectModel({
      id: cleanId,
      name: filePath,
      repo,
      file: filePath,
    });
    onClose();
  }

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded border border-term-border bg-term-bg shadow-2xl font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-term-border bg-term-panel/70 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-term-green font-bold">
              ◈ NEURAL PAYLOAD MATRIX
            </span>
            {modelManager.isSwitching && (
              <span className="rounded bg-term-amber/20 border border-term-amber/30 px-2 py-0.5 text-[10px] font-semibold text-term-amber animate-pulse">
                ⚡ SYNCING // {modelManager.downloadProgress ? `${modelManager.downloadProgress}%` : "MOUNTING"}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded border border-term-border text-term-dim hover:border-term-green hover:text-term-fg text-xs transition-colors"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Integrated Compute Rig & Cloud Acceleration Control Banner */}
        {kaggle && (
          <div className="border-b border-term-border bg-term-panel/50 p-3 sm:px-4 text-xs select-none">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    backend?.isLocal
                      ? "bg-term-green animate-pulse"
                      : kaggle.state === "online"
                        ? "bg-term-green animate-pulse"
                        : "bg-term-amber"
                  }`}
                />
                <div>
                  <span className="font-bold text-[11px] text-term-fg">
                    {backend?.isLocal
                      ? "LOCAL BACKEND (127.0.0.1:8000)"
                      : kaggle.state === "online"
                        ? `KAGGLE CLOUD RIG (${kaggle.accelerator.toUpperCase()})`
                        : "CLOUD COMPUTE RIG"}
                  </span>
                  <span className="text-[10px] text-term-dim block">
                    {backend?.isLocal
                      ? "● Connected to local Python instance"
                      : kaggle.state === "online"
                        ? "● Connected to Kaggle GPU worker"
                        : "○ Offline (30h/wk free T4 GPU available)"}
                  </span>
                </div>
              </div>

              {/* Accelerator Toggle & Control Button */}
              <div className="flex items-center gap-2 ml-auto">
                <div className="flex rounded border border-term-border bg-term-bg p-0.5 text-[10px]">
                  <button
                    onClick={() => kaggle.setAccelerator("gpu")}
                    className={`px-2 py-0.5 rounded font-semibold transition-colors ${
                      kaggle.accelerator === "gpu"
                        ? "bg-term-green/20 text-term-green"
                        : "text-term-dim hover:text-term-fg"
                    }`}
                  >
                    ⚡ Nvidia T4
                  </button>
                  <button
                    onClick={() => kaggle.setAccelerator("cpu")}
                    className={`px-2 py-0.5 rounded font-semibold transition-colors ${
                      kaggle.accelerator === "cpu"
                        ? "bg-term-green/20 text-term-green"
                        : "text-term-dim hover:text-term-fg"
                    }`}
                  >
                    🖥 CPU
                  </button>
                </div>

                {kaggle.state === "online" ? (
                  <button
                    onClick={kaggle.stop}
                    className="rounded border border-term-red/60 bg-term-red/10 px-2.5 py-1 text-[10px] font-bold text-term-red hover:bg-term-red/20 transition-colors"
                  >
                    ■ Stop Rig
                  </button>
                ) : kaggle.busy ||
                  kaggle.state === "packing" ||
                  kaggle.state === "pushing" ||
                  kaggle.state === "provisioning" ? (
                  <span className="text-term-amber text-[10px] font-bold animate-pulse px-2">
                    ⚡ {kaggle.state.toUpperCase()}…
                  </span>
                ) : (
                  <button
                    onClick={kaggle.start}
                    className="rounded border border-term-green/60 bg-term-green/15 px-2.5 py-1 text-[10px] font-bold text-term-green hover:bg-term-green/25 transition-colors shadow-sm"
                  >
                    🚀 Launch Rig
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-term-border bg-term-panel/40 px-4 pt-2 text-xs">
          <button
            onClick={() => setTab("curated")}
            className={`flex items-center gap-1.5 border-b-2 px-3.5 py-2 font-semibold transition-all ${
              tab === "curated"
                ? "border-term-green text-term-green shadow-[inset_0_-2px_0_rgba(62,207,92,0.4)]"
                : "border-transparent text-term-dim hover:text-term-fg"
            }`}
          >
            <span>◈</span>
            <span>Curated</span>
          </button>
          <button
            onClick={() => setTab("hf")}
            className={`flex items-center gap-1.5 border-b-2 px-3.5 py-2 font-semibold transition-all ${
              tab === "hf"
                ? "border-term-green text-term-green shadow-[inset_0_-2px_0_rgba(62,207,92,0.4)]"
                : "border-transparent text-term-dim hover:text-term-fg"
            }`}
          >
            <span>✦</span>
            <span>Trending</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-4 text-xs font-mono">
          {tab === "curated" && (
            <div className="space-y-3">
              <p className="text-[11px] text-term-dim">
                ◈ SOTA verified open-weights neural payloads. Click any card to mount.
              </p>
              <div className="grid gap-2 sm:grid-cols-1">
                {LAUNCH_MODELS.map((m) => {
                  const modelCleanId = m.file.replace(/\.gguf$/i, "");
                  const isCurrent =
                    currentModelId === modelCleanId ||
                    currentModelId === m.id ||
                    modelManager.activeModelId === modelCleanId;

                  return (
                    <div
                      key={m.id}
                      onClick={() => !modelManager.isSwitching && handleChooseCurated(m)}
                      className={`group flex flex-col justify-between rounded border p-3 transition-all cursor-pointer sm:flex-row sm:items-center ${
                        isCurrent
                          ? "border-term-green/80 bg-term-green/10 shadow-[0_0_12px_rgba(62,207,92,0.1)]"
                          : "border-term-border bg-term-panel/40 hover:border-term-green/70 hover:bg-term-green/5"
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-term-fg text-xs group-hover:text-term-green transition-colors">
                            {m.label}
                          </span>
                          {isCurrent && (
                            <span className="rounded bg-term-green/20 border border-term-green/30 px-1.5 py-0.2 text-[9px] font-bold text-term-green">
                              ● MOUNTED
                            </span>
                          )}
                          {m.gpu && (
                            <span className="rounded bg-term-amber/20 border border-term-amber/30 px-1.5 py-0.2 text-[9px] font-bold text-term-amber">
                              ⚡ GPU (T4)
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-term-dim leading-snug">{m.note}</p>
                        <p className="text-[10px] text-term-dim/60">
                          {m.repo} :: {m.file}
                        </p>
                      </div>
                      <div className="mt-2 shrink-0 sm:mt-0 flex items-center gap-2 text-xs">
                        {isCurrent ? (
                          <span className="text-term-green font-semibold">✓ ACTIVE</span>
                        ) : (
                          <span className="text-term-dim group-hover:text-term-green transition-colors">
                            select ↵
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === "hf" && (
            <div className="space-y-3">
              {/* Controls */}
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  placeholder="Search Hugging Face (qwen, deepseek, coder, mistral, llama)…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="flex-1 rounded border border-term-border bg-term-bg px-2.5 py-1.5 text-term-fg placeholder:text-term-dim focus:border-term-green focus:outline-none text-xs"
                />
                <select
                  value={hfSort}
                  onChange={(e) => setHfSort(e.target.value as "trending" | "downloads" | "likes")}
                  className="rounded border border-term-border bg-term-bg px-2 py-1.5 text-term-fg focus:border-term-green focus:outline-none text-xs"
                >
                  <option value="trending">✦ Trending Score</option>
                  <option value="downloads">⤓ Most Downloaded</option>
                  <option value="likes">★ Most Starred</option>
                </select>
              </div>

              {loadingHf ? (
                <div className="py-8 text-center text-term-dim text-xs">
                  ⚡ Intercepting GGUF telemetry from Hugging Face Hub…
                </div>
              ) : hfModels.length === 0 ? (
                <div className="py-8 text-center text-term-dim text-xs">
                  ✕ No matching payloads found in the net.
                </div>
              ) : (
                <div className="space-y-2">
                  {hfModels.map((m) => (
                    <div
                      key={m.id}
                      className="rounded border border-term-border bg-term-panel/40 p-3 transition-colors hover:border-term-dim"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-semibold text-term-fg text-xs">{m.name}</span>
                            <span className="rounded border border-term-border px-1.5 py-0.2 text-[10px] text-term-dim">
                              {m.param_size}
                            </span>
                            {m.tier_label && (
                              <span className="rounded bg-term-green/20 border border-term-green/30 px-1.5 py-0.2 text-[10px] font-semibold text-term-green">
                                {m.tier_label}
                              </span>
                            )}
                          </div>
                          <p className="text-[10px] text-term-dim">{m.repo}</p>
                          <div className="flex items-center gap-3 text-[10px] text-term-dim">
                            <span>⤓ {m.downloads.toLocaleString()}</span>
                            <span>★ {m.likes.toLocaleString()}</span>
                            <span className={m.fits_hardware ? "text-term-green" : "text-term-amber"}>
                              {m.fits_hardware ? "● Compatible" : "⚠ >46GB Extended"}
                            </span>
                          </div>
                        </div>

                        <button
                          onClick={() => handleInspectRepo(m.repo)}
                          className="shrink-0 rounded border border-term-border px-2.5 py-1 text-[11px] text-term-green hover:border-term-green hover:bg-term-green/10 transition-colors"
                        >
                          {selectedRepo === m.repo ? "▾ Hide Quants" : "▸ View Quants"}
                        </button>
                      </div>

                      {/* Expanded GGUF Files Tree */}
                      {selectedRepo === m.repo && (
                        <div className="mt-3 border-t border-term-border pt-2.5">
                          {loadingFiles ? (
                            <p className="py-2 text-center text-term-dim text-xs">
                              ⚡ Scanning quantization tree…
                            </p>
                          ) : repoFiles.length === 0 ? (
                            <div
                              onClick={() => handleChooseHfFile(m.repo, m.recommended_file)}
                              className="group flex items-center justify-between rounded bg-term-bg/70 px-2.5 py-1.5 border border-term-border/40 cursor-pointer hover:border-term-green/70 hover:bg-term-green/10 transition-colors"
                            >
                              <span className="text-term-dim text-xs group-hover:text-term-fg">
                                Default: {m.recommended_file}
                              </span>
                              <span className="text-xs text-term-green font-semibold">
                                ⤓ select
                              </span>
                            </div>
                          ) : (
                            <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
                              {repoFiles.map((f) => (
                                <div
                                  key={f.path}
                                  onClick={() => handleChooseHfFile(m.repo, f.path)}
                                  className="group flex items-center justify-between rounded bg-term-bg/70 px-2.5 py-1.5 border border-term-border/40 cursor-pointer hover:border-term-green/70 hover:bg-term-green/10 transition-colors"
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-[11px] text-term-fg truncate font-mono group-hover:text-term-green">
                                      {f.path}
                                    </span>
                                    <span className="text-[10px] text-term-dim shrink-0">
                                      {f.size_gb > 0 ? `${f.size_gb} GB` : `${f.size_mb} MB`}
                                    </span>
                                    {f.recommended && (
                                      <span className="rounded bg-term-green/20 px-1 text-[9px] font-bold text-term-green shrink-0">
                                        RECOMMENDED
                                      </span>
                                    )}
                                  </div>
                                  <span className="shrink-0 ml-2 text-[10px] font-semibold text-term-green opacity-80 group-hover:opacity-100">
                                    ⤓ select
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-term-border bg-term-panel/30 p-2.5 sm:p-3 text-[9px] sm:text-[10px] text-term-dim">
          <span className="truncate max-w-[65vw] sm:max-w-none">
            HARDWARE: {gpuActive ? "NVIDIA T4 (16GB)" : "CPU"} :: LLAMACPP
          </span>
          <button
            onClick={onClose}
            className="flex items-center gap-1 rounded border border-term-border px-2.5 py-1 text-term-dim hover:text-term-fg hover:border-term-green transition-colors"
          >
            <span>✕</span>
            <span>Close</span>
          </button>
        </div>
      </div>
    </div>
  );
}
