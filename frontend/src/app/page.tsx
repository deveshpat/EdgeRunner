"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Send,
  Settings2,
  Square,
  Loader2,
  Shield,
  Lock,
  Eye,
  EyeOff,
  ChevronRight,
  X,
} from "lucide-react";
import {
  consumeOAuthRedirect,
  getGoogleUser,
  initGoogleAuth,
  isGoogleConfigured,
  isGoogleSignedIn,
  onGoogleAuthChange,
  signInWithGoogleRedirect,
  signOutGoogle,
  type GoogleUser,
} from "@/lib/google-auth";
import { syncAfterGoogleLogin } from "@/lib/cloud-sync";
import { loadConfig } from "@/lib/config";
import {
  clearLiveSession,
  loadLiveSession,
  pokeHeartbeat,
  probeBackend,
  saveLiveSession,
} from "@/lib/session-persist";
import ReactMarkdown from "react-markdown";
import {
  launchKaggleSession,
  waitForBackendHealth,
  type LaunchProgress,
} from "@/lib/kaggle";
import {
  clearSecret,
  createVault,
  getLocalSyncUpdatedAt,
  isUnlocked,
  loadChat,
  loadPrefs,
  loadSecret,
  migrateLegacyIfNeeded,
  readMeta,
  saveChat,
  savePrefs,
  saveSecret,
  tryAutoUnlock,
  unlockDeviceVault,
  unlockWithPassphrase,
  vaultExists,
  wipeVault,
  type VaultMode,
} from "@/lib/storage";
import type {
  Accelerator,
  ConnectionMode,
  Message,
  ModelOption,
  SessionInfo,
  SessionState,
} from "@/lib/types";

const CHAT_KEY = "current";

type VaultGate = "loading" | "ready" | "signin" | "need_passphrase" | "create";

function sysLine(content: string): Message {
  return { role: "system", content, ts: Date.now() };
}

export default function EdgeRunnerUI() {
  const [vaultGate, setVaultGate] = useState<VaultGate>("loading");
  const [passphrase, setPassphrase] = useState("");
  const [passphrase2, setPassphrase2] = useState("");
  const [vaultModeChoice, setVaultModeChoice] = useState<VaultMode>("device");
  const [lockedVaultMode, setLockedVaultMode] = useState<VaultMode | null>(
    null
  );
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [showPass, setShowPass] = useState(false);
  const [googleUser, setGoogleUser] = useState<GoogleUser | null>(null);
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleMsg, setGoogleMsg] = useState<string | null>(null);
  const [clientIdDraft, setClientIdDraft] = useState("");

  const [phase, setPhase] = useState<ConnectionMode>("setup");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [backendUrl, setBackendUrl] = useState("");
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const [modelReady, setModelReady] = useState(false);
  const [modelName, setModelName] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelHw, setModelHw] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [restoring, setRestoring] = useState(true);

  const [setupTab, setSetupTab] = useState<"kaggle" | "local">("kaggle");
  const [username, setUsername] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasStoredCreds, setHasStoredCreds] = useState(false);
  const [localUrl, setLocalUrl] = useState("http://127.0.0.1:8000");
  const [accelerator, setAccelerator] = useState<Accelerator>("gpu");
  const [idleTimeout, setIdleTimeout] = useState(90);
  const [maxLifetime, setMaxLifetime] = useState(3600);
  const [fallbackCpu, setFallbackCpu] = useState(true);
  const [rememberCreds, setRememberCreds] = useState(true);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionRef = useRef<SessionInfo | null>(null);
  const backendUrlRef = useRef(backendUrl);
  const abortRef = useRef<AbortController | null>(null);
  const chatIdRef = useRef(CHAT_KEY);
  const intentionalStopRef = useRef(false);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    backendUrlRef.current = backendUrl;
  }, [backendUrl]);

  // ── Boot: Google redirect return → silent vault → ready ─────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { configured } = await initGoogleAuth();
        if (cancelled) return;
        setGoogleConfigured(configured);
        try {
          const cfg = await loadConfig();
          setClientIdDraft(cfg.googleClientId || "");
        } catch {
          /* ignore */
        }

        // 1) Finish Google redirect if we just came back from accounts.google.com
        const oauth = await consumeOAuthRedirect();
        if (cancelled) return;
        if (oauth.error) {
          setVaultError(oauth.error);
          setVaultGate("signin");
          return;
        }
        if (oauth.user) {
          setGoogleUser(oauth.user);
          // Silent device vault — user never sees passphrase setup
          const exists = await vaultExists();
          if (!exists) await createVault({ mode: "device" });
          else {
            await tryAutoUnlock();
            if (!isUnlocked()) {
              try {
                await unlockDeviceVault();
              } catch {
                await createVault({ mode: "device" });
              }
            }
          }
          await migrateLegacyIfNeeded();
          if (!cancelled) {
            setVaultGate("ready");
            // Sync Kaggle creds in background after paint
            setTimeout(() => {
              void runGoogleSync().catch(() => {});
            }, 0);
          }
          return;
        }

        // 2) Already signed in this session + vault unlocks
        setGoogleUser(getGoogleUser());
        if (isGoogleSignedIn() || getGoogleUser()) {
          const exists = await vaultExists();
          if (!exists) await createVault({ mode: "device" });
          const ok = await tryAutoUnlock();
          if (ok || isUnlocked()) {
            await migrateLegacyIfNeeded();
            if (!cancelled) setVaultGate("ready");
            return;
          }
        }

        // 3) Local device vault only (returning visitor, no Google yet)
        const exists = await vaultExists();
        if (exists) {
          const meta = await readMeta();
          if (meta?.mode === "passphrase") {
            if (!cancelled) {
              setLockedVaultMode("passphrase");
              setVaultGate("need_passphrase");
            }
            return;
          }
          const ok = await tryAutoUnlock();
          if (ok) {
            await migrateLegacyIfNeeded();
            if (!cancelled) setVaultGate("ready");
            return;
          }
        }

        // 4) Default front door: Sign in with Google
        if (!cancelled) setVaultGate("signin");
      } catch {
        if (!cancelled) setVaultGate("signin");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return onGoogleAuthChange(() => {
      setGoogleUser(getGoogleUser());
    });
  }, []);

  const runGoogleSync = async () => {
    if (!isUnlocked()) {
      // ensure device vault for local encrypt
      const exists = await vaultExists();
      if (!exists) await createVault({ mode: "device" });
      else await tryAutoUnlock();
      if (!isUnlocked()) await unlockDeviceVault().catch(() => createVault({ mode: "device" }));
    }
    const secret = await loadSecret();
    const prefs = loadPrefs();
    const result = await syncAfterGoogleLogin({
      secret,
      prefs,
      applySecret: async (s) => {
        await saveSecret(s);
        setUsername(s.username || "");
        if (s.apiToken) setApiToken(s.apiToken);
        if (s.apiKey) setApiKey(s.apiKey);
        setHasStoredCreds(!!(s.apiToken || s.apiKey));
      },
      applyPrefs: (pr) => {
        savePrefs(pr);
        if (pr.username) setUsername(pr.username);
        if (pr.localBackendUrl) setLocalUrl(pr.localBackendUrl);
        if (pr.accelerator) setAccelerator(pr.accelerator);
        if (pr.idleTimeout) setIdleTimeout(pr.idleTimeout);
        if (pr.maxLifetime) setMaxLifetime(pr.maxLifetime);
        if (pr.mode === "local") setSetupTab("local");
      },
      getLocalUpdatedAt: () => getLocalSyncUpdatedAt(),
    });
    setGoogleMsg(result.detail);
    setMessages((m) => {
      const line = {
        role: "system" as const,
        content: `google sync · ${result.detail}`,
        ts: Date.now(),
      };
      return m.length ? [...m, line] : [line];
    });
    return result;
  };

  const handleGoogleSignIn = async () => {
    setGoogleBusy(true);
    setVaultError(null);
    setGoogleMsg(null);
    try {
      // Full-page redirect to Google — does not return
      await signInWithGoogleRedirect();
    } catch (e) {
      setVaultError(e instanceof Error ? e.message : String(e));
      setGoogleBusy(false);
    }
  };


  // After vault ready: restore prefs + auto-reconnect Kaggle (no Launch click)
  useEffect(() => {
    if (vaultGate !== "ready") return;
    let cancelled = false;

    (async () => {
      const prefs = loadPrefs();
      if (prefs.username) setUsername(prefs.username);
      if (prefs.localBackendUrl) setLocalUrl(prefs.localBackendUrl);
      if (prefs.accelerator) setAccelerator(prefs.accelerator);
      if (prefs.idleTimeout) setIdleTimeout(prefs.idleTimeout);
      if (prefs.maxLifetime) setMaxLifetime(prefs.maxLifetime);
      if (prefs.mode === "local") setSetupTab("local");
      if (typeof prefs.rememberCredentials === "boolean") {
        setRememberCreds(prefs.rememberCredentials);
      }

      const secret = await loadSecret();
      if (secret) {
        setUsername(secret.username || prefs.username || "");
        if (secret.apiToken) setApiToken(secret.apiToken);
        if (secret.apiKey) setApiKey(secret.apiKey);
        setHasStoredCreds(!!(secret.apiToken || secret.apiKey));
      }
      const rec = await loadChat(CHAT_KEY);
      if (rec?.messages?.length && !cancelled) {
        setMessages(rec.messages);
        chatIdRef.current = rec.id;
      }

      // Prefer same-tab sessionStorage (survives refresh), then prefs
      const live = loadLiveSession();
      const last = (
        live?.backendUrl ||
        prefs.lastBackendUrl ||
        ""
      ).replace(/\/$/, "");

      if (last) {
        setProgressMsg("reconnecting to session…");
        // Cancel any soft-detach / keep idle watchdog happy immediately
        pokeHeartbeat(last);
        const probe = await probeBackend(last, { retries: 6, timeoutMs: 8000 });
        if (probe.ok && !cancelled) {
          const isTunnel =
            /trycloudflare\.com|loca\.lt|localtunnel\.me|bore\.pub/i.test(last);
          const phase: "kaggle" | "local" =
            live?.phase || (isTunnel ? "kaggle" : "local");
          setBackendUrl(last);
          setIsOnline(true);
          setModelReady(probe.model_ready);
          setModelName(probe.modelName);
          setPhase(phase);
          setProgressMsg(
            probe.model_ready ? null : "backend up; model still loading…"
          );
          saveLiveSession({
            backendUrl: last,
            phase,
            kernelRef: live?.kernelRef,
            accelerator: live?.accelerator || prefs.accelerator,
            savedAt: Date.now(),
          });
          savePrefs({ lastBackendUrl: last });
          setMessages((m) => {
            const line = sysLine(
              `session restored · ${last.replace(/^https?:\/\//, "")}`
            );
            if (!m.length) return [line];
            // Don't spam if already noted
            if (m.some((x) => x.content?.includes("session restored"))) return m;
            return [...m, line];
          });
          if (!cancelled) setRestoring(false);
          return;
        }
      }

      // Session dead (tab was closed long enough for idle kill, or first visit)
      clearLiveSession();
      const hasCreds = !!(secret?.apiToken || secret?.apiKey || prefs.username);
      if (!cancelled) {
        if (hasCreds || prefs.localBackendUrl || prefs.mode) {
          setPhase("setup");
          setMessages((m) =>
            m.length
              ? m
              : [
                  sysLine(
                    "no live session · launch kaggle once (refresh will reconnect automatically)"
                  ),
                ]
          );
        }
        setProgressMsg(null);
        setRestoring(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [vaultGate]);

  // Encrypted chat persistence
  useEffect(() => {
    if (vaultGate !== "ready" || !isUnlocked()) return;
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
  }, [messages, backendUrl, session?.kernel_ref, vaultGate]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Health poll
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
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
        if (cancelled) return;
        setIsOnline(res.ok);
        if (res.ok) {
          const data = (await res.json()) as {
            model_ready?: boolean;
            model_error?: string;
            model?: {
              ready?: boolean;
              name?: string;
              loading?: boolean;
              phase?: string;
              error?: string;
              detail?: string;
            };
          };
          const ready = !!(data.model_ready || data.model?.ready);
          setModelReady(ready);
          if (data.model?.name) setModelName(data.model.name);
          const err =
            data.model_error ||
            data.model?.error ||
            (data.model?.phase === "error" ? data.model?.detail : undefined);
          if (ready) {
            setProgressMsg(null);
          } else if (err) {
            setProgressMsg(
              err.includes("GLIBC")
                ? "engine incompatible (GLIBC) — relaunch"
                : `model error: ${err.slice(0, 120)}`
            );
          } else if (data.model?.loading || data.model?.phase) {
            setProgressMsg(
              data.model?.detail ||
                data.model?.phase ||
                "loading model…"
            );
          }
        }
      } catch {
        if (!cancelled) setIsOnline(false);
      }
    };
    check();
    const interval = setInterval(check, modelReady ? 10000 : 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [backendUrl, modelReady]);

  // Heartbeat + keep session bookmark fresh for refresh-reconnect
  useEffect(() => {
    if (!backendUrl || isOnline === false) return;
    const beat = () => {
      const base = backendUrlRef.current.replace(/\/$/, "");
      if (!base) return;
      pokeHeartbeat(base);
      const isTunnel =
        /trycloudflare\.com|loca\.lt|localtunnel\.me|bore\.pub/i.test(base);
      saveLiveSession({
        backendUrl: base,
        phase: isTunnel ? "kaggle" : "local",
        savedAt: Date.now(),
      });
    };
    beat();
    // 12s — well under default 90s idle
    const interval = setInterval(beat, 12000);
    return () => clearInterval(interval);
  }, [backendUrl, isOnline]);

  // Refresh must NOT kill Kaggle. Only tab close stops heartbeats → idle kill.
  // On pagehide we only refresh sessionStorage bookmark (no /session/detach).
  useEffect(() => {
    const onPageHide = () => {
      if (intentionalStopRef.current) return;
      const url = backendUrlRef.current;
      if (!url) return;
      const isTunnel =
        /trycloudflare\.com|loca\.lt|localtunnel\.me|bore\.pub/i.test(url);
      saveLiveSession({
        backendUrl: url,
        phase: isTunnel ? "kaggle" : "local",
        savedAt: Date.now(),
      });
      // One last heartbeat so a quick refresh doesn't trip idle timeout
      pokeHeartbeat(url);
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  const finishVaultCreate = async () => {
    setVaultError(null);
    try {
      if (vaultModeChoice === "passphrase") {
        if (passphrase.length < 8) {
          throw new Error("Passphrase must be at least 8 characters");
        }
        if (passphrase !== passphrase2) {
          throw new Error("Passphrases do not match");
        }
        await createVault({ mode: "passphrase", passphrase });
      } else {
        await createVault({ mode: "device" });
      }
      setPassphrase("");
      setPassphrase2("");
      savePrefs({ vaultMode: vaultModeChoice });
      setVaultGate("ready");
    } catch (e) {
      setVaultError(e instanceof Error ? e.message : String(e));
    }
  };

  const finishVaultUnlock = async () => {
    setVaultError(null);
    try {
      if (lockedVaultMode === "device") {
        await unlockDeviceVault();
      } else {
        await unlockWithPassphrase(passphrase);
        setPassphrase("");
      }
      await migrateLegacyIfNeeded();
      setVaultGate("ready");
    } catch (e) {
      setVaultError(e instanceof Error ? e.message : String(e));
    }
  };

  const attachLocal = async () => {
    setSessionError(null);
    setSessionBusy(true);
    try {
      const url = localUrl.trim().replace(/\/$/, "");
      if (!url) throw new Error("Enter a backend URL");
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("Backend URL must be http(s)");
      }
      const res = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(8000),
        referrerPolicy: "no-referrer",
      });
      if (!res.ok) throw new Error(`Health check failed (${res.status})`);
      const data = await res.json();
      setBackendUrl(url);
      setModelReady(!!data.model_ready);
      setModelName(data.model?.name || null);
      setIsOnline(true);
      setPhase("local");
      setShowSettings(false);
      setMessages((m) => [
        ...m,
        sysLine(`attached local · ${url}`),
      ]);
      savePrefs({
        mode: "local",
        localBackendUrl: url,
        lastBackendUrl: url,
      });
      saveLiveSession({
        backendUrl: url,
        phase: "local",
        savedAt: Date.now(),
      });
    } catch (e) {
      setSessionError(
        e instanceof Error
          ? e.message
          : "Could not reach local backend"
      );
    } finally {
      setSessionBusy(false);
    }
  };

  const onLaunchProgress = useCallback(
    (p: LaunchProgress) => {
      setProgressMsg(p.message || null);
      if (p.state === "retrying_cpu") setAccelerator("cpu");
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
    },
    [username, idleTimeout, maxLifetime]
  );

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
        rememberCredentials: rememberCreds,
      });

      if (rememberCreds && isUnlocked()) {
        await saveSecret({
          username: username.trim(),
          apiToken: apiToken.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
        });
        setHasStoredCreds(true);
      }

      setMessages((m) => [...m, sysLine("launching kaggle worker…")]);

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
      setProgressMsg("backend online — loading model…");
      setIsOnline(true);
      setModelReady(false);
      setMessages((m) => [
        ...m,
        sysLine(`online · ${result.publicUrl.replace(/^https?:\/\//, "")}`),
      ]);
      savePrefs({
        lastBackendUrl: result.publicUrl,
        accelerator: result.accelerator,
        mode: "kaggle",
      });
      // Survives page refresh in this tab — no need to click Launch again
      saveLiveSession({
        backendUrl: result.publicUrl,
        phase: "kaggle",
        kernelRef: result.kernelRef,
        accelerator: result.accelerator,
        savedAt: Date.now(),
      });
      pokeHeartbeat(result.publicUrl);

      void waitForBackendHealth(result.publicUrl, {
        timeoutMs: 600_000,
        signal: ac.signal,
      })
        .then((h) => {
          if (h.online) setIsOnline(true);
          if (h.model_ready) {
            setModelReady(true);
            setProgressMsg(null);
            setMessages((m) => [...m, sysLine("model ready")]);
          } else if (h.online) {
            setProgressMsg("backend up; model still loading…");
          }
        })
        .catch(() => {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== "aborted" && msg !== "Launch aborted") {
        setSessionError(msg);
        setMessages((m) => [...m, sysLine(`launch failed · ${msg}`)]);
      }
      setSession(null);
    } finally {
      setSessionBusy(false);
    }
  };

  const stopSession = async () => {
    setSessionBusy(true);
    intentionalStopRef.current = true;
    try {
      abortRef.current?.abort();
      if (backendUrl) {
        await fetch(`${backendUrl.replace(/\/$/, "")}/session/shutdown`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "user_stop" }),
          referrerPolicy: "no-referrer",
        }).catch(() => {});
      }
      setSession((s) => (s ? { ...s, state: "stopped" } : s));
      setIsOnline(false);
      setBackendUrl("");
      setModelReady(false);
      setModelName(null);
      setMessages((m) => [...m, sysLine("session stopped")]);
      clearLiveSession();
      savePrefs({ lastBackendUrl: undefined });
    } finally {
      setSessionBusy(false);
      setTimeout(() => {
        intentionalStopRef.current = false;
      }, 2000);
    }
  };

  const clearChat = () => {
    setMessages([sysLine("chat cleared")]);
    void saveChat({
      id: chatIdRef.current,
      messages: [],
      updated_at: Date.now(),
    });
  };

  const forgetCredentials = async () => {
    await clearSecret();
    setApiToken("");
    setApiKey("");
    setHasStoredCreds(false);
  };

  const fetchModels = async () => {
    if (!backendUrl) return;
    setModelsLoading(true);
    try {
      const res = await fetch(`${backendUrl.replace(/\/$/, "")}/models`, {
        signal: AbortSignal.timeout(60000),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (!res.ok) throw new Error(`models ${res.status}`);
      const data = (await res.json()) as {
        options?: ModelOption[];
        hardware?: { type?: string; total_gb?: number; free_gb?: number };
        current?: { name?: string; ready?: boolean };
      };
      setModelOptions(data.options || []);
      if (data.hardware) {
        setModelHw(
          `${data.hardware.type || "hw"} · ${data.hardware.total_gb?.toFixed?.(1) ?? "?"} GB`
        );
      }
      if (data.current?.name) setModelName(data.current.name);
    } catch (e) {
      setSessionError(
        e instanceof Error ? e.message : "Could not list models"
      );
    } finally {
      setModelsLoading(false);
    }
  };

  const openModelPicker = async () => {
    setShowModels(true);
    await fetchModels();
  };

  const switchToModel = async (opt: ModelOption) => {
    if (!backendUrl || modelSwitching) return;
    if (!opt.fits) {
      const ok = confirm(
        `${opt.name} needs ~${opt.required_ram_gb} GB RAM and may not fit. Try anyway? (previous model will be unloaded + GC first)`
      );
      if (!ok) return;
    }
    setModelSwitching(true);
    setModelReady(false);
    setProgressMsg(`switching → ${opt.name} (unload + GC)…`);
    setMessages((m) => [
      ...m,
      sysLine(`model switch → ${opt.name} · unload + GC first`),
    ]);
    try {
      const res = await fetch(`${backendUrl.replace(/\/$/, "")}/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_id: opt.repo_id,
          filename: opt.filename,
          n_ctx: opt.safe_ctx,
        }),
        referrerPolicy: "no-referrer",
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        model?: { name?: string; ready?: boolean };
      };
      if (!data.ok) {
        throw new Error(data.error || "load failed");
      }
      setModelReady(!!data.model?.ready);
      setModelName(data.model?.name || opt.name);
      setProgressMsg(null);
      setMessages((m) => [
        ...m,
        sysLine(`model loaded · ${data.model?.name || opt.name}`),
      ]);
      setShowModels(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProgressMsg(`switch failed: ${msg.slice(0, 100)}`);
      setMessages((m) => [...m, sysLine(`model switch failed · ${msg}`)]);
    } finally {
      setModelSwitching(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    if (!backendUrl) {
      setMessages((prev) => [
        ...prev,
        { role: "user", content: input, ts: Date.now() },
        sysLine("no backend · open settings → Launch Kaggle or attach local"),
      ]);
      setInput("");
      setShowSettings(true);
      return;
    }

    const userMsg: Message = {
      role: "user",
      content: input,
      ts: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: "…",
        thoughts: [],
        ts: Date.now(),
      },
    ]);

    const base = backendUrl.replace(/\/$/, "");
    const updateLastAssistant = (patch: Partial<Message>) => {
      setMessages((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].role === "assistant") {
            next[i] = { ...next[i], ...patch };
            break;
          }
        }
        return next;
      });
    };

    try {
      const response = await fetch(`${base}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson, application/json",
        },
        body: JSON.stringify({
          messages: [...messages, userMsg]
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              role: m.role,
              content: m.content,
            })),
        }),
        referrerPolicy: "no-referrer",
      });

      if (!response.ok) throw new Error(`Backend returned ${response.status}`);

      const ctype = (response.headers.get("content-type") || "").toLowerCase();
      let data: { response?: string; thought_process?: string[] };

      if (ctype.includes("ndjson") || ctype.includes("stream")) {
        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");
        const decoder = new TextDecoder();
        let buf = "";
        const thoughts: string[] = [];
        let final: { response?: string; thought_process?: string[] } | null =
          null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let evt: {
              type?: string;
              message?: string;
              response?: string;
              thought_process?: string[];
            };
            try {
              evt = JSON.parse(trimmed);
            } catch {
              continue;
            }
            if (evt.type === "status" && evt.message) {
              thoughts.push(evt.message);
              updateLastAssistant({
                content: evt.message,
                thoughts: [...thoughts],
              });
            } else if (evt.type === "ping") {
              updateLastAssistant({
                content: thoughts.length
                  ? `${thoughts[thoughts.length - 1]} · …`
                  : "…",
                thoughts: [...thoughts],
              });
            } else if (evt.type === "done") {
              final = {
                response: evt.response,
                thought_process: evt.thought_process ?? thoughts,
              };
            }
          }
        }
        if (!final?.response) throw new Error("Stream ended without a reply");
        data = final;
      } else {
        data = (await response.json()) as {
          response?: string;
          thought_process?: string[];
        };
      }

      updateLastAssistant({
        content: data.response || "(empty)",
        thoughts: data.thought_process,
        ts: Date.now(),
      });
    } catch (err) {
      let stillUp = false;
      try {
        const h = await fetch(`${base}/health`, {
          signal: AbortSignal.timeout(5000),
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
        stillUp = h.ok;
      } catch {
        stillUp = false;
      }
      const detail =
        err instanceof Error && err.message ? ` (${err.message})` : "";
      updateLastAssistant({
        content: stillUp
          ? `reply interrupted${detail}. backend still online — try again or /code for harness`
          : "connection error — session may be gone. settings → relaunch",
        ts: Date.now(),
      });
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  };

  const statusKind =
    isOnline && modelReady
      ? "online"
      : isOnline
        ? "booting"
        : backendUrl
          ? "offline"
          : "offline";

  const configured =
    hasStoredCreds ||
    !!(username && (apiToken || apiKey)) ||
    !!loadPrefs().localBackendUrl;

  // ── Vault gates ─────────────────────────────────────────────────────────
  if (vaultGate === "loading" || (vaultGate === "ready" && restoring)) {
    return (
      <div className="er-shell min-h-screen flex flex-col items-center justify-center text-sm gap-3">
        <div className="er-logo">EDGERUNNER</div>
        <div className="flex items-center gap-2 text-[var(--cyan)]">
          <Loader2 className="animate-spin" size={16} />
          <span className="er-logo-sub">jacking into vault…</span>
        </div>
      </div>
    );
  }

  if (vaultGate === "signin" || vaultGate === "create") {
    return (
      <div className="er-shell min-h-screen flex flex-col text-sm">
        <div className="er-hazard" />
        <header className="er-header flex items-center gap-3 px-5 py-4">
          <span className="er-logo">EDGERUNNER</span>
          <span className="er-logo-sub">// night city</span>
        </header>
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-sm space-y-5 er-panel er-panel-hot er-clip p-6 text-center">
            <div className="er-hero-tag mx-auto">SECURE SESSION</div>
            <h1 className="er-logo" style={{ fontSize: "1rem", letterSpacing: "0.2em" }}>
              EDGERUNNER
            </h1>
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              Sign in with Google to use EdgeRunner. Your vault, encryption, and
              Kaggle chrome stay protected automatically — no setup screens.
            </p>
            <button
              type="button"
              disabled={googleBusy}
              onClick={() => void handleGoogleSignIn()}
              className="er-btn-cyan w-full py-3 flex items-center justify-center gap-3 text-sm"
            >
              {googleBusy ? (
                <Loader2 size={18} className="animate-spin" />
              ) : (
                <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
                  <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/>
                  <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z"/>
                  <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.2C29.3 35.3 26.8 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/>
                  <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.3 4.1-4.2 5.5l.1.1 6.3 5.2C39.2 37 44 33 44 24c0-1.3-.1-2.3-.4-3.5z"/>
                </svg>
              )}
              {googleBusy ? "Redirecting to Google…" : "Sign in with Google"}
            </button>
            <p className="text-[10px] text-[var(--dim)]">
              You’ll leave this page for Google’s login, then come right back.
            </p>
            {vaultError && (
              <p className="text-xs text-[var(--danger)] border border-[var(--danger)]/40 p-2 text-left">
                {vaultError}
              </p>
            )}
            {!googleConfigured && (
              <p className="text-[10px] text-[var(--warn)] text-left leading-relaxed">
                Site owner: add your Google OAuth Web Client ID to{" "}
                <code className="text-[var(--cyan)]">public/config.json</code> and
                set redirect URI to this site’s URL. End users never see that.
              </p>
            )}
            <button
              type="button"
              className="text-[10px] text-[var(--dim)] hover:text-[var(--muted)] underline"
              onClick={async () => {
                // Escape hatch: local-only without Google
                const exists = await vaultExists();
                if (!exists) await createVault({ mode: "device" });
                else await tryAutoUnlock();
                setVaultGate("ready");
              }}
            >
              continue without Google (this device only)
            </button>
          </div>
        </main>
      </div>
    );
  }

  if (vaultGate === "need_passphrase") {
    return (
      <div className="er-shell min-h-screen flex flex-col text-sm">
        <div className="er-hazard" />
        <header className="er-header flex items-center gap-3 px-5 py-4">
          <span className="er-logo">EDGERUNNER</span>
          <span className="er-logo-sub">// unlock</span>
        </header>
        <main className="flex-1 flex items-center justify-center p-6">
          <div className="w-full max-w-sm space-y-4 er-panel p-5">
            <p className="text-[var(--fg)] flex items-center gap-2">
              <Lock size={14} className="text-[var(--warn)]" /> vault locked
            </p>
            <input
              type={showPass ? "text" : "password"}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void finishVaultUnlock();
              }}
              placeholder="passphrase"
              className="er-input w-full px-3 py-2 text-sm"
              autoFocus
            />
            <button
              type="button"
              onClick={finishVaultUnlock}
              className="er-btn-primary w-full py-2.5"
            >
              unlock
            </button>
            <button
              type="button"
              disabled={googleBusy}
              onClick={() => void handleGoogleSignIn()}
              className="er-btn-cyan w-full py-2"
            >
              Sign in with Google instead
            </button>
            {vaultError && (
              <p className="text-xs text-[var(--danger)]">{vaultError}</p>
            )}
          </div>
        </main>
      </div>
    );
  }

  // ── Main CLI shell (always — setup is a panel, not a dead-end page) ─────
  return (
    <div className="er-shell min-h-screen flex flex-col text-sm">
      <div className="er-hazard shrink-0" />
      {/* Title bar */}
      <header className="er-header flex items-center gap-3 px-3 sm:px-4 py-2.5 shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="er-logo shrink-0">EDGERUNNER</span>
          <span className="text-[var(--dim)] hidden sm:inline">│</span>
          <span className="er-logo-sub truncate hidden sm:inline">
            night city · agent harness
          </span>
        </div>
        <div className="flex items-center gap-2 sm:gap-3 text-xs shrink-0">
          <span className="flex items-center gap-1.5 text-[var(--muted)]">
            <span className={`er-status-dot ${statusKind}`} />
            {isOnline && modelReady
              ? "ready"
              : isOnline
                ? "booting"
                : backendUrl
                  ? "down"
                  : "idle"}
          </span>
          {modelName && (
            <button
              type="button"
              onClick={() => void openModelPicker()}
              className="hidden sm:inline text-[var(--info)] hover:underline truncate max-w-[10rem]"
              title="Switch model"
            >
              {modelName}
            </button>
          )}
          {backendUrl && (
            <button
              type="button"
              onClick={() => void openModelPicker()}
              className="er-btn-cyan px-2 py-0.5"
              title="Models"
            >
              model
            </button>
          )}
          {backendUrl && (
            <button
              type="button"
              onClick={() => void stopSession()}
              disabled={sessionBusy}
              className="er-btn-danger px-2 py-0.5"
              title="Stop Kaggle session"
            >
              <Square size={12} className="inline" /> stop
            </button>
          )}
          {googleUser && (
            <span
              className="hidden md:inline text-[10px] text-[var(--cyan)] truncate max-w-[8rem]"
              title={googleUser.email}
            >
              {googleUser.email}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="er-btn-ghost p-1"
            title="Settings"
          >
            <Settings2 size={15} />
          </button>
        </div>
      </header>

      {/* Status strip */}
      {(progressMsg || sessionBusy) && (
        <div className="er-status-strip px-4 py-1.5 text-xs flex items-center gap-2">
          <Loader2 size={12} className="animate-spin shrink-0" />
          <span className="truncate uppercase tracking-wider text-[10px]">
            {progressMsg || "working…"}
          </span>
        </div>
      )}

      {/* Transcript */}
      <main className="flex-1 overflow-y-auto px-3 sm:px-6 py-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-[var(--muted)] text-xs space-y-2 pt-10 max-w-xl">
            <div className="er-hero-tag">CHOOMS · NETRUNNERS · ONLY</div>
            <p className="text-[var(--fg)] text-sm">
              <span className="er-prompt-char">›</span>{" "}
              <span className="er-logo" style={{ letterSpacing: "0.15em", fontSize: "0.85rem" }}>
                EDGERUNNER
              </span>{" "}
              <span className="text-[var(--cyan)]">agent net</span>
            </p>
            <p className="pl-3">
              jack in · chat casually · prefix coding with{" "}
              <code className="text-[var(--accent)]">/code</code>
            </p>
            <p className="pl-3 text-[var(--dim)]">
              {configured
                ? "chrome saved — settings only when you need a new run"
                : "open settings to launch Kaggle or attach local chrome"}
            </p>
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === "system") {
            return (
              <div key={i} className="er-sys-line flex gap-2 items-start">
                <span className="er-sys-char">#</span>
                <span>{m.content}</span>
              </div>
            );
          }
          if (m.role === "user") {
            return (
              <div key={i} className="flex gap-2 items-start">
                <span className="er-prompt-char shrink-0">›</span>
                <div className="er-user-line whitespace-pre-wrap break-words flex-1">
                  {m.content}
                </div>
              </div>
            );
          }
          return (
            <div key={i} className="flex gap-2 items-start">
              <span className="er-reply-char shrink-0">‹</span>
              <div className="flex-1 min-w-0">
                {m.thoughts && m.thoughts.length > 0 && (
                  <details className="mb-1 text-xs text-[var(--muted)]">
                    <summary className="cursor-pointer hover:text-[var(--fg)]">
                      trace ({m.thoughts.length})
                    </summary>
                    <pre className="mt-1 whitespace-pre-wrap text-[10px] text-[var(--dim)] border-l border-[var(--border)] pl-2">
                      {m.thoughts.join("\n")}
                    </pre>
                  </details>
                )}
                <div className="er-md text-[var(--fg)]">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </main>

      {/* Composer */}
      <footer className="er-footer p-3 shrink-0">
        {!backendUrl && (
          <div className="mb-2 flex flex-wrap gap-2 text-xs">
            {hasStoredCreds || username ? (
              <button
                type="button"
                disabled={sessionBusy}
                onClick={() => void launchKaggle()}
                className="er-btn-primary px-3 py-1.5"
              >
                {sessionBusy ? "jacking in…" : "▶ launch kaggle"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="er-btn px-3 py-1.5"
              >
                configure chrome
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setSetupTab("local");
                setShowSettings(true);
              }}
              className="er-btn px-3 py-1.5"
            >
              local
            </button>
          </div>
        )}
        <div className="flex gap-2 items-end max-w-4xl mx-auto">
          <span className="er-prompt-char pb-2.5 shrink-0">›</span>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={1}
            placeholder={
              backendUrl
                ? modelReady
                  ? "message · /code for harness · shift+enter newline"
                  : "backend up — model still loading…"
                : "launch a session first…"
            }
            disabled={isLoading || modelSwitching}
            className="flex-1 bg-transparent border-0 outline-none resize-none text-sm text-[var(--fg)] placeholder:text-[var(--dim)] max-h-32 py-2 caret-[var(--warn)]"
          />
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={isLoading || !input.trim()}
            className="p-2 text-[var(--accent)] disabled:text-[var(--dim)] hover:drop-shadow-[0_0_8px_var(--accent-glow)]"
          >
            {isLoading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Send size={16} />
            )}
          </button>
        </div>
        <div className="flex justify-between mt-1 text-[10px] text-[var(--dim)] max-w-4xl mx-auto px-5">
          <span>
            {phase !== "setup" ? phase : "—"}
            {session?.accelerator ? ` · ${session.accelerator}` : ""}
          </span>
          <button
            type="button"
            onClick={clearChat}
            className="hover:text-[var(--muted)]"
          >
            clear
          </button>
        </div>
      </footer>

      {/* Settings drawer */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60">
          <button
            type="button"
            className="flex-1"
            aria-label="Close"
            onClick={() => setShowSettings(false)}
          />
          <aside className="er-drawer w-full max-w-md h-full overflow-y-auto p-4 space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <span className="er-logo" style={{ fontSize: "0.65rem" }}>
                SETTINGS
              </span>
              <button
                type="button"
                onClick={() => setShowSettings(false)}
                className="text-[var(--muted)] hover:text-[var(--fg)]"
              >
                <X size={16} />
              </button>
            </div>

            {/* Google account */}
            <div className="space-y-2 border border-[var(--border)] p-3">
              <div className="text-[var(--warn)] tracking-wider text-[10px]">
                ACCOUNT
              </div>
              {googleUser ? (
                <div className="space-y-2">
                  <p className="text-[var(--cyan)] truncate">{googleUser.email}</p>
                  <p className="text-[10px] text-[var(--muted)]">
                    Signed in. Credentials sync across your devices automatically when you save them.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={googleBusy}
                      onClick={() => void (async () => {
                        setGoogleBusy(true);
                        try {
                          await runGoogleSync();
                        } catch (e) {
                          setSessionError(e instanceof Error ? e.message : String(e));
                        } finally {
                          setGoogleBusy(false);
                        }
                      })()}
                      className="er-btn-cyan flex-1 py-1.5"
                    >
                      {googleBusy ? "syncing…" : "sync now"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        signOutGoogle();
                        setGoogleUser(null);
                        setGoogleMsg(null);
                        setVaultGate("signin");
                      }}
                      className="er-btn flex-1 py-1.5"
                    >
                      sign out
                    </button>
                  </div>
                  {googleMsg && (
                    <p className="text-[10px] text-[var(--accent)]">{googleMsg}</p>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  disabled={googleBusy}
                  onClick={() => void handleGoogleSignIn()}
                  className="er-btn-cyan w-full py-2"
                >
                  Sign in with Google
                </button>
              )}
            </div>

            <div className="er-tabs">
              <button
                type="button"
                onClick={() => setSetupTab("kaggle")}
                className={`er-tab ${setupTab === "kaggle" ? "active" : ""}`}
              >
                kaggle
              </button>
              <button
                type="button"
                onClick={() => setSetupTab("local")}
                className={`er-tab ${setupTab === "local" ? "active" : ""}`}
              >
                local
              </button>
            </div>

            {setupTab === "kaggle" ? (
              <div className="space-y-3">
                {hasStoredCreds && (
                  <div className="flex items-center justify-between text-[var(--accent)] border border-[var(--accent)]/40 px-2 py-1.5 shadow-[0_0_12px_var(--accent-glow)]">
                    <span className="flex items-center gap-1">
                      <Shield size={12} /> credentials saved
                    </span>
                    <button
                      type="button"
                      onClick={forgetCredentials}
                      className="text-[var(--muted)] hover:text-[var(--danger)]"
                    >
                      forget
                    </button>
                  </div>
                )}
                <label className="block text-[var(--muted)]">
                  username
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="er-input mt-1 w-full px-2 py-2"
                  />
                </label>
                <label className="block text-[var(--muted)]">
                  api token
                  <input
                    type="password"
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    placeholder={hasStoredCreds ? "•••• saved" : "KGAT_…"}
                    className="er-input mt-1 w-full px-2 py-2"
                  />
                </label>
                <label className="block text-[var(--muted)]">
                  legacy key (optional)
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="er-input mt-1 w-full px-2 py-2"
                  />
                </label>
                <div className="flex gap-2">
                  {(["gpu", "cpu"] as const).map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setAccelerator(a)}
                      className={`flex-1 py-1.5 er-btn uppercase tracking-wider ${
                        accelerator === a
                          ? "border-[var(--warn)] text-[var(--warn)] shadow-[0_0_10px_rgba(249,240,2,0.3)]"
                          : ""
                      }`}
                    >
                      {a}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={fallbackCpu}
                    onChange={(e) => setFallbackCpu(e.target.checked)}
                  />
                  cpu fallback if gpu busy
                </label>
                <label className="flex items-center gap-2 text-[var(--muted)]">
                  <input
                    type="checkbox"
                    checked={rememberCreds}
                    onChange={(e) => setRememberCreds(e.target.checked)}
                  />
                  remember credentials (encrypted)
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[var(--muted)]">
                    idle kill (s)
                    <input
                      type="number"
                      value={idleTimeout}
                      onChange={(e) => setIdleTimeout(Number(e.target.value))}
                      className="er-input mt-1 w-full px-2 py-1.5"
                    />
                  </label>
                  <label className="text-[var(--muted)]">
                    max life (s)
                    <input
                      type="number"
                      value={maxLifetime}
                      onChange={(e) => setMaxLifetime(Number(e.target.value))}
                      className="er-input mt-1 w-full px-2 py-1.5"
                    />
                  </label>
                </div>
                <p className="text-[var(--dim)] leading-relaxed">
                  refresh auto-reconnects (no re-launch). stop / close tab +
                  idle timeout kills Kaggle.
                </p>
                <button
                  type="button"
                  disabled={sessionBusy}
                  onClick={() => void launchKaggle()}
                  className="er-btn-primary w-full py-2.5 disabled:opacity-50"
                >
                  {sessionBusy ? "jacking in…" : "launch kaggle"}
                </button>
                {sessionError && (
                  <p className="text-[var(--danger)]">{sessionError}</p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <label className="block text-[var(--muted)]">
                  backend url
                  <input
                    value={localUrl}
                    onChange={(e) => setLocalUrl(e.target.value)}
                    className="er-input mt-1 w-full px-2 py-2"
                  />
                </label>
                <button
                  type="button"
                  disabled={sessionBusy}
                  onClick={() => void attachLocal()}
                  className="er-btn-primary w-full py-2.5"
                >
                  attach
                </button>
                {sessionError && (
                  <p className="text-[var(--danger)]">{sessionError}</p>
                )}
              </div>
            )}

            {backendUrl && (
              <div className="pt-2 border-t border-[var(--border)] space-y-2">
                <p className="text-[var(--muted)] break-all">
                  backend: {backendUrl}
                </p>
                <button
                  type="button"
                  onClick={() => void openModelPicker()}
                  className="er-btn-cyan w-full py-2"
                >
                  choose model
                </button>
              </div>
            )}
          </aside>
        </div>
      )}

      {/* Model picker */}
      {showModels && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4">
          <div className="er-modal w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col rounded-t-sm sm:rounded-sm">
            <div className="er-modal-head flex items-center justify-between px-4 py-3">
              <div>
                <div className="er-logo" style={{ fontSize: "0.65rem" }}>
                  MODELS
                </div>
                <div className="text-[10px] text-[var(--cyan)] mt-0.5">
                  {modelHw || "scanning chrome…"} · no max-GB · unload+GC on switch
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowModels(false)}
                className="text-[var(--muted)] hover:text-[var(--fg)]"
              >
                <X size={16} />
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-2 space-y-1">
              {modelsLoading && (
                <div className="flex items-center gap-2 p-4 text-[var(--muted)] text-xs">
                  <Loader2 size={14} className="animate-spin" /> fetching
                  options…
                </div>
              )}
              {modelSwitching && (
                <div className="p-2 text-xs text-[var(--warn)] border border-[var(--warn)]/30 rounded mb-2">
                  unloading previous model + GC, then loading…
                </div>
              )}
              {!modelsLoading &&
                modelOptions.map((opt) => (
                  <button
                    key={`${opt.repo_id}/${opt.filename}`}
                    type="button"
                    disabled={modelSwitching}
                    onClick={() => void switchToModel(opt)}
                    className={`er-model-card w-full text-left px-3 py-2.5 text-xs ${
                      opt.fits ? "fits" : "opacity-60"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[var(--fg)] truncate font-medium">
                        {opt.name}
                      </span>
                      <ChevronRight
                        size={12}
                        className="text-[var(--dim)] shrink-0"
                      />
                    </div>
                    <div className="text-[var(--muted)] mt-0.5 flex flex-wrap gap-x-2">
                      <span>
                        {opt.file_size_gb} GB disk · ~{opt.required_ram_gb} GB
                        ram
                      </span>
                      <span
                        className={
                          opt.fits ? "text-[var(--accent)]" : "text-[var(--danger)]"
                        }
                      >
                        {opt.fit_status}
                      </span>
                      {opt.sharded && (
                        <span className="text-[var(--warn)]">sharded</span>
                      )}
                    </div>
                    <div className="text-[10px] text-[var(--dim)] truncate mt-0.5">
                      {opt.repo_id} / {opt.filename}
                    </div>
                  </button>
                ))}
              {!modelsLoading && modelOptions.length === 0 && (
                <p className="p-4 text-[var(--muted)] text-xs">
                  no options — is the backend online?
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
