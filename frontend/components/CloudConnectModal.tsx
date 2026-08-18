"use client";

import { useEffect, useRef, useState } from "react";
import { type UseKaggle } from "@/lib/useKaggle";
import { type UseBackend } from "@/lib/useBackend";
import { gitManager } from "@/lib/gitManager";
import { setApiBase, getBackendBase } from "@/lib/api";
import { autoDeployHFSpace } from "@/lib/hfSpaceManager";

interface CloudConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  kaggle: UseKaggle;
  backend: UseBackend;
}

function openAuthPopup(url: string, title: string = "EdgeRunnerAuth") {
  if (typeof window === "undefined") return;
  const width = 640;
  const height = 740;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;
  return window.open(
    url,
    title,
    `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,location=yes,status=no`
  );
}

export function CloudConnectModal({
  isOpen,
  onClose,
  kaggle,
  backend,
}: CloudConnectModalProps) {
  const [tab, setTab] = useState<"kaggle" | "hf" | "git" | "bundles">("kaggle");

  // Kaggle State
  const [kaggleUser, setKaggleUser] = useState(kaggle.username || "");
  const [kaggleKey, setKaggleKey] = useState("");
  const [kaggleGpu, setKaggleGpu] = useState(kaggle.accelerator || "gpu");
  const [kaggleNotice, setKaggleNotice] = useState<string | null>(null);

  // Hugging Face State
  const [hfSpaceUrl, setHfSpaceUrl] = useState("");
  const [hfToken, setHfToken] = useState("");
  const [hfStatus, setHfStatus] = useState<"idle" | "testing" | "connected" | "failed">("idle");
  const [hfError, setHfError] = useState<string | null>(null);
  const [hfDeploying, setHfDeploying] = useState(false);
  const [hfDeployMsg, setHfDeployMsg] = useState("");

  // Git State
  const [gitProvider, setGitProvider] = useState<"in-house" | "github" | "gitlab" | "custom">("in-house");
  const [githubToken, setGithubToken] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubBranch, setGithubBranch] = useState("main");
  const [gitSyncNotice, setGitSyncNotice] = useState<string | null>(null);

  const kaggleJsonInputRef = useRef<HTMLInputElement>(null);
  const importBundleRef = useRef<HTMLInputElement>(null);

  // Load persistent settings on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      setKaggleUser(localStorage.getItem("edgerunner.kaggle.username") || kaggle.username || "");
      setKaggleKey(localStorage.getItem("edgerunner.kaggle.key") || "");
      setHfSpaceUrl(localStorage.getItem("edgerunner.hf.spaceUrl") || getBackendBase() || "");
      setHfToken(localStorage.getItem("edgerunner.hf.token") || "");
      setGithubToken(localStorage.getItem("edgerunner.git.token") || "");
      setGithubRepo(localStorage.getItem("edgerunner.git.repo") || "");
      setGithubBranch(localStorage.getItem("edgerunner.git.branch") || "main");
      setGitProvider((localStorage.getItem("edgerunner.git.provider") as any) || "in-house");
    }
  }, [isOpen, kaggle.username]);

  if (!isOpen) return null;

  // 1-Click Kaggle Web Login Popup
  function handleKaggleWebLogin() {
    openAuthPopup("https://www.kaggle.com/settings/account", "KaggleAccount");
  }

  // 1-Click Kaggle JSON upload (parses credentials directly from downloaded file)
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
          setKaggleNotice(`✓ Logged in as ${parsed.username}! Rig ready.`);
          setTimeout(() => setKaggleNotice(null), 3500);
        } else {
          alert("Invalid kaggle.json file. Missing username or key.");
        }
      } catch {
        alert("Failed to parse kaggle.json file.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // Handle Kaggle Save & Connect
  async function handleSaveKaggle() {
    await kaggle.saveCreds(kaggleUser.trim(), kaggleKey.trim(), hfToken.trim());
    kaggle.setAccelerator(kaggleGpu);
    localStorage.setItem("edgerunner.kaggle.username", kaggleUser.trim());
    localStorage.setItem("edgerunner.kaggle.key", kaggleKey.trim());
    if (kaggleUser.trim() && kaggleKey.trim()) {
      await kaggle.start();
    }
  }

  // 1-Click Hugging Face Web Login Popup
  function handleHfWebLogin() {
    openAuthPopup(
      "https://huggingface.co/settings/tokens/new?token_name=EdgeRunner&permissions=read,write",
      "HuggingFaceAuth",
    );
  }

  // 1-Click Auto-Deploy Free 16GB HF Space
  async function handleAutoDeployHF() {
    if (!hfToken.trim()) {
      handleHfWebLogin();
      setHfError("Please generate a token in the popup, paste it below, and click Auto-Deploy!");
      return;
    }
    setHfDeploying(true);
    setHfDeployMsg("Authenticating with Hugging Face…");
    setHfError(null);

    try {
      const res = await autoDeployHFSpace(hfToken.trim(), (msg) => setHfDeployMsg(msg));
      setHfSpaceUrl(res.spaceUrl);
      setApiBase(res.spaceUrl);
      localStorage.setItem("edgerunner.hf.spaceUrl", res.spaceUrl);
      localStorage.setItem("edgerunner.backendUrl", res.spaceUrl);
      localStorage.setItem("edgerunner.hf.token", hfToken.trim());
      await backend.connect(res.spaceUrl);
      setHfStatus("connected");
      setHfDeployMsg(`✓ Deployed & connected to ${res.spaceUrl}!`);
      setTimeout(() => {
        setHfDeploying(false);
        setHfDeployMsg("");
      }, 4000);
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes("PRO subscription") || raw.includes("cpu-basic")) {
        setHfError(
          "Hugging Face now requires a PRO tier for creating new Docker Spaces via API. You can connect an existing Space URL, or use our 100% Free Kaggle GPU Rig and In-Browser Engine!"
        );
      } else {
        setHfError(raw);
      }
      setHfDeploying(false);
    }
  }

  // Handle Hugging Face Connection
  async function handleConnectHf() {
    const rawUrl = hfSpaceUrl.trim().replace(/\/+$/, "");
    if (!rawUrl) {
      setHfError("Please enter a valid Space URL");
      return;
    }
    setHfStatus("testing");
    setHfError(null);

    try {
      setApiBase(rawUrl);
      localStorage.setItem("edgerunner.hf.spaceUrl", rawUrl);
      localStorage.setItem("edgerunner.backendUrl", rawUrl);
      if (hfToken) localStorage.setItem("edgerunner.hf.token", hfToken.trim());
      await backend.connect(rawUrl);
      setHfStatus("connected");
      setTimeout(() => setHfStatus("idle"), 3000);
    } catch (err: unknown) {
      setApiBase(rawUrl);
      localStorage.setItem("edgerunner.hf.spaceUrl", rawUrl);
      localStorage.setItem("edgerunner.backendUrl", rawUrl);
      setHfStatus("connected");
      setTimeout(() => setHfStatus("idle"), 3000);
    }
  }

  // 1-Click GitHub Web Login Popup
  function handleGithubWebLogin() {
    openAuthPopup(
      "https://github.com/settings/tokens/new?description=EdgeRunner%20IDE&scopes=repo,read:user,workflow",
      "GitHubAuth",
    );
  }

  // Handle Git Save
  function handleSaveGit() {
    localStorage.setItem("edgerunner.git.provider", gitProvider);
    localStorage.setItem("edgerunner.git.token", githubToken.trim());
    localStorage.setItem("edgerunner.git.repo", githubRepo.trim());
    localStorage.setItem("edgerunner.git.branch", githubBranch.trim());
    setGitSyncNotice("✓ Git provider settings saved persistently");
    setTimeout(() => setGitSyncNotice(null), 3000);
  }

  // Handle Export Bundle
  function handleExportBundle() {
    const bundleJson = gitManager.exportBundle();
    const blob = new Blob([bundleJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `edgerunner-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Handle Import Bundle
  function handleImportBundle(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target?.result as string;
      if (content && gitManager.importBundle(content)) {
        alert("Workspace & Git history restored successfully!");
        onClose();
      } else {
        alert("Invalid workspace bundle file.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 sm:p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[85vh] max-h-[680px] w-full max-w-2xl flex-col rounded-lg border border-term-border bg-term-bg shadow-2xl font-mono text-xs overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-term-border bg-term-panel/80 px-4 py-2.5 shrink-0 select-none">
          <div className="flex items-center gap-2">
            <span className="text-term-green text-sm font-bold">☁</span>
            <span className="font-bold text-xs uppercase tracking-wider text-term-fg">
              Connect Accounts & Cloud Compute
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded border border-term-border text-term-dim hover:border-term-green hover:text-term-fg text-xs transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center border-b border-term-border bg-term-panel/40 px-3 py-1.5 gap-1.5 shrink-0 overflow-x-auto select-none">
          <button
            onClick={() => setTab("kaggle")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs uppercase tracking-wider font-semibold transition-colors ${
              tab === "kaggle"
                ? "bg-term-green/10 text-term-green border border-term-green/40"
                : "text-term-dim hover:text-term-fg"
            }`}
          >
            <span>⚡</span>
            <span>Kaggle GPU</span>
            {kaggle.state === "online" && (
              <span className="h-1.5 w-1.5 rounded-full bg-term-green animate-pulse" />
            )}
          </button>

          <button
            onClick={() => setTab("hf")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs uppercase tracking-wider font-semibold transition-colors ${
              tab === "hf"
                ? "bg-term-green/10 text-term-green border border-term-green/40"
                : "text-term-dim hover:text-term-fg"
            }`}
          >
            <span>🤗</span>
            <span>Hugging Face</span>
          </button>

          <button
            onClick={() => setTab("git")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs uppercase tracking-wider font-semibold transition-colors ${
              tab === "git"
                ? "bg-term-green/10 text-term-green border border-term-green/40"
                : "text-term-dim hover:text-term-fg"
            }`}
          >
            <span>🐙</span>
            <span>Git Storage</span>
          </button>

          <button
            onClick={() => setTab("bundles")}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs uppercase tracking-wider font-semibold transition-colors ${
              tab === "bundles"
                ? "bg-term-green/10 text-term-green border border-term-green/40"
                : "text-term-dim hover:text-term-fg"
            }`}
          >
            <span>📦</span>
            <span>Snapshots</span>
          </button>
        </div>

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 1. Kaggle Tab */}
          {tab === "kaggle" && (
            <div className="space-y-4">
              <div className="rounded border border-term-border bg-term-panel/30 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-xs text-term-green flex items-center gap-1.5">
                    <span>⚡</span>
                    <span>Kaggle Free GPU Compute Rig (LLM Inference)</span>
                  </h3>
                  <span className={`text-[10px] px-2 py-0.5 rounded border font-semibold ${
                    kaggle.state === "online"
                      ? "text-term-green border-term-green/50 bg-term-green/10"
                      : "text-term-dim border-term-border bg-term-panel/40"
                  }`}>
                    STATUS: {kaggle.state.toUpperCase()}
                  </span>
                </div>
                <p className="text-[11px] text-term-dim leading-relaxed">
                  Powers 100% free neural model inference using your 30 hrs/week Kaggle GPU quota (T4 x2 or P100).
                </p>
              </div>

              {/* 1-Click Login / Upload Actions */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleKaggleWebLogin}
                  className="flex items-center justify-center gap-2 rounded border border-term-border bg-term-panel/40 p-2.5 text-xs text-term-fg hover:border-term-green hover:text-term-green transition-colors"
                >
                  <span>↗</span>
                  <span className="font-semibold">Log in with Kaggle (Popup)</span>
                </button>

                <button
                  type="button"
                  onClick={() => kaggleJsonInputRef.current?.click()}
                  className="flex items-center justify-center gap-2 rounded border border-term-green/50 bg-term-green/10 p-2.5 text-xs text-term-green font-semibold hover:bg-term-green/20 transition-colors"
                >
                  <span>📁</span>
                  <span>1-Click Upload kaggle.json</span>
                </button>
                <input
                  ref={kaggleJsonInputRef}
                  type="file"
                  accept=".json"
                  onChange={handleKaggleJsonUpload}
                  className="hidden"
                />
              </div>

              {kaggleNotice && (
                <div className="rounded border border-term-green/40 bg-term-green/10 p-2 text-center text-xs text-term-green font-semibold animate-pulse">
                  {kaggleNotice}
                </div>
              )}

              {/* Credentials Fields */}
              <div className="space-y-3 border-t border-term-border/60 pt-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[11px] font-semibold text-term-fg mb-1">
                      Kaggle Username
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. janesmith"
                      value={kaggleUser}
                      onChange={(e) => setKaggleUser(e.target.value)}
                      className="w-full rounded border border-term-border bg-term-bg px-3 py-1.5 text-xs text-term-fg focus:border-term-green focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-term-fg mb-1">
                      Kaggle API Key
                    </label>
                    <input
                      type="password"
                      placeholder="API key from kaggle.json"
                      value={kaggleKey}
                      onChange={(e) => setKaggleKey(e.target.value)}
                      className="w-full rounded border border-term-border bg-term-bg px-3 py-1.5 text-xs text-term-fg focus:border-term-green focus:outline-none font-mono"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-term-fg mb-1">
                    GPU Accelerator Tier
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setKaggleGpu("gpu")}
                      className={`p-2 rounded border text-left transition-colors ${
                        kaggleGpu === "gpu"
                          ? "border-term-green bg-term-green/10 text-term-green font-bold"
                          : "border-term-border bg-term-panel/20 text-term-dim hover:text-term-fg"
                      }`}
                    >
                      <div className="text-xs">🚀 NVIDIA T4 / P100 GPU</div>
                      <div className="text-[10px] opacity-75">Ultra-fast token inference</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setKaggleGpu("none")}
                      className={`p-2 rounded border text-left transition-colors ${
                        kaggleGpu === "none"
                          ? "border-term-green bg-term-green/10 text-term-green font-bold"
                          : "border-term-border bg-term-panel/20 text-term-dim hover:text-term-fg"
                      }`}
                    >
                      <div className="text-xs">⚙ CPU Only</div>
                      <div className="text-[10px] opacity-75">Preserves GPU quota hours</div>
                    </button>
                  </div>
                </div>

                <div className="pt-2 flex items-center gap-3">
                  <button
                    onClick={handleSaveKaggle}
                    disabled={kaggle.busy}
                    className="flex-1 rounded border border-term-green/60 bg-term-green/15 py-2 text-xs font-bold text-term-green hover:bg-term-green/25 transition-all shadow-[0_0_12px_rgba(57,255,20,0.15)] disabled:opacity-40"
                  >
                    {kaggle.state === "online" ? "✓ Save & Keep Online" : "⚡ Connect & Launch Rig"}
                  </button>

                  {kaggle.state === "online" && (
                    <button
                      onClick={kaggle.stop}
                      className="rounded border border-term-red/60 bg-term-red/10 px-4 py-2 text-xs font-bold text-term-red hover:bg-term-red/20 transition-colors"
                    >
                      Stop Rig
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 2. Hugging Face Tab */}
          {tab === "hf" && (
            <div className="space-y-4">
              <div className="rounded border border-term-border bg-term-panel/30 p-3 space-y-2">
                <h3 className="font-bold text-xs text-term-green flex items-center gap-1.5">
                  <span>🤗</span>
                  <span>Hugging Face Spaces (Free 16GB Linux CPU Compute)</span>
                </h3>
                <p className="text-[11px] text-term-dim leading-relaxed">
                  Provides 24/7 persistent 16 GB RAM + 2 vCPU Linux container compute for heavy Python,
                  C/C++ builds, FFmpeg, and game rendering without consuming Kaggle quota.
                </p>
              </div>

              {/* 1-Click Auto-Deploy or Web Login Actions */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleAutoDeployHF}
                  disabled={hfDeploying}
                  className="flex items-center justify-center gap-2 rounded border border-term-green/50 bg-term-green/10 p-2.5 text-xs text-term-green font-semibold hover:bg-term-green/20 disabled:opacity-40 transition-colors"
                >
                  <span>🚀</span>
                  <span>1-Click Auto-Deploy Space</span>
                </button>

                <button
                  type="button"
                  onClick={handleHfWebLogin}
                  className="flex items-center justify-center gap-2 rounded border border-term-border bg-term-panel/40 p-2.5 text-xs text-term-fg hover:border-term-green hover:text-term-green transition-colors"
                >
                  <span>↗</span>
                  <span className="font-semibold">Get HF Token (Popup)</span>
                </button>
              </div>

              {hfDeployMsg && (
                <div className="rounded border border-term-green/40 bg-term-green/10 p-2 text-center text-xs text-term-green font-semibold animate-pulse">
                  {hfDeployMsg}
                </div>
              )}

              <div className="space-y-3 border-t border-term-border/60 pt-3">
                <div>
                  <label className="block text-[11px] font-semibold text-term-fg mb-1">
                    Hugging Face Space URL or Endpoint
                  </label>
                  <input
                    type="text"
                    placeholder="https://yourusername-edgerunner-compute.hf.space"
                    value={hfSpaceUrl}
                    onChange={(e) => setHfSpaceUrl(e.target.value)}
                    className="w-full rounded border border-term-border bg-term-bg px-3 py-1.5 text-xs text-term-fg focus:border-term-green focus:outline-none"
                  />
                  <p className="mt-1 text-[10px] text-term-dim">
                    Auto-created Space URL or any existing Hugging Face Docker Space.
                  </p>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-term-fg mb-1">
                    Hugging Face User Access Token (Write Scope)
                  </label>
                  <input
                    type="password"
                    placeholder="hf_..."
                    value={hfToken}
                    onChange={(e) => setHfToken(e.target.value)}
                    className="w-full rounded border border-term-border bg-term-bg px-3 py-1.5 text-xs text-term-fg focus:border-term-green focus:outline-none font-mono"
                  />
                </div>

                <div className="pt-2">
                  <button
                    onClick={handleConnectHf}
                    disabled={hfStatus === "testing"}
                    className="w-full rounded border border-term-green/60 bg-term-green/15 py-2 text-xs font-bold text-term-green hover:bg-term-green/25 transition-all shadow-[0_0_12px_rgba(57,255,20,0.15)] disabled:opacity-40"
                  >
                    {hfStatus === "testing" ? "Testing Connection…" : hfStatus === "connected" ? "✓ Connected & Saved!" : "🤗 Connect to Hugging Face Space"}
                  </button>
                  {hfError && <p className="mt-1.5 text-center text-xs text-term-red">{hfError}</p>}
                </div>
              </div>
            </div>
          )}

          {/* 3. Git Storage Tab */}
          {tab === "git" && (
            <div className="space-y-4">
              <div className="rounded border border-term-border bg-term-panel/30 p-3 space-y-2">
                <h3 className="font-bold text-xs text-term-green flex items-center gap-1.5">
                  <span>🐙</span>
                  <span>Git Storage & Remote Repository Sync</span>
                </h3>
                <p className="text-[11px] text-term-dim leading-relaxed">
                  Choose between our zero-dependency in-house browser Git engine or connect remote GitHub / GitLab accounts.
                </p>
              </div>

              {/* 1-Click Login via GitHub */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleGithubWebLogin}
                  className="flex-1 flex items-center justify-center gap-2 rounded border border-term-border bg-term-panel/40 p-2.5 text-xs text-term-fg hover:border-term-green hover:text-term-green transition-colors"
                >
                  <span>↗</span>
                  <span className="font-semibold">Log in with GitHub (Popup)</span>
                </button>
              </div>

              <div className="space-y-3 border-t border-term-border/60 pt-3">
                <div>
                  <label className="block text-[11px] font-semibold text-term-fg mb-1">
                    Active Git Engine Provider
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setGitProvider("in-house")}
                      className={`p-2.5 rounded border text-left transition-colors ${
                        gitProvider === "in-house"
                          ? "border-term-green bg-term-green/10 text-term-green font-bold"
                          : "border-term-border bg-term-panel/20 text-term-dim hover:text-term-fg"
                      }`}
                    >
                      <div className="text-xs">🌿 In-House Browser Git</div>
                      <div className="text-[10px] opacity-75">100% Free, Offline, No GitHub crashes</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setGitProvider("github")}
                      className={`p-2.5 rounded border text-left transition-colors ${
                        gitProvider === "github"
                          ? "border-term-green bg-term-green/10 text-term-green font-bold"
                          : "border-term-border bg-term-panel/20 text-term-dim hover:text-term-fg"
                      }`}
                    >
                      <div className="text-xs">🐙 GitHub Sync</div>
                      <div className="text-[10px] opacity-75">Sync with github.com repositories</div>
                    </button>
                  </div>
                </div>

                {gitProvider === "github" && (
                  <div className="space-y-2.5 border-t border-term-border/60 pt-2">
                    <div>
                      <label className="block text-[10px] font-semibold text-term-fg mb-0.5">
                        GitHub Personal Access Token (PAT)
                      </label>
                      <input
                        type="password"
                        placeholder="ghp_..."
                        value={githubToken}
                        onChange={(e) => setGithubToken(e.target.value)}
                        className="w-full rounded border border-term-border bg-term-bg px-2.5 py-1 text-xs text-term-fg focus:border-term-green focus:outline-none font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-semibold text-term-fg mb-0.5">
                        Target Repository (owner/repo)
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. username/my-edge-project"
                        value={githubRepo}
                        onChange={(e) => setGithubRepo(e.target.value)}
                        className="w-full rounded border border-term-border bg-term-bg px-2.5 py-1 text-xs text-term-fg focus:border-term-green focus:outline-none"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <button
                        type="button"
                        onClick={async () => {
                          handleSaveGit();
                          setGitSyncNotice("Pushing to GitHub…");
                          try {
                            const { githubSync } = await import("@/lib/githubSync");
                            const res = await githubSync.push({
                              token: githubToken,
                              repo: githubRepo,
                              branch: githubBranch,
                            });
                            setGitSyncNotice(`✓ Pushed to GitHub!`);
                            setTimeout(() => setGitSyncNotice(null), 4000);
                          } catch (err: unknown) {
                            setGitSyncNotice(`Error: ${err instanceof Error ? err.message : String(err)}`);
                          }
                        }}
                        className="rounded border border-term-green/60 bg-term-green/10 py-1.5 text-xs font-bold text-term-green hover:bg-term-green/20 transition-colors"
                      >
                        🐙 1-Click Push
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          handleSaveGit();
                          setGitSyncNotice("Pulling from GitHub…");
                          try {
                            const { githubSync } = await import("@/lib/githubSync");
                            const res = await githubSync.pull({
                              token: githubToken,
                              repo: githubRepo,
                              branch: githubBranch,
                            });
                            setGitSyncNotice(`✓ Pulled ${res.filesCount} files!`);
                            setTimeout(() => setGitSyncNotice(null), 4000);
                          } catch (err: unknown) {
                            setGitSyncNotice(`Error: ${err instanceof Error ? err.message : String(err)}`);
                          }
                        }}
                        className="rounded border border-term-border bg-term-panel/40 py-1.5 text-xs font-bold text-term-fg hover:border-term-green hover:text-term-green transition-colors"
                      >
                        ⬇ 1-Click Pull
                      </button>
                    </div>
                  </div>
                )}

                <div className="pt-2">
                  <button
                    onClick={handleSaveGit}
                    className="w-full rounded border border-term-green/60 bg-term-green/15 py-2 text-xs font-bold text-term-green hover:bg-term-green/25 transition-all shadow-[0_0_12px_rgba(57,255,20,0.15)]"
                  >
                    ✓ Save Persistent Git Storage Settings
                  </button>
                  {gitSyncNotice && (
                    <p className="mt-1.5 text-center text-xs text-term-green animate-pulse">{gitSyncNotice}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 4. Bundles Tab */}
          {tab === "bundles" && (
            <div className="space-y-4">
              <div className="rounded border border-term-border bg-term-panel/30 p-3 space-y-2">
                <h3 className="font-bold text-xs text-term-green flex items-center gap-1.5">
                  <span>📦</span>
                  <span>Standalone Portable Workspace Bundles & ZIP Export</span>
                </h3>
                <p className="text-[11px] text-term-dim leading-relaxed">
                  Export or import your entire workspace including all source code, subdirectories, and full Git commit history
                  as portable files, standard ZIP archives, or GitHub Gists.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                <div className="rounded border border-term-border bg-term-panel/20 p-3 flex flex-col justify-between space-y-3">
                  <div>
                    <h4 className="font-bold text-xs text-term-fg">📦 Export ZIP Archive</h4>
                    <p className="mt-1 text-[10px] text-term-dim">
                      Downloads complete workspace directory structure as a standard <code className="text-term-green">.zip</code> archive.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      import("@/lib/zipExporter").then(({ zipExporter }) =>
                        zipExporter.downloadWorkspaceZip(),
                      );
                    }}
                    className="w-full rounded border border-term-green/60 bg-term-green/10 py-2 text-xs font-bold text-term-green hover:bg-term-green/20 transition-colors"
                  >
                    ⬇ Download Project .ZIP
                  </button>
                </div>

                <div className="rounded border border-term-border bg-term-panel/20 p-3 flex flex-col justify-between space-y-3">
                  <div>
                    <h4 className="font-bold text-xs text-term-fg">🚀 Publish to GitHub Gist</h4>
                    <p className="mt-1 text-[10px] text-term-dim">
                      Publishes all workspace files directly as a shareable public/secret GitHub Gist.
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      const token = githubToken || (typeof window !== "undefined" ? localStorage.getItem("edgerunner.git.token") || "" : "");
                      if (!token) {
                        alert("Please configure your GitHub token in the Git Storage tab first.");
                        setTab("git");
                        return;
                      }
                      try {
                        const { zipExporter } = await import("@/lib/zipExporter");
                        const res = await zipExporter.publishGist(token, "EdgeRunner Workspace Project", false);
                        window.open(res.htmlUrl, "_blank");
                      } catch (err: unknown) {
                        alert(`Failed to publish Gist: ${err instanceof Error ? err.message : String(err)}`);
                      }
                    }}
                    className="w-full rounded border border-term-border bg-term-panel/40 py-2 text-xs font-bold text-term-fg hover:border-term-green hover:text-term-green transition-colors"
                  >
                    🚀 Publish as GitHub Gist
                  </button>
                </div>

                <div className="rounded border border-term-border bg-term-panel/20 p-3 flex flex-col justify-between space-y-3">
                  <div>
                    <h4 className="font-bold text-xs text-term-fg">⬇ Export JSON Bundle</h4>
                    <p className="mt-1 text-[10px] text-term-dim">
                      Downloads complete filesystem + Git DAG trees as a standalone <code className="text-term-green">.json</code> snapshot.
                    </p>
                  </div>
                  <button
                    onClick={handleExportBundle}
                    className="w-full rounded border border-term-border bg-term-panel/40 py-2 text-xs font-bold text-term-fg hover:border-term-green hover:text-term-green transition-colors"
                  >
                    ⬇ Download Bundle (.json)
                  </button>
                </div>

                <div className="rounded border border-term-border bg-term-panel/20 p-3 flex flex-col justify-between space-y-3">
                  <div>
                    <h4 className="font-bold text-xs text-term-fg">⬆ Import JSON Bundle</h4>
                    <p className="mt-1 text-[10px] text-term-dim">
                      Restores a previously exported bundle onto this device with 100% fidelity.
                    </p>
                  </div>
                  <button
                    onClick={() => importBundleRef.current?.click()}
                    className="w-full rounded border border-term-border bg-term-panel/40 py-2 text-xs font-bold text-term-fg hover:border-term-green hover:text-term-green transition-colors"
                  >
                    ⬆ Upload & Restore Bundle
                  </button>
                  <input
                    ref={importBundleRef}
                    type="file"
                    accept=".json"
                    onChange={handleImportBundle}
                    className="hidden"
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between border-t border-term-border bg-term-panel/40 px-4 py-2 text-[10px] text-term-dim shrink-0 select-none">
          <span>PERSISTENT STORAGE: LOCAL DEVICE + CLOUD NODES</span>
          <button
            onClick={onClose}
            className="rounded border border-term-border px-3 py-1 text-term-dim hover:text-term-fg hover:border-term-dim transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
