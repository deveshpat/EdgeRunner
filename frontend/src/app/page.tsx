"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Send,
  Terminal,
  Cpu,
  Settings2,
  CheckCircle2,
  XCircle,
  Rocket,
  Square,
  Loader2,
  KeyRound,
  Cloud,
  Zap,
  Link2,
  HardDrive,
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import {
  launchKaggleSession,
  waitForBackendHealth,
  type LaunchProgress,
} from "@/lib/kaggle";
import {
  clearSecret,
  loadChat,
  loadPrefs,
  loadSecret,
  saveChat,
  savePrefs,
  saveSecret,
} from "@/lib/storage";
import type {
  Accelerator,
  ConnectionMode,
  Message,
  SessionInfo,
  SessionState,
} from "@/lib/types";

const CHAT_KEY = "current";

export default function EdgeRunnerUI() {
  const [phase, setPhase] = useState<ConnectionMode>("setup");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [backendUrl, setBackendUrl] = useState("");
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Setup form
  const [setupTab, setSetupTab] = useState<"kaggle" | "local">("kaggle");
  const [username, setUsername] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [localUrl, setLocalUrl] = useState("http://127.0.0.1:8000");
  const [accelerator, setAccelerator] = useState<Accelerator>("gpu");
  const [idleTimeout, setIdleTimeout] = useState(90);
  const [maxLifetime, setMaxLifetime] = useState(3600);
  const [fallbackCpu, setFallbackCpu] = useState(true);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SessionInfo | null>(null);
  const backendUrlRef = useRef(backendUrl);
  const abortRef = useRef<AbortController | null>(null);
  const chatIdRef = useRef(CHAT_KEY);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    backendUrlRef.current = backendUrl;
  }, [backendUrl]);

  // Restore prefs + chat + in-tab secrets
  useEffect(() => {
    const prefs = loadPrefs();
    if (prefs.username) setUsername(prefs.username);
    if (prefs.localBackendUrl) setLocalUrl(prefs.localBackendUrl);
    if (prefs.accelerator) setAccelerator(prefs.accelerator);
    if (prefs.idleTimeout) setIdleTimeout(prefs.idleTimeout);
    if (prefs.maxLifetime) setMaxLifetime(prefs.maxLifetime);
    if (prefs.mode === "local") setSetupTab("local");

    const secret = loadSecret();
    if (secret) {
      setUsername(secret.username || prefs.username || "");
      if (secret.apiToken) setApiToken(secret.apiToken);
      if (secret.apiKey) setApiKey(secret.apiKey);
    }

    loadChat(CHAT_KEY).then((rec) => {
      if (rec?.messages?.length) {
        setMessages(rec.messages);
        chatIdRef.current = rec.id;
      }
    });
  }, []);

  // Persist messages
  useEffect(() => {
    if (messages.length === 0) return;
    const t = setTimeout(() => {
      void saveChat({
        id: chatIdRef.current,
        messages,
        updated_at: Date.now(),
        backend_url: backendUrl || undefined,
        kernel_ref: session?.kernel_ref,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [messages, backendUrl, session?.kernel_ref]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Health check
  useEffect(() => {
    if (!backendUrl) {
      setIsOnline(null);
      setModelReady(false);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`${backendUrl.replace(/\/$/, "")}/health`, {
          signal: AbortSignal.timeout(8000),
        });
        if (cancelled) return;
        setIsOnline(res.ok);
        if (res.ok) {
          const data = await res.json();
          setModelReady(!!data.model_ready);
        }
      } catch {
        if (!cancelled) setIsOnline(false);
      }
    };
    check();
    const interval = setInterval(check, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [backendUrl]);

  // Heartbeat keeps Kaggle worker alive
  useEffect(() => {
    if (!backendUrl || isOnline === false || phase === "setup") return;
    const beat = () => {
      const url = `${backendUrlRef.current.replace(/\/$/, "")}/session/heartbeat`;
      fetch(url, { method: "POST", keepalive: true }).catch(() => {});
    };
    beat();
    const interval = setInterval(beat, 25000);
    return () => clearInterval(interval);
  }, [backendUrl, isOnline, phase]);

  // Tab close → kill Kaggle session (chat already in IndexedDB)
  useEffect(() => {
    const shutdown = () => {
      const url = backendUrlRef.current;
      if (!url) return;
      // Only auto-kill Kaggle-hosted backends (tunnel hosts), not pure localhost
      // when user is in local mode — still send shutdown for tunneled sessions.
      const isTunnel =
        /trycloudflare\.com|loca\.lt|localtunnel\.me|bore\.pub/i.test(url);
      if (phase === "local" && !isTunnel) return;

      const endpoint = `${url.replace(/\/$/, "")}/session/shutdown`;
      const body = JSON.stringify({ reason: "tab_closed" });
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(
            endpoint,
            new Blob([body], { type: "application/json" })
          );
        } else {
          fetch(endpoint, {
            method: "POST",
            body,
            headers: { "Content-Type": "application/json" },
            keepalive: true,
          });
        }
      } catch {
        /* best effort */
      }
    };

    window.addEventListener("pagehide", shutdown);
    window.addEventListener("beforeunload", shutdown);
    return () => {
      window.removeEventListener("pagehide", shutdown);
      window.removeEventListener("beforeunload", shutdown);
    };
  }, [phase]);

  const attachLocal = async () => {
    setSessionError(null);
    setSessionBusy(true);
    try {
      const url = localUrl.trim().replace(/\/$/, "");
      if (!url) throw new Error("Enter a backend URL");
      const res = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`Health check failed (${res.status})`);
      const data = await res.json();
      setBackendUrl(url);
      setModelReady(!!data.model_ready);
      setIsOnline(true);
      setPhase("local");
      setShowSettings(false);
      savePrefs({
        mode: "local",
        localBackendUrl: url,
        lastBackendUrl: url,
      });
    } catch (e) {
      setSessionError(
        e instanceof Error
          ? e.message
          : "Could not reach local backend. Is it running?"
      );
    } finally {
      setSessionBusy(false);
    }
  };

  const onLaunchProgress = useCallback((p: LaunchProgress) => {
    setProgressMsg(p.message || null);
    if (p.state === "retrying_cpu") {
      setAccelerator("cpu");
    }
    setSession((prev) => {
      const base: SessionInfo = prev || {
        id: p.sessionId || "…",
        username: username,
        kernel_ref: p.kernelRef || "",
        accelerator: p.accelerator,
        state: "idle",
        public_url: null,
        error: null,
        kernel_status: null,
        logs_tail: "",
        created_at: Date.now(),
        idle_timeout: idleTimeout,
        max_lifetime: maxLifetime,
      };
      const stateMap: Record<string, SessionState> = {
        packing: "packing",
        pushing: "pushing",
        provisioning: "provisioning",
        online: "online",
        failed: "failed",
        retrying_cpu: "pushing",
      };
      return {
        ...base,
        id: p.sessionId || base.id,
        kernel_ref: p.kernelRef || base.kernel_ref,
        accelerator: p.accelerator,
        state: stateMap[p.state] || base.state,
        public_url: p.publicUrl || base.public_url,
        kernel_status: p.kernelStatus || base.kernel_status,
        logs_tail: p.logsTail || base.logs_tail,
        error: p.error || base.error,
      };
    });
  }, [username, idleTimeout, maxLifetime]);

  const launchKaggle = async () => {
    setSessionError(null);
    setProgressMsg(null);
    setSessionBusy(true);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      if (!username.trim()) throw new Error("Kaggle username is required");
      if (!apiToken.trim() && !apiKey.trim()) {
        throw new Error("Paste your Kaggle API token (or legacy key)");
      }

      savePrefs({
        username: username.trim(),
        mode: "kaggle",
        accelerator,
        idleTimeout,
        maxLifetime,
      });
      saveSecret({
        username: username.trim(),
        apiToken: apiToken.trim() || undefined,
        apiKey: apiKey.trim() || undefined,
      });

      const result = await launchKaggleSession({
        auth: {
          username: username.trim(),
          apiToken: apiToken.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
        },
        accelerator,
        idleTimeout,
        maxLifetime,
        fallbackCpu,
        onProgress: onLaunchProgress,
        signal: ac.signal,
      });

      setBackendUrl(result.publicUrl);
      setSession({
        id: result.sessionId,
        username: username.trim(),
        kernel_ref: result.kernelRef,
        accelerator: result.accelerator,
        state: "online",
        public_url: result.publicUrl,
        error: null,
        kernel_status: "RUNNING",
        logs_tail: result.logsTail,
        created_at: Date.now(),
        idle_timeout: idleTimeout,
        max_lifetime: maxLifetime,
      });
      setPhase("kaggle");
      setShowSettings(false);
      setProgressMsg("Waiting for model to finish loading…");
      savePrefs({ lastBackendUrl: result.publicUrl, accelerator: result.accelerator });

      // Soft-wait for model (chat works once ready; health already online)
      void waitForBackendHealth(result.publicUrl, {
        timeoutMs: 300_000,
        signal: ac.signal,
      }).then((h) => {
        setModelReady(h.model_ready);
        setIsOnline(true);
        setProgressMsg(null);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== "aborted" && msg !== "Launch aborted") {
        setSessionError(msg);
      }
      setSession(null);
      setPhase("setup");
    } finally {
      setSessionBusy(false);
    }
  };

  const stopSession = async () => {
    setSessionBusy(true);
    try {
      abortRef.current?.abort();
      if (backendUrl) {
        await fetch(`${backendUrl.replace(/\/$/, "")}/session/shutdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "user_stop" }),
        }).catch(() => {});
      }
      setSession((s) => (s ? { ...s, state: "stopped" } : s));
      setIsOnline(false);
      setBackendUrl("");
      setPhase("setup");
      setShowSettings(false);
    } finally {
      setSessionBusy(false);
    }
  };

  const disconnectKeepData = () => {
    // Leave Kaggle running? Prefer kill — user said teardown on close.
    // Manual "disconnect" also kills to protect quota.
    void stopSession();
  };

  const clearChat = () => {
    setMessages([]);
    void saveChat({
      id: chatIdRef.current,
      messages: [],
      updated_at: Date.now(),
    });
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading || !backendUrl) return;

    const userMsg: Message = {
      role: "user",
      content: input,
      ts: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch(`${backendUrl.replace(/\/$/, "")}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      if (!response.ok) throw new Error("Backend connection failed");

      const data = await response.json();
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.response,
          thoughts: data.thought_process,
          ts: Date.now(),
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "⚠️ Connection error. Is the backend still running? If you used Kaggle, the session may have timed out — open settings and relaunch.",
          ts: Date.now(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const stateColor = (state?: string) => {
    switch (state) {
      case "online":
        return "text-emerald-400";
      case "failed":
      case "stopped":
        return "text-red-400";
      case "packing":
      case "pushing":
      case "provisioning":
        return "text-amber-400";
      default:
        return "text-neutral-400";
    }
  };

  // ─── LAUNCHING OVERLAY ────────────────────────────────────────────────────
  if (phase === "setup" && sessionBusy) {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-200 flex flex-col items-center justify-center p-6">
        <Loader2 size={40} className="animate-spin text-cyan-500 mb-4" />
        <h2 className="text-lg font-semibold">Starting Kaggle session</h2>
        <p className="text-sm text-neutral-500 mt-2 max-w-md text-center">
          {progressMsg ||
            "Pushing worker, installing deps, opening tunnel… first boot can take several minutes."}
        </p>
        {session && (
          <div className="mt-6 text-xs font-mono bg-neutral-900 border border-neutral-800 rounded-xl p-4 max-w-lg w-full space-y-1 text-neutral-400">
            <div>
              <span className="text-neutral-600">state </span>
              <span className={stateColor(session.state)}>{session.state}</span>
            </div>
            <div>
              <span className="text-neutral-600">kernel </span>
              {session.kernel_ref || "…"}
            </div>
            <div>
              <span className="text-neutral-600">accel </span>
              {session.accelerator}
            </div>
            {session.kernel_status && (
              <div>
                <span className="text-neutral-600">kaggle </span>
                {session.kernel_status}
              </div>
            )}
            {session.logs_tail && (
              <pre className="mt-2 max-h-40 overflow-y-auto text-[10px] text-neutral-500 whitespace-pre-wrap">
                {session.logs_tail.slice(-1500)}
              </pre>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            abortRef.current?.abort();
            setSessionBusy(false);
            setSession(null);
            setSessionError("Launch cancelled");
          }}
          className="mt-6 text-sm text-neutral-500 hover:text-red-400"
        >
          Cancel
        </button>
      </div>
    );
  }

  // ─── SETUP GATE ───────────────────────────────────────────────────────────
  if (phase === "setup") {
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-200 flex flex-col">
        <header className="flex items-center gap-3 p-6 border-b border-neutral-800">
          <div className="p-2 bg-cyan-950 rounded-lg text-cyan-400">
            <Cpu size={24} />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wider">EDGERUNNER</h1>
            <p className="text-xs text-neutral-500">
              GitHub Pages · Kaggle CPU/GPU · local backend
            </p>
          </div>
        </header>

        <main className="flex-1 flex items-start justify-center p-6">
          <div className="w-full max-w-lg space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-neutral-100">
                Connect a backend
              </h2>
              <p className="text-sm text-neutral-500 mt-1">
                Paste a Kaggle API token to spin up a remote session, or point
                at a backend already running on your machine. Chat history is
                saved in this browser (IndexedDB) and survives reloads.
              </p>
            </div>

            <div className="flex rounded-xl border border-neutral-800 overflow-hidden">
              <button
                type="button"
                onClick={() => setSetupTab("kaggle")}
                className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm transition-colors ${
                  setupTab === "kaggle"
                    ? "bg-cyan-950/60 text-cyan-300"
                    : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <Cloud size={16} /> Kaggle
              </button>
              <button
                type="button"
                onClick={() => setSetupTab("local")}
                className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm transition-colors ${
                  setupTab === "local"
                    ? "bg-cyan-950/60 text-cyan-300"
                    : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"
                }`}
              >
                <HardDrive size={16} /> Local URL
              </button>
            </div>

            {setupTab === "kaggle" ? (
              <div className="space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900/50 p-5">
                <div className="flex items-start gap-2 text-xs text-neutral-500">
                  <KeyRound size={14} className="mt-0.5 shrink-0 text-cyan-600" />
                  <p>
                    Token stays in{" "}
                    <span className="text-neutral-400">sessionStorage</span> only
                    (cleared when the tab closes). Create one at{" "}
                    <a
                      href="https://www.kaggle.com/settings"
                      target="_blank"
                      rel="noreferrer"
                      className="text-cyan-500 hover:underline"
                    >
                      kaggle.com/settings
                    </a>
                    .
                  </p>
                </div>

                <label className="block text-xs text-neutral-400">
                  Kaggle username
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm"
                    autoComplete="username"
                    placeholder="your-kaggle-username"
                  />
                </label>
                <label className="block text-xs text-neutral-400">
                  API token
                  <input
                    type="password"
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm font-mono"
                    autoComplete="off"
                    placeholder="Bearer access token"
                  />
                </label>
                <label className="block text-xs text-neutral-500">
                  Legacy API key (optional)
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm"
                    autoComplete="off"
                  />
                </label>

                <div>
                  <p className="text-xs text-neutral-400 mb-2">Accelerator</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setAccelerator("gpu")}
                      className={`flex-1 py-2.5 rounded-lg border text-sm transition-colors ${
                        accelerator === "gpu"
                          ? "border-amber-600 bg-amber-950/40 text-amber-300"
                          : "border-neutral-800 bg-neutral-950 text-neutral-400"
                      }`}
                    >
                      GPU
                    </button>
                    <button
                      type="button"
                      onClick={() => setAccelerator("cpu")}
                      className={`flex-1 py-2.5 rounded-lg border text-sm transition-colors ${
                        accelerator === "cpu"
                          ? "border-cyan-600 bg-cyan-950/50 text-cyan-300"
                          : "border-neutral-800 bg-neutral-950 text-neutral-400"
                      }`}
                    >
                      CPU
                    </button>
                  </div>
                  <label className="mt-3 flex items-start gap-2 text-xs text-neutral-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={fallbackCpu}
                      onChange={(e) => setFallbackCpu(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      If GPU fails (e.g. ~30h monthly quota exhausted), fall
                      back to CPU automatically.
                    </span>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs text-neutral-400">
                    Idle kill (sec)
                    <input
                      type="number"
                      min={30}
                      max={3600}
                      value={idleTimeout}
                      onChange={(e) => setIdleTimeout(Number(e.target.value))}
                      className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="block text-xs text-neutral-400">
                    Max lifetime (sec)
                    <input
                      type="number"
                      min={300}
                      max={43200}
                      value={maxLifetime}
                      onChange={(e) => setMaxLifetime(Number(e.target.value))}
                      className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm"
                    />
                  </label>
                </div>

                <p className="text-xs text-neutral-600">
                  Closing this tab sends a shutdown beacon and stops heartbeats
                  so the Kaggle worker exits (frees quota). Chat messages stay
                  in your browser.
                </p>

                <button
                  onClick={launchKaggle}
                  disabled={
                    sessionBusy ||
                    !username.trim() ||
                    (!apiToken.trim() && !apiKey.trim())
                  }
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 text-white text-sm font-medium transition-colors"
                >
                  <Rocket size={16} /> Launch on Kaggle
                </button>
              </div>
            ) : (
              <div className="space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900/50 p-5">
                <div className="flex items-start gap-2 text-xs text-neutral-500">
                  <Link2 size={14} className="mt-0.5 shrink-0 text-cyan-600" />
                  <p>
                    Run the FastAPI backend locally, then paste its URL. Example:{" "}
                    <code className="text-neutral-400">
                      cd backend && EDGERUNNER_AUTO=1 python main.py
                    </code>
                  </p>
                </div>
                <label className="block text-xs text-neutral-400">
                  Backend URL
                  <input
                    value={localUrl}
                    onChange={(e) => setLocalUrl(e.target.value)}
                    className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2.5 text-sm font-mono"
                    placeholder="http://127.0.0.1:8000"
                  />
                </label>
                <button
                  onClick={attachLocal}
                  disabled={sessionBusy || !localUrl.trim()}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 text-white text-sm font-medium transition-colors"
                >
                  <Link2 size={16} /> Connect
                </button>
              </div>
            )}

            {sessionError && (
              <p className="text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded-lg p-3 whitespace-pre-wrap">
                {sessionError}
              </p>
            )}

            {messages.length > 0 && (
              <p className="text-xs text-neutral-600 text-center">
                {messages.length} saved message
                {messages.length === 1 ? "" : "s"} will reappear after you
                connect.
              </p>
            )}
          </div>
        </main>
      </div>
    );
  }

  // ─── MAIN CHAT ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-neutral-950 text-neutral-200 font-sans selection:bg-cyan-900 selection:text-cyan-50">
      <header className="flex items-center justify-between p-4 bg-neutral-900 border-b border-neutral-800 shadow-md">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-cyan-950 rounded-lg text-cyan-400">
            <Cpu size={24} />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wider text-neutral-100">
              EDGERUNNER
            </h1>
            <p className="text-xs text-neutral-400">
              {phase === "kaggle"
                ? "Kaggle session · auto-tunnel · kill on tab close"
                : "Local backend"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 text-sm">
          {session && (
            <div
              className={`hidden sm:flex items-center gap-2 px-3 py-1.5 bg-neutral-950 rounded-full border border-neutral-800 ${stateColor(session.state)}`}
            >
              {session.state === "online" ? (
                <Cloud size={14} />
              ) : (
                <Loader2 size={14} className="animate-spin" />
              )}
              <span className="capitalize">{session.state}</span>
              <span className="text-neutral-600">·</span>
              <span className="uppercase text-neutral-400">
                {session.accelerator}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 px-3 py-1.5 bg-neutral-950 rounded-full border border-neutral-800">
            {isOnline ? (
              <>
                <CheckCircle2 size={14} className="text-emerald-500" />
                <span className="text-emerald-500/80">
                  {modelReady ? "Engine Online" : "Booting model…"}
                </span>
              </>
            ) : (
              <>
                <XCircle size={14} className="text-red-500" />
                <span className="text-red-500/80">
                  {backendUrl ? "Disconnected" : "No session"}
                </span>
              </>
            )}
          </div>

          <button
            onClick={() => setShowSettings((v) => !v)}
            className="p-2 hover:bg-neutral-800 rounded-full transition-colors"
            title="Session settings"
          >
            <Settings2 size={20} className="text-neutral-400" />
          </button>
        </div>
      </header>

      {showSettings && (
        <section className="border-b border-neutral-800 bg-neutral-900/80 p-4">
          <div className="max-w-3xl mx-auto space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={stopSession}
                disabled={sessionBusy}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-red-900/60 bg-red-950/30 hover:bg-red-950/60 text-red-300 text-sm"
              >
                <Square size={14} /> Stop & teardown
              </button>
              <button
                onClick={() => {
                  disconnectKeepData();
                  clearSecret();
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-neutral-700 text-neutral-400 text-sm hover:bg-neutral-800"
              >
                Back to setup
              </button>
              <button
                onClick={clearChat}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-neutral-700 text-neutral-400 text-sm hover:bg-neutral-800"
              >
                <Trash2 size={14} /> Clear chat
              </button>
            </div>
            {backendUrl && (
              <p className="text-xs font-mono text-cyan-500/80 break-all">
                {backendUrl}
              </p>
            )}
            {session?.kernel_ref && (
              <p className="text-xs text-neutral-500">
                kernel{" "}
                <a
                  className="text-neutral-400 hover:underline"
                  href={`https://www.kaggle.com/code/${session.kernel_ref}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {session.kernel_ref}
                </a>
              </p>
            )}
            {progressMsg && (
              <p className="text-xs text-amber-400/80">{progressMsg}</p>
            )}
            {sessionError && (
              <p className="text-xs text-red-400">{sessionError}</p>
            )}
          </div>
        </section>
      )}

      <main className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-neutral-500 space-y-4">
            <Terminal size={48} className="opacity-20" />
            <p className="text-center max-w-md text-sm">
              {modelReady
                ? "Session ready. Give the agent a coding task."
                : backendUrl
                  ? "Backend is up — model may still be downloading on first boot."
                  : "Connect a backend to start chatting."}
            </p>
            <p className="text-xs text-neutral-600 flex items-center gap-1">
              <Zap size={12} /> Chat is persisted in this browser via IndexedDB
            </p>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
          >
            {msg.role === "assistant" &&
              msg.thoughts &&
              msg.thoughts.length > 0 && (
                <div className="mb-2 max-w-[85%] md:max-w-[70%] w-full">
                  <div className="text-xs text-cyan-600 mb-1 flex items-center gap-2 font-mono ml-2">
                    <Terminal size={12} /> Agent Reflection Logs
                  </div>
                  <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-3 space-y-3 font-mono text-xs text-neutral-400 overflow-x-auto">
                    {msg.thoughts.map((thought, i) => (
                      <div key={i} className="border-l-2 border-neutral-700 pl-3">
                        {thought}
                      </div>
                    ))}
                  </div>
                </div>
              )}

            <div
              className={`max-w-[85%] md:max-w-[70%] p-4 rounded-2xl ${
                msg.role === "user"
                  ? "bg-cyan-900/40 border border-cyan-800/50 rounded-tr-none text-cyan-50"
                  : "bg-neutral-800/50 border border-neutral-700/50 rounded-tl-none"
              }`}
            >
              <div className="prose prose-invert prose-p:leading-relaxed prose-pre:bg-neutral-900 prose-pre:border prose-pre:border-neutral-700 max-w-none">
                <ReactMarkdown>{msg.content}</ReactMarkdown>
              </div>
            </div>
          </div>
        ))}

        {isLoading && (
          <div className="flex items-start max-w-[70%]">
            <div className="bg-neutral-800/50 border border-neutral-700/50 p-4 rounded-2xl rounded-tl-none animate-pulse text-cyan-500/70 text-sm font-mono flex items-center gap-2">
              <Terminal size={16} className="animate-bounce" /> Harness is
              thinking…
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      <footer className="p-4 bg-neutral-900 border-t border-neutral-800">
        <div className="max-w-4xl mx-auto flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={
              backendUrl
                ? "Give the agent a task…"
                : "Connect a backend first…"
            }
            disabled={!backendUrl}
            className="flex-1 bg-neutral-950 border border-neutral-800 rounded-xl p-4 text-neutral-200 focus:outline-none focus:border-cyan-700 focus:ring-1 focus:ring-cyan-700 resize-none disabled:opacity-50"
            rows={1}
            style={{ minHeight: "56px", maxHeight: "200px" }}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isLoading || !backendUrl}
            className="p-4 bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 disabled:hover:bg-cyan-700 text-white rounded-xl transition-colors flex items-center justify-center"
          >
            <Send size={20} />
          </button>
        </div>
      </footer>
    </div>
  );
}
