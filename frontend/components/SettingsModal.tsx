"use client";

import { useEffect, useRef, useState } from "react";
import { type UseKaggle } from "@/lib/useKaggle";
import { type UseBackend } from "@/lib/useBackend";
import { type Settings } from "@/lib/storage";
import { githubSync } from "@/lib/githubSync";
import { zipExporter } from "@/lib/zipExporter";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  kaggle: UseKaggle;
  backend: UseBackend;
  settings: Settings;
  onSettingsChange: (patch: Partial<Settings>) => void;
}

export function SettingsModal({
  isOpen,
  onClose,
  kaggle,
  backend,
  settings,
  onSettingsChange,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<"compute" | "git" | "keys" | "sampling">("compute");

  // Kaggle State
  const [kaggleUser, setKaggleUser] = useState(kaggle.username || "");
  const [kaggleKey, setKaggleKey] = useState("");
  const [kaggleGpu, setKaggleGpu] = useState(kaggle.accelerator || "gpu");
  const [kaggleNotice, setKaggleNotice] = useState<string | null>(null);

  // Hugging Face State
  const [hfToken, setHfToken] = useState("");
  const [hfNotice, setHfNotice] = useState<string | null>(null);

  // Git State
  const [githubToken, setGithubToken] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubBranch, setGithubBranch] = useState("main");
  const [gitSyncNotice, setGitSyncNotice] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const kaggleJsonInputRef = useRef<HTMLInputElement>(null);

  // Load persistent credentials on open
  useEffect(() => {
    if (typeof window !== "undefined") {
      setKaggleUser(localStorage.getItem("edgerunner.kaggle.username") || kaggle.username || "");
      setKaggleKey(localStorage.getItem("edgerunner.kaggle.key") || "");
      setHfToken(localStorage.getItem("edgerunner.hf.token") || "");
      setGithubToken(localStorage.getItem("edgerunner.git.token") || "");
      setGithubRepo(localStorage.getItem("edgerunner.git.repo") || "");
      setGithubBranch(localStorage.getItem("edgerunner.git.branch") || "main");
    }
  }, [isOpen, kaggle.username]);

  if (!isOpen) return null;

  async function handleSaveKaggle() {
    if (!kaggleUser.trim() || !kaggleKey.trim()) {
      setKaggleNotice("Please provide both username and key.");
      return;
    }
    await kaggle.saveCreds(kaggleUser.trim(), kaggleKey.trim(), hfToken.trim());
    localStorage.setItem("edgerunner.kaggle.username", kaggleUser.trim());
    localStorage.setItem("edgerunner.kaggle.key", kaggleKey.trim());
    setKaggleNotice("✓ Saved credentials! Ready to launch.");
    setTimeout(() => setKaggleNotice(null), 3000);
  }

  function handleKaggleJsonUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const text = ev.target?.result as string;
        const parsed = JSON.parse(text);
        if (parsed.username && parsed.key) {
          setKaggleUser(parsed.username);
          setKaggleKey(parsed.key);
          await kaggle.saveCreds(parsed.username, parsed.key, hfToken.trim());
          localStorage.setItem("edgerunner.kaggle.username", parsed.username);
          localStorage.setItem("edgerunner.kaggle.key", parsed.key);
          setKaggleNotice(`✓ Imported credentials for ${parsed.username}!`);
          setTimeout(() => setKaggleNotice(null), 3500);
        }
      } catch {
        setKaggleNotice("Failed to parse kaggle.json");
      }
    };
    reader.readAsText(file);
  }

  function handleSaveHfToken() {
    localStorage.setItem("edgerunner.hf.token", hfToken.trim());
    if (kaggle.saveCreds && kaggleUser && kaggleKey) {
      kaggle.saveCreds(kaggleUser, kaggleKey, hfToken.trim());
    }
    setHfNotice("✓ Hugging Face Token saved!");
    setTimeout(() => setHfNotice(null), 2500);
  }

  function handleSaveGit() {
    localStorage.setItem("edgerunner.git.token", githubToken.trim());
    localStorage.setItem("edgerunner.git.repo", githubRepo.trim());
    localStorage.setItem("edgerunner.git.branch", githubBranch.trim());
    setGitSyncNotice("✓ GitHub repository configuration saved!");
    setTimeout(() => setGitSyncNotice(null), 2500);
  }

  async function handlePush() {
    if (!githubToken.trim() || !githubRepo.trim()) {
      setGitSyncNotice("GitHub Token and Repo (owner/repo) are required to push.");
      return;
    }
    setIsSyncing(true);
    setGitSyncNotice("Pushing workspace to GitHub…");
    try {
      const res = await githubSync.push(
        {
          token: githubToken.trim(),
          repo: githubRepo.trim(),
          branch: githubBranch.trim() || "main",
        },
        (msg) => setGitSyncNotice(msg),
      );
      setGitSyncNotice(`✓ Pushed commit ${res.sha.slice(0, 7)} successfully!`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setGitSyncNotice(`Push error: ${msg}`);
    } finally {
      setIsSyncing(false);
    }
  }

  async function handlePull() {
    if (!githubRepo.trim()) {
      setGitSyncNotice("GitHub Repo (owner/repo) is required to pull.");
      return;
    }
    setIsSyncing(true);
    setGitSyncNotice("Pulling repository from GitHub…");
    try {
      const res = await githubSync.pull(
        {
          token: githubToken.trim(),
          repo: githubRepo.trim(),
          branch: githubBranch.trim() || "main",
        },
        (msg) => setGitSyncNotice(msg),
      );
      setGitSyncNotice(`✓ Successfully pulled ${res.filesCount} files from ${res.branch}!`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setGitSyncNotice(`Pull error: ${msg}`);
    } finally {
      setIsSyncing(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-term-border bg-term-bg shadow-2xl font-mono text-xs overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-term-border bg-term-panel px-4 py-2 shrink-0 select-none">
          <div className="flex items-center gap-2">
            <span className="text-sm">⚙</span>
            <span className="font-bold uppercase tracking-wider text-term-fg">SETTINGS & CONNECTIVITY</span>
          </div>

          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded border border-term-border text-term-dim hover:border-term-green hover:text-term-fg text-xs transition-colors"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center border-b border-term-border bg-term-panel/40 px-3 py-1.5 gap-2 select-none shrink-0 overflow-x-auto">
          <button
            onClick={() => setActiveTab("compute")}
            className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
              activeTab === "compute"
                ? "bg-term-green/15 text-term-green border border-term-green/40"
                : "text-term-dim hover:text-term-fg"
            }`}
          >
            ⚡ COMPUTE RIG
          </button>
          <button
            onClick={() => setActiveTab("git")}
            className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
              activeTab === "git"
                ? "bg-term-green/15 text-term-green border border-term-green/40"
                : "text-term-dim hover:text-term-fg"
            }`}
          >
            🌿 GIT & STORAGE
          </button>
          <button
            onClick={() => setActiveTab("keys")}
            className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
              activeTab === "keys"
                ? "bg-term-green/15 text-term-green border border-term-green/40"
                : "text-term-dim hover:text-term-fg"
            }`}
          >
            🔑 API KEYS
          </button>
          <button
            onClick={() => setActiveTab("sampling")}
            className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
              activeTab === "sampling"
                ? "bg-term-green/15 text-term-green border border-term-green/40"
                : "text-term-dim hover:text-term-fg"
            }`}
          >
            🎛️ SAMPLING & MODEL
          </button>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {/* TAB 1: COMPUTE RIG */}
          {activeTab === "compute" && (
            <div className="space-y-6">
              {/* Local Device Backend Status */}
              <div className="rounded-lg border border-term-border bg-term-panel/40 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${backend.isLocal ? "bg-term-green animate-pulse" : "bg-term-dim"}`} />
                    <span className="font-bold text-xs text-term-fg">LOCAL DEVICE BACKEND (127.0.0.1:8000)</span>
                  </div>
                  <span className="text-[10px] text-term-dim">AUTO-DETECTED</span>
                </div>
                <p className="text-[11px] text-term-dim leading-relaxed">
                  When you run EdgeRunner locally (<code className="text-term-green">uvicorn app.main:app</code>), it connects automatically and pauses any active cloud workers to save GPU quota.
                </p>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-term-dim">Status:</span>
                  <span className={backend.isLocal ? "text-term-green font-bold" : "text-term-dim font-medium"}>
                    {backend.isLocal ? "● ONLINE (Local Python Server)" : "○ Standalone Browser (WebAssembly / Cloud)"}
                  </span>
                </div>
              </div>

              {/* Kaggle 1-Click Cloud Compute */}
              <div className="rounded-lg border border-term-border bg-term-panel/40 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${kaggle.state === "online" ? "bg-term-green animate-pulse" : "bg-term-amber"}`} />
                    <span className="font-bold text-xs text-term-fg">KAGGLE 1-CLICK CLOUD RIG</span>
                  </div>
                  <span className="rounded bg-term-green/10 border border-term-green/30 px-1.5 py-0.5 text-[9px] text-term-green font-semibold">
                    30h/wk FREE T4 GPU
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="text-term-dim text-[10px] uppercase font-semibold block mb-1">Accelerator</label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => kaggle.setAccelerator("gpu")}
                        className={`flex-1 py-1 rounded border text-xs font-semibold ${
                          kaggle.accelerator === "gpu"
                            ? "border-term-green bg-term-green/15 text-term-green"
                            : "border-term-border text-term-dim"
                        }`}
                      >
                        ⚡ Nvidia T4 GPU
                      </button>
                      <button
                        onClick={() => kaggle.setAccelerator("cpu")}
                        className={`flex-1 py-1 rounded border text-xs font-semibold ${
                          kaggle.accelerator === "cpu"
                            ? "border-term-green bg-term-green/15 text-term-green"
                            : "border-term-border text-term-dim"
                        }`}
                      >
                        🖥 4-Core CPU
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-term-dim text-[10px] uppercase font-semibold block mb-1">Cloud Worker Control</label>
                    {kaggle.state === "online" ? (
                      <button
                        onClick={kaggle.stop}
                        className="w-full py-1 rounded border border-term-red/60 bg-term-red/10 text-term-red font-bold text-xs hover:bg-term-red/20 transition-colors"
                      >
                        ■ Stop Kaggle Worker
                      </button>
                    ) : kaggle.busy || kaggle.state === "packing" || kaggle.state === "pushing" || kaggle.state === "provisioning" ? (
                      <div className="flex items-center justify-center gap-2 py-1 text-term-amber font-bold text-xs animate-pulse">
                        <span>⚡</span>
                        <span>{kaggle.state.toUpperCase()}…</span>
                      </div>
                    ) : (
                      <button
                        onClick={kaggle.start}
                        className="w-full py-1 rounded border border-term-green/60 bg-term-green/15 text-term-green font-bold text-xs hover:bg-term-green/25 transition-colors"
                      >
                        🚀 1-Click Launch Kaggle Rig
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: GIT & CLOUD STORAGE */}
          {activeTab === "git" && (
            <div className="space-y-5">
              <div className="rounded-lg border border-term-border bg-term-panel/40 p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-term-fg">2-WAY GITHUB REPOSITORY SYNC</span>
                  <button
                    onClick={handleSaveGit}
                    className="rounded border border-term-green/60 bg-term-green/10 px-2 py-0.5 text-[10px] text-term-green font-semibold"
                  >
                    Save Config
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-term-dim text-[10px] uppercase block mb-1">Target Repository (owner/repo)</label>
                    <input
                      type="text"
                      placeholder="deveshpat/EdgeRunner"
                      value={githubRepo}
                      onChange={(e) => setGithubRepo(e.target.value)}
                      className="w-full rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg focus:border-term-green focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-term-dim text-[10px] uppercase block mb-1">Default Branch</label>
                    <input
                      type="text"
                      placeholder="main"
                      value={githubBranch}
                      onChange={(e) => setGithubBranch(e.target.value)}
                      className="w-full rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg focus:border-term-green focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-term-dim text-[10px] uppercase block mb-1">GitHub Personal Access Token (PAT)</label>
                  <input
                    type="password"
                    placeholder="ghp_xxxxxxxxxxxx"
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    className="w-full rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg focus:border-term-green focus:outline-none"
                  />
                </div>

                <div className="flex flex-wrap gap-2 pt-2 border-t border-term-border/60">
                  <button
                    onClick={handlePush}
                    disabled={isSyncing}
                    className="flex items-center gap-1 rounded border border-term-green/60 bg-term-green/15 px-3 py-1 text-xs font-bold text-term-green hover:bg-term-green/25 disabled:opacity-40 transition-colors"
                  >
                    <span>↑ Push to GitHub</span>
                  </button>
                  <button
                    onClick={handlePull}
                    disabled={isSyncing}
                    className="flex items-center gap-1 rounded border border-term-border bg-term-panel px-3 py-1 text-xs font-semibold text-term-dim hover:text-term-fg disabled:opacity-40 transition-colors"
                  >
                    <span>↓ Pull from GitHub</span>
                  </button>
                  <button
                    onClick={() => zipExporter.publishGist(githubToken, "EdgeRunner Workspace", false)}
                    className="flex items-center gap-1 rounded border border-term-border bg-term-panel px-3 py-1 text-xs font-semibold text-term-dim hover:text-term-fg transition-colors"
                  >
                    <span>🚀 Publish Gist</span>
                  </button>
                  <button
                    onClick={() => zipExporter.downloadZip()}
                    className="flex items-center gap-1 rounded border border-term-border bg-term-panel px-3 py-1 text-xs font-semibold text-term-dim hover:text-term-fg transition-colors ml-auto"
                  >
                    <span>📦 Download .ZIP</span>
                  </button>
                </div>

                {gitSyncNotice && (
                  <p className="text-[11px] text-term-green font-mono animate-pulse">{gitSyncNotice}</p>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: API KEYS */}
          {activeTab === "keys" && (
            <div className="space-y-5">
              {/* Kaggle Credentials */}
              <div className="rounded-lg border border-term-border bg-term-panel/40 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-term-fg">KAGGLE API CREDENTIALS</span>
                  <button
                    onClick={() => kaggleJsonInputRef.current?.click()}
                    className="rounded border border-term-border px-2 py-0.5 text-[10px] text-term-dim hover:text-term-green transition-colors"
                  >
                    ↑ Upload kaggle.json
                  </button>
                  <input
                    ref={kaggleJsonInputRef}
                    type="file"
                    accept=".json"
                    className="hidden"
                    onChange={handleKaggleJsonUpload}
                  />
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-term-dim text-[10px] uppercase block mb-1">Username</label>
                    <input
                      type="text"
                      placeholder="kaggle_username"
                      value={kaggleUser}
                      onChange={(e) => setKaggleUser(e.target.value)}
                      className="w-full rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg focus:border-term-green focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-term-dim text-[10px] uppercase block mb-1">API Key</label>
                    <input
                      type="password"
                      placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      value={kaggleKey}
                      onChange={(e) => setKaggleKey(e.target.value)}
                      className="w-full rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg focus:border-term-green focus:outline-none"
                    />
                  </div>
                </div>

                <button
                  onClick={handleSaveKaggle}
                  className="rounded border border-term-green/60 bg-term-green/15 px-3 py-1 text-xs font-bold text-term-green hover:bg-term-green/25 transition-colors"
                >
                  Save Kaggle Keys
                </button>
                {kaggleNotice && (
                  <p className="text-[11px] text-term-green font-mono">{kaggleNotice}</p>
                )}
              </div>

              {/* Hugging Face Token */}
              <div className="rounded-lg border border-term-border bg-term-panel/40 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-term-fg">HUGGING FACE USER ACCESS TOKEN</span>
                  <a
                    href="https://huggingface.co/settings/tokens"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-term-dim hover:text-term-green underline"
                  >
                    Get token ↗
                  </a>
                </div>
                <input
                  type="password"
                  placeholder="hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  value={hfToken}
                  onChange={(e) => setHfToken(e.target.value)}
                  className="w-full rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg focus:border-term-green focus:outline-none"
                />
                <button
                  onClick={handleSaveHfToken}
                  className="rounded border border-term-green/60 bg-term-green/15 px-3 py-1 text-xs font-bold text-term-green hover:bg-term-green/25 transition-colors"
                >
                  Save Hugging Face Token
                </button>
                {hfNotice && (
                  <p className="text-[11px] text-term-green font-mono">{hfNotice}</p>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: SAMPLING & INFERENCE */}
          {activeTab === "sampling" && (
            <div className="rounded-lg border border-term-border bg-term-panel/40 p-4 space-y-4">
              <span className="font-bold text-xs text-term-fg block">MODEL SAMPLING PARAMETERS</span>

              <label className="flex items-center gap-3 text-xs">
                <span className="w-28 text-term-dim uppercase tracking-wider">Temperature</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={settings.temperature}
                  onChange={(e) => onSettingsChange({ temperature: Number(e.target.value) })}
                  className="er-slider flex-1"
                />
                <span className="w-14 text-right text-term-fg tabular-nums font-semibold">
                  {settings.temperature.toFixed(2)}
                </span>
              </label>

              <label className="flex items-center gap-3 text-xs">
                <span className="w-28 text-term-dim uppercase tracking-wider">Top-P</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={settings.topP}
                  onChange={(e) => onSettingsChange({ topP: Number(e.target.value) })}
                  className="er-slider flex-1"
                />
                <span className="w-14 text-right text-term-fg tabular-nums font-semibold">
                  {settings.topP.toFixed(2)}
                </span>
              </label>

              <label className="flex items-center gap-3 text-xs">
                <span className="w-28 text-term-dim uppercase tracking-wider">Max Output</span>
                <input
                  type="range"
                  min={64}
                  max={8192}
                  step={64}
                  value={settings.maxTokens}
                  onChange={(e) => onSettingsChange({ maxTokens: Number(e.target.value) })}
                  className="er-slider flex-1"
                />
                <span className="w-14 text-right text-term-fg tabular-nums font-semibold">
                  {settings.maxTokens} tok
                </span>
              </label>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
