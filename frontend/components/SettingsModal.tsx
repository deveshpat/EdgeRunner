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
  const [activeTab, setActiveTab] = useState<"keys" | "sampling">("keys");

  // Kaggle State
  const [kaggleUser, setKaggleUser] = useState(kaggle.username || "");
  const [kaggleKey, setKaggleKey] = useState("");
  const [kaggleNotice, setKaggleNotice] = useState<string | null>(null);

  // Hugging Face State
  const [hfToken, setHfToken] = useState("");
  const [hfNotice, setHfNotice] = useState<string | null>(null);

  // Git State
  const [githubToken, setGithubToken] = useState("");
  const [gitNotice, setGitNotice] = useState<string | null>(null);

  const kaggleJsonInputRef = useRef<HTMLInputElement>(null);

  // Load persistent credentials on open
  useEffect(() => {
    if (typeof window !== "undefined") {
      setKaggleUser(localStorage.getItem("edgerunner.kaggle.username") || kaggle.username || "");
      setKaggleKey(localStorage.getItem("edgerunner.kaggle.key") || "");
      setHfToken(localStorage.getItem("edgerunner.hf.token") || "");
      setGithubToken(localStorage.getItem("edgerunner.git.token") || "");
    }
  }, [isOpen, kaggle.username]);

  if (!isOpen) return null;

  async function handleUpdateKaggle() {
    if (!kaggleUser.trim() || !kaggleKey.trim()) {
      setKaggleNotice("Please provide both username and key.");
      return;
    }
    await kaggle.saveCreds(kaggleUser.trim(), kaggleKey.trim(), hfToken.trim());
    localStorage.setItem("edgerunner.kaggle.username", kaggleUser.trim());
    localStorage.setItem("edgerunner.kaggle.key", kaggleKey.trim());
    setKaggleNotice("✓ Updated Kaggle credentials!");
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
          setKaggleNotice(`✓ Imported and updated credentials for ${parsed.username}!`);
          setTimeout(() => setKaggleNotice(null), 3500);
        }
      } catch {
        setKaggleNotice("Failed to parse kaggle.json");
      }
    };
    reader.readAsText(file);
  }

  function handleUpdateHfToken() {
    localStorage.setItem("edgerunner.hf.token", hfToken.trim());
    if (kaggle.saveCreds && kaggleUser && kaggleKey) {
      kaggle.saveCreds(kaggleUser, kaggleKey, hfToken.trim());
    }
    setHfNotice("✓ Updated Hugging Face Token!");
    setTimeout(() => setHfNotice(null), 2500);
  }

  function handleUpdateGithubToken() {
    localStorage.setItem("edgerunner.git.token", githubToken.trim());
    setGitNotice("✓ Updated GitHub Personal Access Token!");
    setTimeout(() => setGitNotice(null), 2500);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex h-[75vh] max-h-[640px] w-full max-w-2xl flex-col rounded-lg border border-term-border bg-term-bg shadow-2xl font-mono text-xs overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-term-border bg-term-panel px-4 py-2 shrink-0 select-none">
          <div className="flex items-center gap-2">
            <span className="text-sm">⚙</span>
            <span className="font-bold uppercase tracking-wider text-term-fg">SETTINGS</span>
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
        <div className="flex items-center border-b border-term-border bg-term-panel/40 px-3 py-1.5 gap-2 select-none shrink-0">
          <button
            onClick={() => setActiveTab("keys")}
            className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
              activeTab === "keys"
                ? "bg-term-green/15 text-term-green border border-term-green/40"
                : "text-term-dim hover:text-term-fg"
            }`}
          >
            🔑 API KEYS & CREDENTIALS
          </button>
          <button
            onClick={() => setActiveTab("sampling")}
            className={`px-2.5 py-1 rounded text-[11px] font-bold transition-colors ${
              activeTab === "sampling"
                ? "bg-term-green/15 text-term-green border border-term-green/40"
                : "text-term-dim hover:text-term-fg"
            }`}
          >
            🎛️ SAMPLING & PARAMETERS
          </button>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
          {/* TAB 1: API KEYS */}
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

                <div className="flex items-center justify-between pt-1">
                  <button
                    onClick={handleUpdateKaggle}
                    className="rounded border border-term-green/60 bg-term-green/15 px-3 py-1 text-xs font-bold text-term-green hover:bg-term-green/25 transition-colors"
                  >
                    Update Kaggle API
                  </button>
                  {kaggleNotice && (
                    <span className="text-[11px] text-term-green font-mono">{kaggleNotice}</span>
                  )}
                </div>
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
                <div className="flex items-center justify-between pt-1">
                  <button
                    onClick={handleUpdateHfToken}
                    className="rounded border border-term-green/60 bg-term-green/15 px-3 py-1 text-xs font-bold text-term-green hover:bg-term-green/25 transition-colors"
                  >
                    Update HF Token
                  </button>
                  {hfNotice && (
                    <span className="text-[11px] text-term-green font-mono">{hfNotice}</span>
                  )}
                </div>
              </div>

              {/* GitHub Personal Access Token */}
              <div className="rounded-lg border border-term-border bg-term-panel/40 p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-term-fg">GITHUB PERSONAL ACCESS TOKEN (PAT)</span>
                  <a
                    href="https://github.com/settings/tokens"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[10px] text-term-dim hover:text-term-green underline"
                  >
                    Generate token ↗
                  </a>
                </div>
                <input
                  type="password"
                  placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  value={githubToken}
                  onChange={(e) => setGithubToken(e.target.value)}
                  className="w-full rounded border border-term-border bg-term-bg px-2 py-1 text-xs text-term-fg focus:border-term-green focus:outline-none"
                />
                <div className="flex items-center justify-between pt-1">
                  <button
                    onClick={handleUpdateGithubToken}
                    className="rounded border border-term-green/60 bg-term-green/15 px-3 py-1 text-xs font-bold text-term-green hover:bg-term-green/25 transition-colors"
                  >
                    Update GitHub Token
                  </button>
                  {gitNotice && (
                    <span className="text-[11px] text-term-green font-mono">{gitNotice}</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: SAMPLING & INFERENCE */}
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
