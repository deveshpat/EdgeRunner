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
  Terminal,
  FolderOpen,
  Plus,
  RotateCcw,
} from "lucide-react";
import { LogoBox } from "@/components/LogoBox";
import { SessionHub } from "@/components/SessionHub";
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
  onLiveSessionChange,
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
  discoverActiveBackend,
  discoverNote,
} from "@/lib/session-discover";
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
import {
  expandTemplate,
  filterCommands,
  helpText,
  parseSlash,
  type AgentMode,
} from "@/lib/commands";
import {
  loadUiPrefs,
  saveUiPrefs,
  type UiPrefs,
  type UiView,
} from "@/lib/ui-prefs";

const CHAT_KEY = "current";

type VaultGate = "loading" | "ready" | "signin" | "need_passphrase" | "create";

function sysLine(content: string): Message {
  return { role: "system", content, ts: Date.now() };
}

function exportMarkdown(msgs: Message[]): string {
  const lines = ["# EdgeRunner session\n"];
  for (const m of msgs) {
    if (m.role === "system") lines.push(`> ${m.content}\n`);
    else if (m.role === "user") lines.push(`## User\n\n${m.content}\n`);
    else lines.push(`## Assistant\n\n${m.content}\n`);
  }
  return lines.join("\n");
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
  // Prefer dual T4 (more VRAM than default P100 when Kaggle allows it)
  const [accelerator, setAccelerator] = useState<Accelerator>("t4x2");
  const [idleTimeout, setIdleTimeout] = useState(90);
  const [maxLifetime, setMaxLifetime] = useState(3600);
  const [fallbackCpu, setFallbackCpu] = useState(true);
  const [rememberCreds, setRememberCreds] = useState(true);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);

  // OpenCode-inspired UI prefs (CLI view, agent mode, thinking/details)
  const [uiPrefs, setUiPrefs] = useState<UiPrefs>(() => loadUiPrefs());
  const [cmdSuggest, setCmdSuggest] = useState<string[]>([]);
  const undoStackRef = useRef<Message[][]>([]);
  const redoStackRef = useRef<Message[][]>([]);
  /** boot splash → hub (continue/new) → terminal */
  const [bootDone, setBootDone] = useState(false);
  const [appStage, setAppStage] = useState<"hub" | "terminal">("hub");

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionRef = useRef<SessionInfo | null>(null);
  const backendUrlRef = useRef(backendUrl);
  const abortRef = useRef<AbortController | null>(null);
  const chatIdRef = useRef(CHAT_KEY);
  const intentionalStopRef = useRef(false);

  const patchUi = useCallback((patch: Partial<UiPrefs>) => {
    setUiPrefs(saveUiPrefs(patch));
  }, []);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    backendUrlRef.current = backendUrl;
  }, [backendUrl]);

  // Boxed logo splash (CLI harness init)
  useEffect(() => {
    const t = setTimeout(() => setBootDone(true), 900);
    return () => clearTimeout(t);
  }, []);

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
            if (!cancelled) {
              setVaultGate("ready");
              // Pull cloud vault if signed in (multi-device)
              if (isGoogleSignedIn()) {
                setTimeout(() => {
                  void runGoogleSync().catch(() => {});
                }, 0);
              }
            }
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
    // After cloud prefs/secret land, attach any running backend (other device)
    try {
      if (backendUrlRef.current) {
        const alive = await probeBackend(backendUrlRef.current, {
          retries: 1,
          timeoutMs: 4000,
        });
        if (alive.ok) {
          setProgressMsg(null);
          return result;
        }
      }
      setProgressMsg("discovering backend after Google sync…");
      const found = await discoverActiveBackend({
        onProgress: (msg) => setProgressMsg(msg),
      });
      if (found) {
        setBackendUrl(found.backendUrl);
        setIsOnline(true);
        setModelReady(found.modelReady);
        setModelName(found.modelName);
        setPhase(found.phase);
        setProgressMsg(
          found.modelReady ? null : "backend up; model still loading…"
        );
        if (found.accelerator) setAccelerator(found.accelerator);
        setAppStage("terminal");
        setMessages((m) => [...m, sysLine(discoverNote(found))]);
      } else {
        setProgressMsg(null);
      }
    } catch {
      setProgressMsg(null);
    }
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

      // Cross-device discovery (skip if this tab already has a healthy backend)
      if (backendUrlRef.current) {
        const already = await probeBackend(backendUrlRef.current, {
          retries: 1,
          timeoutMs: 4000,
        });
        if (already.ok && !cancelled) {
          setIsOnline(true);
          setModelReady(already.model_ready);
          if (already.modelName) setModelName(already.modelName);
          setProgressMsg(null);
          setRestoring(false);
          return;
        }
      }
      //  1) Google-synced / local prefs URL
      //  2) Kaggle API with same API key (works without Google)
      setProgressMsg("discovering active backend…");
      try {
        const found = await discoverActiveBackend({
          form: {
            username: secret?.username || prefs.username || username,
            apiToken: secret?.apiToken || apiToken,
            apiKey: secret?.apiKey || apiKey,
          },
          hintUrl: loadLiveSession()?.backendUrl || prefs.lastBackendUrl,
          onProgress: (msg) => {
            if (!cancelled) setProgressMsg(msg);
          },
        });
        if (found && !cancelled) {
          setBackendUrl(found.backendUrl);
          setIsOnline(true);
          setModelReady(found.modelReady);
          setModelName(found.modelName);
          setPhase(found.phase);
          setProgressMsg(
            found.modelReady ? null : "backend up; model still loading…"
          );
          if (found.accelerator) setAccelerator(found.accelerator);
          setMessages((m) => {
            const line = sysLine(discoverNote(found));
            if (!m.length) return [line];
            if (m.some((x) => x.content === line.content)) return m;
            return [...m, line];
          });
          setAppStage("terminal");
          setRestoring(false);
          return;
        }
      } catch {
        /* no active backend */
      }

      // Nothing live
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
                    "no live session · launch once; other devices with the same Kaggle API key (or Google sync) will attach automatically"
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

  // Heartbeat + keep session bookmark fresh (shared localStorage for all tabs)
  useEffect(() => {
    if (!backendUrl || isOnline === false) return;
    const beat = () => {
      const base = backendUrlRef.current.replace(/\/$/, "");
      if (!base) return;
      pokeHeartbeat(base);
      const isTunnel =
        /trycloudflare\.com|loca\.lt|localtunnel\.me|bore\.pub/i.test(base);
      const prev = loadLiveSession();
      saveLiveSession({
        backendUrl: base,
        phase: isTunnel ? "kaggle" : "local",
        kernelRef: prev?.kernelRef || sessionRef.current?.kernel_ref,
        accelerator:
          sessionRef.current?.accelerator || prev?.accelerator || accelerator,
        savedAt: Date.now(),
      });
    };
    beat();
    // 12s — well under default 90s idle; any open tab keeps the worker alive
    const interval = setInterval(beat, 12000);
    return () => clearInterval(interval);
  }, [backendUrl, isOnline, accelerator]);

  // Other tabs: pick up URL when they launch / attach (no spam if same URL)
  useEffect(() => {
    return onLiveSessionChange((s) => {
      if (!s?.backendUrl) return;
      const url = s.backendUrl.replace(/\/$/, "");
      if (backendUrlRef.current === url) return;
      if (intentionalStopRef.current) return;
      void (async () => {
        const probe = await probeBackend(url, { retries: 2, timeoutMs: 5000 });
        if (!probe.ok) return;
        if (backendUrlRef.current) {
          const cur = await probeBackend(backendUrlRef.current, {
            retries: 1,
            timeoutMs: 3000,
          });
          if (cur.ok) return;
        }
        setBackendUrl(url);
        setIsOnline(true);
        setModelReady(probe.model_ready);
        setModelName(probe.modelName);
        setPhase(s.phase);
        setAppStage("terminal");
        setMessages((m) => {
          const host = url.replace(/^https?:\/\//, "");
          const note = `synced from other tab · ${host}`;
          if (m.some((x) => x.content?.includes("synced from other tab") || x.content?.includes(host)))
            return m;
          return [...m, sysLine(note)];
        });
      })();
    });
  }, []);

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

      setMessages((m) => [
        ...m,
        sysLine("connecting — reuse running worker if present…"),
      ]);

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
      setProgressMsg(
        result.reused
          ? "reused session — checking model…"
          : "backend online — loading model…"
      );
      setIsOnline(true);
      setModelReady(false);
      setMessages((m) => [
        ...m,
        sysLine(
          `${result.reused ? "reused" : "online"} · ${result.accelerator}${
            result.machineShape ? ` (${result.machineShape})` : ""
          } · ${result.publicUrl.replace(/^https?:\/\//, "")}`
        ),
      ]);
      // Shared across tabs + cloud prefs (same backend URL)
      saveLiveSession({
        backendUrl: result.publicUrl,
        phase: "kaggle",
        kernelRef: result.kernelRef,
        accelerator: result.accelerator,
        machineShape: result.machineShape,
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
    undoStackRef.current.push(messages);
    redoStackRef.current = [];
    setMessages([sysLine("session cleared · /help for commands")]);
    void saveChat({
      id: chatIdRef.current,
      messages: [],
      updated_at: Date.now(),
    });
  };

  /** OpenCode-style slash commands handled locally (or rewritten before send). */
  const handleLocalCommand = (name: string, args: string): boolean => {
    switch (name) {
      case "help":
        setMessages((m) => [...m, sysLine(helpText())]);
        return true;
      case "new":
      case "clear":
        clearChat();
        return true;
      case "compact":
      case "summarize": {
        const keep = messages.slice(-6);
        const dropped = Math.max(0, messages.length - keep.length);
        setMessages([
          sysLine(`compacted · dropped ${dropped} older turns (kept last ${keep.length})`),
          ...keep,
        ]);
        return true;
      }
      case "models":
      case "model":
        void openModelPicker();
        return true;
      case "settings":
      case "config":
      case "connect":
        setShowSettings(true);
        return true;
      case "sessions":
      case "resume":
      case "continue":
        setMessages((m) => [
          ...m,
          sysLine(
            [
              `session · phase=${phase}`,
              backendUrl ? `url=${backendUrl}` : "url=(none)",
              modelReady ? `model=${modelName || "ready"}` : "model=loading/offline",
              `agent=${uiPrefs.agentMode}`,
              `view=${uiPrefs.uiView}`,
              session?.accelerator ? `accel=${session.accelerator}` : "",
            ]
              .filter(Boolean)
              .join(" · ")
          ),
        ]);
        return true;
      case "export": {
        const md = exportMarkdown(messages);
        const blob = new Blob([md], { type: "text/markdown" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `edgerunner-${Date.now()}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
        setMessages((m) => [...m, sysLine("exported conversation as markdown")]);
        return true;
      }
      case "undo": {
        // remove last user+assistant pair
        const next = [...messages];
        let removed: Message[] = [];
        // pop trailing assistant then user
        while (next.length && next[next.length - 1].role === "system") {
          removed.unshift(next.pop()!);
        }
        if (next.length && next[next.length - 1].role === "assistant") {
          removed.unshift(next.pop()!);
        }
        if (next.length && next[next.length - 1].role === "user") {
          removed.unshift(next.pop()!);
        }
        if (!removed.length) {
          setMessages((m) => [...m, sysLine("nothing to undo")]);
          return true;
        }
        undoStackRef.current.push(messages);
        redoStackRef.current.push(removed);
        setMessages([...next, sysLine("undo · last turn removed")]);
        return true;
      }
      case "redo": {
        const chunk = redoStackRef.current.pop();
        if (!chunk?.length) {
          setMessages((m) => [...m, sysLine("nothing to redo")]);
          return true;
        }
        setMessages((m) => [
          ...m.filter((x) => !(x.role === "system" && x.content.startsWith("undo"))),
          ...chunk,
          sysLine("redo · turn restored"),
        ]);
        return true;
      }
      case "thinking":
        patchUi({ showThinking: !uiPrefs.showThinking });
        setMessages((m) => [
          ...m,
          sysLine(`thinking traces ${!uiPrefs.showThinking ? "ON" : "OFF"}`),
        ]);
        return true;
      case "details":
        patchUi({ showToolDetails: !uiPrefs.showToolDetails });
        setMessages((m) => [
          ...m,
          sysLine(`tool details ${!uiPrefs.showToolDetails ? "ON" : "OFF"}`),
        ]);
        return true;
      case "cli":
        patchUi({ uiView: "cli" });
        setMessages((m) => [...m, sysLine("view → CLI (terminal)")]);
        return true;
      case "chat":
        patchUi({ uiView: "chat" });
        setMessages((m) => [...m, sysLine("view → chat (markdown)")]);
        return true;
      case "view": {
        const next: UiView = uiPrefs.uiView === "cli" ? "chat" : "cli";
        patchUi({ uiView: next });
        setMessages((m) => [...m, sysLine(`view → ${next}`)]);
        return true;
      }
      case "agent": {
        const a = (args || "").trim().toLowerCase();
        if (a === "plan" || a === "build") {
          patchUi({ agentMode: a as AgentMode });
          setMessages((m) => [...m, sysLine(`agent → ${a}`)]);
        } else {
          setMessages((m) => [
            ...m,
            sysLine(`agent=${uiPrefs.agentMode} · use /agent build | /agent plan`),
          ]);
        }
        return true;
      }
      default:
        return false;
    }
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
    if (isLoading) {
      setMessages((m) => [
        ...m,
        sysLine(
          "model switch blocked · wait for the current chat/agent turn to finish"
        ),
      ]);
      return;
    }
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
    const base = backendUrl.replace(/\/$/, "");
    // Keep tunnel + idle watchdog alive during multi-minute download/load
    const hb = window.setInterval(() => pokeHeartbeat(base), 8000);
    try {
      const res = await fetch(`${base}/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_id: opt.repo_id,
          filename: opt.filename,
          n_ctx: opt.safe_ctx,
        }),
        referrerPolicy: "no-referrer",
        // GGUF download+load can take several minutes on Kaggle
        signal: AbortSignal.timeout(15 * 60_000),
      });
      let data: {
        ok?: boolean;
        error?: string;
        model?: { name?: string; ready?: boolean };
      };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        throw new Error(
          res.ok
            ? "invalid JSON from /models/load"
            : `HTTP ${res.status} (empty body — tunnel may have dropped)`
        );
      }
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
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
      const friendly =
        /failed to fetch|networkerror|load failed|aborted|timeout/i.test(msg)
          ? `${msg} — keep this tab open; if a coding turn was running, wait for it or retry switch`
          : msg;
      setProgressMsg(`switch failed: ${friendly.slice(0, 120)}`);
      setMessages((m) => [...m, sysLine(`model switch failed · ${friendly}`)]);
      // Re-probe: switch may have completed even if the response was lost
      void probeBackend(base, { retries: 2, timeoutMs: 8000 }).then((p) => {
        if (p.ok) {
          setIsOnline(true);
          if (p.model_ready) {
            setModelReady(true);
            if (p.modelName) setModelName(p.modelName);
          }
        } else {
          setIsOnline(false);
        }
      });
    } finally {
      window.clearInterval(hb);
      setModelSwitching(false);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const rawInput = input.trim();
    setCmdSuggest([]);

    // Slash commands (OpenCode-inspired)
    const parsed = parseSlash(rawInput);
    if (parsed.kind === "command") {
      const { command, args } = parsed;
      // Local UI commands
      if (command.kind === "local") {
        setInput("");
        setMessages((prev) => [
          ...prev,
          { role: "user", content: rawInput, ts: Date.now() },
        ]);
        handleLocalCommand(command.name, args);
        return;
      }
      // Prompt / force harness — expand template and continue send
      let outgoing = rawInput;
      if (command.kind === "prompt" && command.template) {
        outgoing = expandTemplate(command.template, args);
      } else if (command.kind === "force_harness") {
        // /code|/build|/plan [task]
        if (command.agent) patchUi({ agentMode: command.agent });
        if (!args) {
          setInput("");
          setMessages((prev) => [
            ...prev,
            { role: "user", content: rawInput, ts: Date.now() },
            sysLine(
              `agent → ${command.agent || "build"} · send a task next (or /${command.name} <task>)`
            ),
          ]);
          return;
        }
        // Prefix so backend resolve_slash / routing treats as harness
        outgoing =
          command.name === "plan"
            ? `plan only: ${args}`
            : args;
      }
      // Fall through with rewritten input
      setInput("");
      await sendToBackend(outgoing, rawInput);
      return;
    }

    if (parsed.kind === "unknown") {
      // Typo/partial like "/sett" — never send to the model
      const hint = parsed.suggestions.length
        ? `did you mean ${parsed.suggestions.map((c) => "/" + c.name).join(" · ")}?`
        : "/help for the list";
      setInput("");
      setMessages((prev) => [
        ...prev,
        { role: "user", content: rawInput, ts: Date.now() },
        sysLine(`unknown command: /${parsed.name} — ${hint}`),
      ]);
      return;
    }

    if (!backendUrl) {
      setMessages((prev) => [
        ...prev,
        { role: "user", content: rawInput, ts: Date.now() },
        sysLine("no backend · open settings → Launch Kaggle or attach local"),
      ]);
      setInput("");
      setShowSettings(true);
      return;
    }

    setInput("");
    await sendToBackend(rawInput, rawInput);
  };

  const sendToBackend = async (content: string, displayContent?: string) => {
    if (!backendUrl) {
      setShowSettings(true);
      return;
    }

    const userMsg: Message = {
      role: "user",
      content: displayContent || content,
      ts: Date.now(),
    };
    // If agent is plan, soft-prefix for backend
    let wireContent = content;
    if (
      uiPrefs.agentMode === "plan" &&
      !/^plan only:/i.test(content) &&
      !content.startsWith("/")
    ) {
      wireContent = `plan only: ${content}`;
    }

    setMessages((prev) => [...prev, userMsg]);
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
    const sendStartedAt = Date.now();
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
      const historyForApi = [...messages, { ...userMsg, content: wireContent }]
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role,
          content: m.content,
        }));
      // last user message uses wireContent (may differ from display)
      if (historyForApi.length) {
        const last = historyForApi[historyForApi.length - 1];
        if (last.role === "user") last.content = wireContent;
      }

      const response = await fetch(`${base}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson, application/json",
        },
        body: JSON.stringify({
          messages: historyForApi,
          agent: uiPrefs.agentMode,
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
      const detail =
        err instanceof Error && err.message ? ` (${err.message})` : "";

      // Cloudflare quick tunnels drop long streams while the worker keeps
      // computing. Probe health with retries, then recover the finished run
      // from /chat/last instead of declaring the session dead.
      let stillUp = false;
      for (let i = 0; i < 3 && !stillUp; i++) {
        try {
          const h = await fetch(`${base}/health`, {
            signal: AbortSignal.timeout(5000),
            cache: "no-store",
            referrerPolicy: "no-referrer",
          });
          stillUp = h.ok;
        } catch {
          /* retry */
        }
        if (!stillUp) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }

      let recovered = false;
      if (stillUp) {
        updateLastAssistant({
          content: `stream dropped${detail} — worker still running, recovering result…`,
        });
        const sentAtSec = sendStartedAt / 1000;
        const deadline = Date.now() + 8 * 60_000;
        while (Date.now() < deadline) {
          try {
            const r = await fetch(`${base}/chat/last`, {
              signal: AbortSignal.timeout(8000),
              cache: "no-store",
              referrerPolicy: "no-referrer",
            });
            if (r.status === 404) break; // older worker without /chat/last
            if (r.ok) {
              const last = (await r.json()) as {
                running?: boolean;
                started_at?: number | null;
                result?: {
                  response?: string;
                  thought_process?: string[];
                } | null;
              };
              const ours =
                typeof last.started_at === "number" &&
                last.started_at >= sentAtSec - 120;
              if (!last.running) {
                if (ours && last.result?.response) {
                  updateLastAssistant({
                    content: last.result.response,
                    thoughts: last.result.thought_process,
                    ts: Date.now(),
                  });
                  recovered = true;
                }
                break; // finished (ours rendered) or stale run — stop polling
              }
            }
          } catch {
            /* tunnel blip — keep polling */
          }
          await new Promise((r) => setTimeout(r, 3500));
        }
      }

      if (!recovered) {
        updateLastAssistant({
          content: stillUp
            ? `reply interrupted${detail}. backend still online — try again or /code for harness`
            : "connection error — worker unreachable after retries. settings → relaunch",
          ts: Date.now(),
        });
      }
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
  if (!bootDone || vaultGate === "loading" || (vaultGate === "ready" && restoring)) {
    return (
      <div className="er-shell min-h-screen flex flex-col items-center justify-center gap-5 p-6">
        <div className="er-shell-bg" aria-hidden />
        <div className="er-shell-content flex flex-col items-center justify-center gap-5 flex-1 w-full">
        <LogoBox pulse tag="initializing" />
        <div className="flex items-center gap-2 text-[var(--muted)] text-xs">
          <Loader2 className="animate-spin" size={14} />
          <span>
            {!bootDone
              ? "starting…"
              : vaultGate === "loading"
                ? "unlocking vault…"
                : "restoring session…"}
          </span>
          <span className="er-cursor" />
        </div>
        </div>
      </div>
    );
  }

  if (vaultGate === "signin" || vaultGate === "create") {
    return (
      <div className="er-shell min-h-screen flex flex-col text-sm">
        <div className="er-shell-bg" aria-hidden />
        <div className="er-shell-content flex flex-col flex-1 min-h-0">
        <div className="er-hazard" />
        <header className="er-term-bar">
          <div className="er-term-dots" aria-hidden>
            <span /><span /><span />
          </div>
          <div className="er-term-title">edgerunner · auth</div>
        </header>
        <main className="flex-1 flex flex-col items-center justify-center p-6 gap-6">
          <LogoBox subtitle="sign in to continue" />
          <div className="w-full max-w-sm space-y-5 er-section p-6 text-center">
            <div className="er-hero-tag mx-auto">SECURE SESSION</div>
            <h1 className="er-logo" style={{ fontSize: "0.85rem" }}>
              SIGN IN
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
      </div>
    );
  }

  if (vaultGate === "need_passphrase") {
    return (
      <div className="er-shell min-h-screen flex flex-col text-sm">
        <div className="er-hazard" />
        <header className="er-term-bar">
          <div className="er-term-dots" aria-hidden>
            <span /><span /><span />
          </div>
          <div className="er-term-title">edgerunner · unlock</div>
        </header>
        <main className="flex-1 flex flex-col items-center justify-center p-6 gap-5">
          <LogoBox subtitle="vault locked" />
          <div className="w-full max-w-sm space-y-4 er-panel p-5">
            <p className="text-[var(--fg)] flex items-center gap-2 text-sm">
              <Lock size={14} className="text-[var(--warn)]" /> enter passphrase
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

  // ── Session hub (continue / new workspace) ─────────────────────────────
  if (appStage === "hub") {
    const live = loadLiveSession();
    const hasLive = !!(live?.backendUrl || backendUrl);
    const hasChat = messages.some((m) => m.role === "user" || m.role === "assistant");
    return (
      <div className="er-shell min-h-screen flex flex-col">
        <div className="er-shell-bg" aria-hidden />
        <div className="er-shell-content flex flex-col flex-1 min-h-0">
        <div className="er-hazard shrink-0" />
        <header className="er-term-bar">
          <div className="er-term-dots" aria-hidden>
            <span /><span /><span />
          </div>
          <div className="er-term-title">edgerunner · workspace</div>
          {googleUser ? (
            <span className="text-[10px] text-[var(--dim)] truncate max-w-[8rem]" title={googleUser.email}>
              {googleUser.email}
            </span>
          ) : null}
        </header>
        <main className="flex-1 flex flex-col items-center justify-center p-6 gap-6">
          <LogoBox
            subtitle="coding agent"
            tag={hasLive ? "session available" : "ready"}
          />
          <SessionHub
            actions={[
              {
                id: "continue",
                title: hasLive || hasChat ? "Continue session" : "Open terminal",
                description: hasLive
                  ? `Resume ${live?.accelerator || phase || "backend"} · ${
                      (live?.backendUrl || backendUrl || "").replace(/^https?:\/\//, "").slice(0, 36) || "saved chat"
                    }`
                  : hasChat
                    ? "Pick up the chat already on this device"
                    : "Start the CLI session (launch Kaggle or attach local next)",
                icon: hasLive || hasChat ? <RotateCcw size={16} /> : <Terminal size={16} />,
                primary: true,
                onClick: () => {
                  void (async () => {
                    if (backendUrl) {
                      setAppStage("terminal");
                      return;
                    }
                    setProgressMsg("looking for active backend…");
                    try {
                      const found = await discoverActiveBackend({
                        form: {
                          username,
                          apiToken,
                          apiKey,
                        },
                        onProgress: (msg) => setProgressMsg(msg),
                      });
                      if (found) {
                        setBackendUrl(found.backendUrl);
                        setIsOnline(true);
                        setModelReady(found.modelReady);
                        setModelName(found.modelName);
                        setPhase(found.phase);
                        if (found.accelerator) setAccelerator(found.accelerator);
                        setMessages((m) => [...m, sysLine(discoverNote(found))]);
                        setProgressMsg(
                          found.modelReady
                            ? null
                            : "backend up; model still loading…"
                        );
                      } else {
                        setProgressMsg(null);
                        setMessages((m) => [
                          ...m,
                          sysLine(
                            "no active backend found — open settings to launch Kaggle"
                          ),
                        ]);
                      }
                    } catch (e) {
                      setProgressMsg(null);
                      setMessages((m) => [
                        ...m,
                        sysLine(
                          `discover failed · ${e instanceof Error ? e.message : String(e)}`
                        ),
                      ]);
                    }
                    setAppStage("terminal");
                  })();
                },
              },
              {
                id: "new",
                title: "New workspace",
                description: "Clear chat transcript and open a clean agent session",
                icon: <Plus size={16} />,
                onClick: () => {
                  clearChat();
                  setAppStage("terminal");
                },
              },
              {
                id: "settings",
                title: "Connection settings",
                description: "Kaggle GPU / local URL · models · credentials",
                icon: <Settings2 size={16} />,
                onClick: () => {
                  setAppStage("terminal");
                  setShowSettings(true);
                },
              },
            ]}
            footnote={
              <>
                tip: <span className="text-[var(--accent)]">/help</span> in the
                terminal · Tab toggles plan/build
              </>
            }
          />
        </main>
        </div>
      </div>
    );
  }

  // ── Main CLI shell ─────────────────────────────────────────────────────
  return (
    <div className="er-shell er-term text-sm">
      <div className="er-shell-bg" aria-hidden />
      <div className="er-shell-content er-term">
      <div className="er-hazard shrink-0" />
      {/* Terminal chrome */}
      <header className="er-term-bar">
        <div className="er-term-dots" aria-hidden>
          <span /><span /><span />
        </div>
        <button
          type="button"
          onClick={() => setAppStage("hub")}
          className="er-btn-ghost text-[10px] px-1 text-[var(--dim)] hover:text-[var(--fg)]"
          title="Workspaces"
        >
          <FolderOpen size={14} />
        </button>
        <div className="er-term-title truncate">
          edgerunner · {uiPrefs.agentMode}
          {modelName ? ` · ${modelName}` : ""}
        </div>
        <span className={`er-status-pill ${statusKind}`}>
          <span className={`er-status-dot ${statusKind}`} />
          {isOnline && modelReady
            ? "ready"
            : isOnline
              ? "booting"
              : backendUrl
                ? "down"
                : "idle"}
        </span>
        {backendUrl && (
          <button
            type="button"
            onClick={() => void openModelPicker()}
            className="er-btn-cyan px-2 py-0.5 text-[10px]"
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
            className="er-btn-danger px-2 py-0.5 text-[10px]"
            title="Stop Kaggle session"
          >
            <Square size={11} className="inline" /> stop
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className="er-btn-ghost p-1"
          title="Settings"
        >
          <Settings2 size={15} />
        </button>
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

      {/* Transcript — CLI scrollback */}
      <main className="er-scrollback">
        {messages.length === 0 && (
          <div className="er-empty space-y-2">
            <p className="text-[var(--fg-bright)]">
              <span className="er-prompt-char">›</span> EdgeRunner agent ready
            </p>
            <p>
              agent=<span className="cmd">{uiPrefs.agentMode}</span> ·{" "}
              <span className="cmd">/help</span> ·{" "}
              <span className="cmd">/code</span> ·{" "}
              <span className="cmd">/plan</span>
            </p>
            <p className="text-[var(--dim)]">
              Coding tasks run automatically (plan → code → verify).
              {configured
                ? " Connection saved — /settings to relaunch."
                : " Open settings to launch Kaggle or attach local."}
            </p>
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === "system") {
            return (
              <div key={i} className="er-line">
                <span className="er-gutter sys">#</span>
                <div className="er-body sys">{m.content}</div>
              </div>
            );
          }
          if (m.role === "user") {
            return (
              <div key={i} className="er-line">
                <span className="er-gutter user">›</span>
                <div className="er-body user">
                  {uiPrefs.showTimestamps && m.ts ? (
                    <span className="text-[10px] text-[var(--dim)] mr-2">
                      {new Date(m.ts).toLocaleTimeString()}
                    </span>
                  ) : null}
                  {m.content}
                </div>
              </div>
            );
          }
          return (
            <div key={i} className="er-line">
              <span className="er-gutter agent">‹</span>
              <div className="er-body agent">
                {uiPrefs.showThinking &&
                  m.thoughts &&
                  m.thoughts.length > 0 && (
                    <details
                      className="er-trace"
                      open={uiPrefs.showToolDetails && uiPrefs.uiView === "cli"}
                    >
                      <summary>trace ({m.thoughts.length})</summary>
                      <pre>{m.thoughts.join("\n")}</pre>
                    </details>
                  )}
                {uiPrefs.uiView === "cli" ? (
                  <pre className="whitespace-pre-wrap break-words m-0 font-inherit text-[13px] leading-relaxed">
                    {m.content}
                  </pre>
                ) : (
                  <div className="er-md">
                    <ReactMarkdown>{m.content}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </main>

      {/* Composer */}
      <footer className="er-prompt-bar">
        {!backendUrl && (
          <div className="mb-2 flex flex-wrap gap-2 text-xs">
            {hasStoredCreds || username ? (
              <button
                type="button"
                disabled={sessionBusy}
                onClick={() => void launchKaggle()}
                className="er-btn-primary px-3 py-1.5"
              >
                {sessionBusy ? "launching…" : "▶ launch kaggle"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="er-btn px-3 py-1.5"
              >
                configure connection
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
        <div className="relative max-w-4xl mx-auto">
          <div className="er-prompt-row">
          <span className="er-prompt-char" title={`agent: ${uiPrefs.agentMode}`}>
            {uiPrefs.agentMode === "plan" ? "?" : "›"}
          </span>
          <div className="flex-1 relative min-w-0">
            {cmdSuggest.length > 0 && (
              <div className="er-cmd-menu">
                {cmdSuggest.map((line) => (
                  <button
                    key={line}
                    type="button"
                    className="er-cmd-item"
                    onClick={() => {
                      const name = line.split(" ")[0];
                      setInput(name + " ");
                      setCmdSuggest([]);
                      inputRef.current?.focus();
                    }}
                  >
                    {line}
                  </button>
                ))}
              </div>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                const v = e.target.value;
                setInput(v);
                if (v.startsWith("/") && !v.includes("\n")) {
                  const q = v.slice(1).split(/\s/)[0] || "";
                  setCmdSuggest(
                    filterCommands(q).slice(0, 8).map(
                      (c) => `/${c.name} — ${c.description}`
                    )
                  );
                } else {
                  setCmdSuggest([]);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setCmdSuggest([]);
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
                // Tab toggles agent like OpenCode
                if (e.key === "Tab" && !e.shiftKey && !input.trim()) {
                  e.preventDefault();
                  const next: AgentMode =
                    uiPrefs.agentMode === "build" ? "plan" : "build";
                  patchUi({ agentMode: next });
                  setMessages((m) => [
                    ...m,
                    sysLine(`agent → ${next} (Tab)`),
                  ]);
                }
              }}
              rows={1}
              placeholder={
                backendUrl
                  ? modelReady
                    ? `/${uiPrefs.agentMode} · /help · type / for commands`
                    : "backend up — model still loading…"
                  : "launch a session first…"
              }
              disabled={isLoading || modelSwitching}
              className="er-prompt-input"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={isLoading || !input.trim()}
            className="er-prompt-send"
          >
            {isLoading ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Send size={15} />
            )}
          </button>
          </div>
        </div>
        <div className="er-prompt-meta">
          <span>
            {phase !== "setup" ? phase : "—"}
            {session?.accelerator ? ` · ${session.accelerator}` : ""}
            {` · ${uiPrefs.uiView}`}
            {` · ${uiPrefs.agentMode}`}
          </span>
          <span className="flex gap-3">
            <button
              type="button"
              onClick={() =>
                patchUi({
                  uiView: uiPrefs.uiView === "cli" ? "chat" : "cli",
                })
              }
              className="hover:text-[var(--cyan)]"
              title="Toggle CLI / chat view"
            >
              view
            </button>
            <button
              type="button"
              onClick={() => {
                const next: AgentMode =
                  uiPrefs.agentMode === "build" ? "plan" : "build";
                patchUi({ agentMode: next });
              }}
              className="hover:text-[var(--warn)]"
              title="Toggle build / plan agent"
            >
              agent
            </button>
            <button
              type="button"
              onClick={clearChat}
              className="hover:text-[var(--muted)]"
            >
              /new
            </button>
          </span>
        </div>
      </footer>

      {/* Settings drawer — solid overlay, no bleed */}
      {showSettings && (
        <div className="er-overlay er-overlay-end" role="dialog" aria-modal="true" aria-label="Settings">
          <button
            type="button"
            className="er-overlay-scrim"
            aria-label="Close settings"
            onClick={() => setShowSettings(false)}
          />
          <aside className="er-drawer">
            <div className="er-drawer-head">
              <div>
                <div className="er-logo" style={{ fontSize: "0.7rem" }}>
                  SETTINGS
                </div>
                <p className="er-section-hint mt-0.5">Connection · agent · account</p>
              </div>
              <button
                type="button"
                className="er-close"
                onClick={() => setShowSettings(false)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="er-drawer-body">
              {/* Agent */}
              <section className="er-section">
                <h3 className="er-section-title">Agent</h3>
                <p className="er-section-hint">
                  Build implements with tools. Plan is readonly analysis.
                </p>
                <div className="er-chip-row">
                  <button
                    type="button"
                    className={`er-chip ${uiPrefs.agentMode === "build" ? "active" : ""}`}
                    onClick={() => patchUi({ agentMode: "build" })}
                  >
                    build
                  </button>
                  <button
                    type="button"
                    className={`er-chip ${uiPrefs.agentMode === "plan" ? "active-soft" : ""}`}
                    onClick={() => patchUi({ agentMode: "plan" })}
                  >
                    plan
                  </button>
                </div>
                <div className="er-chip-row">
                  <button
                    type="button"
                    className={`er-chip ${uiPrefs.uiView === "cli" ? "active" : ""}`}
                    onClick={() => patchUi({ uiView: "cli" })}
                  >
                    CLI view
                  </button>
                  <button
                    type="button"
                    className={`er-chip ${uiPrefs.uiView === "chat" ? "active" : ""}`}
                    onClick={() => patchUi({ uiView: "chat" })}
                  >
                    chat view
                  </button>
                </div>
                <label className="er-field-row">
                  <input
                    type="checkbox"
                    checked={uiPrefs.showThinking}
                    onChange={(e) => patchUi({ showThinking: e.target.checked })}
                  />
                  show thinking / traces
                </label>
                <label className="er-field-row">
                  <input
                    type="checkbox"
                    checked={uiPrefs.showToolDetails}
                    onChange={(e) =>
                      patchUi({ showToolDetails: e.target.checked })
                    }
                  />
                  expand tool details
                </label>
                <label className="er-field-row">
                  <input
                    type="checkbox"
                    checked={uiPrefs.showTimestamps}
                    onChange={(e) =>
                      patchUi({ showTimestamps: e.target.checked })
                    }
                  />
                  timestamps
                </label>
              </section>

              {/* Account */}
              <section className="er-section">
                <h3 className="er-section-title">Account</h3>
                {googleUser ? (
                  <>
                    <p className="text-[0.8rem] text-[var(--fg)] truncate m-0">
                      {googleUser.email}
                    </p>
                    <p className="er-section-hint">
                      Credentials sync across devices when signed in.
                    </p>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={googleBusy}
                        onClick={() =>
                          void (async () => {
                            setGoogleBusy(true);
                            try {
                              await runGoogleSync();
                            } catch (e) {
                              setSessionError(
                                e instanceof Error ? e.message : String(e)
                              );
                            } finally {
                              setGoogleBusy(false);
                            }
                          })()
                        }
                        className="er-btn-cyan flex-1 py-2"
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
                        className="er-btn flex-1 py-2"
                      >
                        sign out
                      </button>
                    </div>
                    {googleMsg && (
                      <p className="er-section-hint text-[var(--accent)]">
                        {googleMsg}
                      </p>
                    )}
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={googleBusy}
                    onClick={() => void handleGoogleSignIn()}
                    className="er-btn-cyan er-btn-block"
                  >
                    Sign in with Google
                  </button>
                )}
              </section>

              {/* Connection */}
              <section className="er-section">
                <h3 className="er-section-title">Connection</h3>
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
                  <>
                    {hasStoredCreds && (
                      <div className="flex items-center justify-between text-[var(--success)] border border-[rgba(46,230,166,0.3)] bg-[rgba(46,230,166,0.06)] px-2.5 py-1.5 rounded-md text-[0.72rem]">
                        <span className="flex items-center gap-1.5">
                          <Shield size={12} /> credentials saved
                        </span>
                        <button
                          type="button"
                          onClick={forgetCredentials}
                          className="text-[var(--dim)] hover:text-[var(--danger)]"
                        >
                          forget
                        </button>
                      </div>
                    )}
                    <label className="er-field">
                      username
                      <input
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        className="er-input"
                        autoComplete="username"
                      />
                    </label>
                    <label className="er-field">
                      api token
                      <input
                        type="password"
                        value={apiToken}
                        onChange={(e) => setApiToken(e.target.value)}
                        placeholder={hasStoredCreds ? "•••• saved" : "KGAT_…"}
                        className="er-input"
                        autoComplete="off"
                      />
                    </label>
                    <label className="er-field">
                      legacy key (optional)
                      <input
                        type="password"
                        value={apiKey}
                        onChange={(e) => setApiKey(e.target.value)}
                        className="er-input"
                        autoComplete="off"
                      />
                    </label>
                    <div className="er-chip-row">
                      {(
                        [
                          { id: "t4x2" as const, label: "T4 (rec)" },
                          { id: "t4" as const, label: "T4 only" },
                          { id: "p100" as const, label: "P100" },
                          { id: "cpu" as const, label: "CPU" },
                        ] as const
                      ).map(({ id, label }) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setAccelerator(id)}
                          className={`er-chip ${accelerator === id ? "active" : ""}`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <p className="er-section-hint">
                      T4 uses official machineShape=NvidiaTeslaT4. Leftover P100
                      sessions are not reused — Launch relaunches on T4.
                    </p>
                    <label className="er-field-row">
                      <input
                        type="checkbox"
                        checked={fallbackCpu}
                        onChange={(e) => setFallbackCpu(e.target.checked)}
                      />
                      CPU fallback if GPU busy
                    </label>
                    <label className="er-field-row">
                      <input
                        type="checkbox"
                        checked={rememberCreds}
                        onChange={(e) => setRememberCreds(e.target.checked)}
                      />
                      remember credentials (encrypted)
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <label className="er-field">
                        idle kill (s)
                        <input
                          type="number"
                          value={idleTimeout}
                          onChange={(e) =>
                            setIdleTimeout(Number(e.target.value))
                          }
                          className="er-input"
                        />
                      </label>
                      <label className="er-field">
                        max life (s)
                        <input
                          type="number"
                          value={maxLifetime}
                          onChange={(e) =>
                            setMaxLifetime(Number(e.target.value))
                          }
                          className="er-input"
                        />
                      </label>
                    </div>
                    <button
                      type="button"
                      disabled={sessionBusy}
                      onClick={() => void launchKaggle()}
                      className="er-btn-primary er-btn-block disabled:opacity-50"
                    >
                      {sessionBusy ? "launching…" : "Launch Kaggle"}
                    </button>
                    {sessionError && (
                      <p className="text-[var(--danger)] text-[0.75rem] m-0">
                        {sessionError}
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <label className="er-field">
                      backend url
                      <input
                        value={localUrl}
                        onChange={(e) => setLocalUrl(e.target.value)}
                        className="er-input"
                        placeholder="http://127.0.0.1:8000"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={sessionBusy}
                      onClick={() => void attachLocal()}
                      className="er-btn-primary er-btn-block"
                    >
                      Attach local
                    </button>
                    {sessionError && (
                      <p className="text-[var(--danger)] text-[0.75rem] m-0">
                        {sessionError}
                      </p>
                    )}
                  </>
                )}
              </section>

              {backendUrl && (
                <section className="er-section">
                  <h3 className="er-section-title">Session</h3>
                  <p className="er-section-hint break-all text-[var(--fg)]">
                    {backendUrl}
                  </p>
                  <button
                    type="button"
                    onClick={() => void openModelPicker()}
                    className="er-btn-cyan er-btn-block"
                  >
                    Choose model
                  </button>
                  <button
                    type="button"
                    onClick={() => void stopSession()}
                    disabled={sessionBusy}
                    className="er-btn-danger er-btn-block"
                  >
                    Stop session
                  </button>
                </section>
              )}
            </div>
          </aside>
        </div>
      )}

      {/* Model picker */}
      {showModels && (
        <div
          className="er-overlay er-overlay-center"
          role="dialog"
          aria-modal="true"
          aria-label="Models"
        >
          <button
            type="button"
            className="er-overlay-scrim"
            aria-label="Close models"
            onClick={() => setShowModels(false)}
          />
          <div className="er-modal">
            <div className="er-modal-head">
              <div>
                <div className="er-logo" style={{ fontSize: "0.7rem" }}>
                  MODELS
                </div>
                <div className="text-[0.68rem] text-[var(--muted)] mt-0.5">
                  {modelHw || "scanning hardware…"} · unload + GC on switch
                </div>
              </div>
              <button
                type="button"
                className="er-close"
                onClick={() => setShowModels(false)}
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="er-modal-body">
              {modelsLoading && (
                <div className="flex items-center gap-2 p-4 text-[var(--muted)] text-xs">
                  <Loader2 size={14} className="animate-spin" /> fetching
                  options…
                </div>
              )}
              {modelSwitching && (
                <div className="px-3 py-2 text-xs text-[var(--warn)] border border-[rgba(240,193,75,0.35)] bg-[rgba(240,193,75,0.08)] rounded-md">
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
                    className={`er-model-card ${opt.fits ? "fits" : "opacity-70"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[var(--fg-bright)] truncate font-medium text-[0.85rem]">
                        {opt.name}
                      </span>
                      <ChevronRight
                        size={14}
                        className="text-[var(--dim)] shrink-0"
                      />
                    </div>
                    <div className="text-[var(--muted)] mt-1 flex flex-wrap gap-x-2 text-[0.72rem]">
                      <span>
                        {opt.file_size_gb} GB disk · ~{opt.required_ram_gb} GB
                        ram
                      </span>
                      <span
                        className={
                          opt.fits
                            ? "text-[var(--success)]"
                            : "text-[var(--danger)]"
                        }
                      >
                        {opt.fit_status}
                      </span>
                      {opt.sharded && (
                        <span className="text-[var(--warn)]">sharded</span>
                      )}
                    </div>
                    <div className="text-[0.65rem] text-[var(--dim)] truncate mt-1">
                      {opt.repo_id} / {opt.filename}
                    </div>
                  </button>
                ))}
              {!modelsLoading && modelOptions.length === 0 && (
                <p className="p-4 text-[var(--muted)] text-xs m-0">
                  no options — is the backend online?
                </p>
              )}
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
