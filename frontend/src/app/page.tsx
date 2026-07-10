"use client";

import { useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import ReactMarkdown from "react-markdown";

type Message = {
  role: "user" | "assistant";
  content: string;
  thoughts?: string[];
};

type SessionInfo = {
  id: string;
  username: string;
  kernel_ref: string;
  accelerator: string;
  state: string;
  public_url: string | null;
  error: string | null;
  kernel_status: string | null;
  logs_tail: string;
  age_seconds: number;
  idle_timeout: number;
  max_lifetime: number;
};

const ORCHESTRATOR_DEFAULT =
  process.env.NEXT_PUBLIC_ORCHESTRATOR_URL || "http://127.0.0.1:9000";

const STORAGE_KEYS = {
  username: "kp_username",
  orchestrator: "kp_orchestrator",
};

export default function EdgeRunnerUI() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [backendUrl, setBackendUrl] = useState("");
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const [showSettings, setShowSettings] = useState(true);

  // Kaggle / orchestrator config
  const [orchestratorUrl, setOrchestratorUrl] = useState(ORCHESTRATOR_DEFAULT);
  const [username, setUsername] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [accelerator, setAccelerator] = useState<"cpu" | "gpu">("cpu");
  const [idleTimeout, setIdleTimeout] = useState(90);
  const [maxLifetime, setMaxLifetime] = useState(3600);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SessionInfo | null>(null);
  const backendUrlRef = useRef(backendUrl);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    backendUrlRef.current = backendUrl;
  }, [backendUrl]);

  // Restore non-secret prefs
  useEffect(() => {
    try {
      const u = localStorage.getItem(STORAGE_KEYS.username);
      const o = localStorage.getItem(STORAGE_KEYS.orchestrator);
      if (u) setUsername(u);
      if (o) setOrchestratorUrl(o);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Health check against the Kaggle-tunneled backend
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

  // Poll orchestrator while provisioning
  useEffect(() => {
    if (!session || !["pending", "pushing", "provisioning"].includes(session.state)) {
      return;
    }
    const t = setInterval(async () => {
      try {
        const res = await fetch(
          `${orchestratorUrl.replace(/\/$/, "")}/sessions/${session.id}`
        );
        if (!res.ok) return;
        const data: SessionInfo = await res.json();
        setSession(data);
        if (data.public_url) {
          setBackendUrl(data.public_url);
          setShowSettings(false);
        }
        if (data.state === "failed") {
          setSessionError(data.error || "Session failed");
        }
      } catch {
        /* ignore transient */
      }
    }, 5000);
    return () => clearInterval(t);
  }, [session, orchestratorUrl]);

  // Heartbeat → keeps Kaggle session alive; missing heartbeats kill it
  useEffect(() => {
    if (!backendUrl || isOnline === false) return;

    const beat = () => {
      const url = `${backendUrlRef.current.replace(/\/$/, "")}/session/heartbeat`;
      fetch(url, { method: "POST", keepalive: true }).catch(() => {});
    };
    beat();
    const interval = setInterval(beat, 25000);
    return () => clearInterval(interval);
  }, [backendUrl, isOnline]);

  // Tab close / hide → ask worker to shut down (frees GPU hours)
  useEffect(() => {
    const shutdown = () => {
      const url = backendUrlRef.current;
      if (!url) return;
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

      const s = sessionRef.current;
      if (s) {
        try {
          fetch(
            `${orchestratorUrl.replace(/\/$/, "")}/sessions/${s.id}/stop`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reason: "tab_closed" }),
              keepalive: true,
            }
          );
        } catch {
          /* ignore */
        }
      }
    };

    const onVis = () => {
      // Don't kill on tab switch — only on actual unload
    };
    window.addEventListener("pagehide", shutdown);
    window.addEventListener("beforeunload", shutdown);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", shutdown);
      window.removeEventListener("beforeunload", shutdown);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [orchestratorUrl]);

  const startSession = async () => {
    setSessionError(null);
    setSessionBusy(true);
    try {
      localStorage.setItem(STORAGE_KEYS.username, username);
      localStorage.setItem(STORAGE_KEYS.orchestrator, orchestratorUrl);

      const res = await fetch(
        `${orchestratorUrl.replace(/\/$/, "")}/sessions/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username,
            key: apiKey || null,
            api_token: apiToken || null,
            accelerator,
            idle_timeout: idleTimeout,
            max_lifetime: maxLifetime,
          }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || res.statusText || "Failed to start session");
      }
      const data: SessionInfo = await res.json();
      setSession(data);
    } catch (e) {
      setSessionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSessionBusy(false);
    }
  };

  const stopSession = async () => {
    setSessionBusy(true);
    try {
      // Prefer direct worker shutdown (actually frees compute)
      if (backendUrl) {
        await fetch(`${backendUrl.replace(/\/$/, "")}/session/shutdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "user_stop" }),
        }).catch(() => {});
      }
      if (session) {
        await fetch(
          `${orchestratorUrl.replace(/\/$/, "")}/sessions/${session.id}/stop`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: "user_stop" }),
          }
        ).catch(() => {});
      }
      setSession((s) =>
        s ? { ...s, state: "stopped", public_url: s.public_url } : s
      );
      setIsOnline(false);
    } finally {
      setSessionBusy(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading || !backendUrl) return;

    const userMsg: Message = { role: "user", content: input };
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
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content:
            "⚠️ Connection error. Is your EdgeRunner Kaggle session still running? Check the session panel.",
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
      case "pushing":
      case "provisioning":
      case "pending":
        return "text-amber-400";
      default:
        return "text-neutral-400";
    }
  };

  return (
    <div className="flex flex-col h-screen bg-neutral-950 text-neutral-200 font-sans selection:bg-cyan-900 selection:text-cyan-50">
      {/* HEADER */}
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
              Local / Kaggle agentic harness · auto-tunnel · auto-kill
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 text-sm">
          {session && (
            <div
              className={`hidden sm:flex items-center gap-2 px-3 py-1.5 bg-neutral-950 rounded-full border border-neutral-800 ${stateColor(session.state)}`}
            >
              {["pushing", "provisioning", "pending"].includes(session.state) ? (
                <Loader2 size={14} className="animate-spin" />
              ) : session.state === "online" ? (
                <Cloud size={14} />
              ) : (
                <XCircle size={14} />
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

      {/* SESSION PANEL */}
      {showSettings && (
        <section className="border-b border-neutral-800 bg-neutral-900/80 p-4">
          <div className="max-w-5xl mx-auto grid gap-4 md:grid-cols-2">
            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-cyan-400 flex items-center gap-2">
                <KeyRound size={16} /> Kaggle credentials
              </h2>
              <p className="text-xs text-neutral-500">
                Keys stay in the local orchestrator memory only — never written to
                disk. Create a token at{" "}
                <span className="text-neutral-400">
                  kaggle.com/settings/account → API
                </span>
                .
              </p>
              <label className="block text-xs text-neutral-400">
                Orchestrator URL
                <input
                  value={orchestratorUrl}
                  onChange={(e) => setOrchestratorUrl(e.target.value)}
                  className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm"
                  placeholder="http://127.0.0.1:9000"
                />
              </label>
              <label className="block text-xs text-neutral-400">
                Kaggle username
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm"
                  autoComplete="username"
                />
              </label>
              <label className="block text-xs text-neutral-400">
                API token (recommended)
                <input
                  type="password"
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm"
                  autoComplete="off"
                  placeholder="kaggle access token"
                />
              </label>
              <label className="block text-xs text-neutral-400">
                Legacy API key (optional)
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm"
                  autoComplete="off"
                />
              </label>
            </div>

            <div className="space-y-3">
              <h2 className="text-sm font-semibold text-cyan-400 flex items-center gap-2">
                <Zap size={16} /> Session
              </h2>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setAccelerator("cpu")}
                  className={`flex-1 py-2 rounded-lg border text-sm transition-colors ${
                    accelerator === "cpu"
                      ? "border-cyan-600 bg-cyan-950/50 text-cyan-300"
                      : "border-neutral-800 bg-neutral-950 text-neutral-400"
                  }`}
                >
                  CPU (safe for testing)
                </button>
                <button
                  type="button"
                  onClick={() => setAccelerator("gpu")}
                  className={`flex-1 py-2 rounded-lg border text-sm transition-colors ${
                    accelerator === "gpu"
                      ? "border-amber-600 bg-amber-950/40 text-amber-300"
                      : "border-neutral-800 bg-neutral-950 text-neutral-400"
                  }`}
                >
                  GPU (uses monthly hours)
                </button>
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

              <p className="text-xs text-neutral-500">
                Closing this tab sends a shutdown beacon. If that fails, the
                worker still exits after{" "}
                <span className="text-neutral-300">{idleTimeout}s</span> without
                heartbeats — so abandoned GPU sessions do not burn your quota.
              </p>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={startSession}
                  disabled={
                    sessionBusy ||
                    !username ||
                    (!apiKey && !apiToken) ||
                    (session?.state === "online" ||
                      session?.state === "provisioning" ||
                      session?.state === "pushing")
                  }
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 text-white text-sm font-medium transition-colors"
                >
                  {sessionBusy ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Rocket size={16} />
                  )}
                  Launch on Kaggle
                </button>
                <button
                  onClick={stopSession}
                  disabled={sessionBusy || !session}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-red-900/60 bg-red-950/30 hover:bg-red-950/60 disabled:opacity-40 text-red-300 text-sm transition-colors"
                >
                  <Square size={14} /> Stop
                </button>
              </div>

              {sessionError && (
                <p className="text-xs text-red-400 bg-red-950/30 border border-red-900/40 rounded-lg p-2">
                  {sessionError}
                </p>
              )}

              {session && (
                <div className="text-xs font-mono bg-neutral-950 border border-neutral-800 rounded-lg p-3 space-y-1 text-neutral-400 max-h-40 overflow-y-auto">
                  <div>
                    <span className="text-neutral-500">id</span> {session.id}
                  </div>
                  <div>
                    <span className="text-neutral-500">kernel</span>{" "}
                    {session.kernel_ref}
                  </div>
                  <div>
                    <span className="text-neutral-500">state</span>{" "}
                    <span className={stateColor(session.state)}>
                      {session.state}
                    </span>
                  </div>
                  {session.public_url && (
                    <div className="break-all">
                      <span className="text-neutral-500">url</span>{" "}
                      <span className="text-cyan-400">{session.public_url}</span>
                    </div>
                  )}
                  {session.kernel_status && (
                    <div className="break-all">
                      <span className="text-neutral-500">kaggle</span>{" "}
                      {session.kernel_status}
                    </div>
                  )}
                  {session.error && (
                    <div className="text-red-400">{session.error}</div>
                  )}
                </div>
              )}

              <label className="block text-xs text-neutral-400">
                Backend URL (auto-filled when tunnel is ready)
                <input
                  value={backendUrl}
                  onChange={(e) => setBackendUrl(e.target.value)}
                  className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded-lg px-3 py-2 text-sm font-mono"
                  placeholder="https://….trycloudflare.com"
                />
              </label>
            </div>
          </div>
        </section>
      )}

      {/* CHAT AREA */}
      <main className="flex-1 overflow-y-auto p-4 md:p-8 space-y-6">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-neutral-500 space-y-4">
            <Terminal size={48} className="opacity-20" />
            <p className="text-center max-w-md text-sm">
              {backendUrl
                ? "Session ready. Give the agent a coding task."
                : "Launch a Kaggle session from the panel above. Only your Kaggle API credentials are required."}
            </p>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
          >
            {msg.role === "assistant" && msg.thoughts && msg.thoughts.length > 0 && (
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
              thinking & executing code on Kaggle…
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      {/* INPUT */}
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
                ? "Give the agent a task (e.g. 'Write a python script to reverse a string')..."
                : "Launch a Kaggle session first…"
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
