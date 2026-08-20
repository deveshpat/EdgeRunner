"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getBackendBase, hasBackend, streamChat, type SamplingParams, type ToolEvent } from "./api";
import { BROWSER_AGENT_ID, runBrowserAgent } from "./browserAgent";
import { runDeepSeekHarness } from "./deepseekHarness";
import type { BrowserToolContext } from "./browserTools";
import { vfs, wasmShell } from "./wasmShell";
import {
  Conversation,
  DisplayMessage,
  Settings,
  loadActiveId,
  loadConversations,
  loadSelectedHarness,
  loadSelectedModel,
  newConversation,
  saveActiveId,
  saveConversations,
  saveSelectedHarness,
  saveSelectedModel,
  titleFrom,
} from "./storage";

export type { DisplayMessage };

export interface UseConversations {
  hydrated: boolean;
  conversations: Conversation[];
  active: Conversation | null;
  harness: string;
  model: string;
  streaming: string;
  liveTools: ToolEvent[];
  busy: boolean;
  error: string | null;
  create: (harnessOverride?: string, modelOverride?: string) => string;
  seedIfEmpty: () => void;
  select: (id: string) => void;
  remove: (id: string) => void;
  setModel: (model: string) => void;
  setHarness: (harness: string) => void;
  send: (text: string, forceNew?: boolean) => void;
  stop: () => void;
  regenerate: () => void;
  deleteMessage: (index: number) => void;
  editMessage: (index: number, newContent: string) => Promise<void>;
  forkConversation: (index: number) => string;
  compactActive: (focus?: string) => void;
  undoLastTurn: () => void;
}

export function useConversations(
  defaults: { model: string; harness: string },
  settings: Settings,
): UseConversations {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const [selectedHarness, setSelectedHarness] = useState<string>(defaults.harness || "chat");
  const [selectedModel, setSelectedModel] = useState<string>(defaults.model);

  const [streaming, setStreaming] = useState("");
  const [liveTools, setLiveTools] = useState<ToolEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Keep the latest defaults in a ref
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  // Latest sampling settings, read fresh at request time.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Guards the one-time seed of an initial conversation.
  const seededRef = useRef(false);

  // Fresh mirrors of state for the browser agent's tools (called mid-run).
  const conversationsRef = useRef<Conversation[]>([]);
  conversationsRef.current = conversations;
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  // Hydrate from localStorage after mount (avoids SSR mismatch).
  useEffect(() => {
    const loaded = loadConversations();
    setConversations(loaded);
    const act = loadActiveId() ?? loaded[0]?.id ?? null;
    setActiveId(act);

    const activeConvo = loaded.find((c) => c.id === act);
    const savedHarness = loadSelectedHarness() || activeConvo?.harness || defaults.harness || "chat";
    const savedModel = loadSelectedModel() || activeConvo?.model || defaults.model;

    setSelectedHarness(savedHarness);
    setSelectedModel(savedModel);
    defaultsRef.current.harness = savedHarness;
    defaultsRef.current.model = savedModel;

    if (activeConvo?.cwd) {
      vfs.setCwd(activeConvo.cwd);
    } else {
      vfs.setCwd("/workspace");
    }

    setHydrated(true);
  }, []);

  // Persist whenever conversations change (post-hydration).
  useEffect(() => {
    if (hydrated) saveConversations(conversations);
  }, [conversations, hydrated]);
  useEffect(() => {
    if (hydrated) saveActiveId(activeId);
  }, [activeId, hydrated]);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  const patchActive = useCallback(
    (fn: (c: Conversation) => Conversation) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === activeId ? fn(c) : c)),
      );
    },
    [activeId],
  );

  const create = useCallback(
    (harnessOverride?: string, modelOverride?: string): string => {
      const h = harnessOverride || selectedHarness || defaultsRef.current.harness || "chat";
      const m = modelOverride || selectedModel || defaultsRef.current.model;

      setSelectedHarness(h);
      saveSelectedHarness(h);
      defaultsRef.current.harness = h;

      if (modelOverride) {
        setSelectedModel(m);
        saveSelectedModel(m);
        defaultsRef.current.model = m;
      }

      const existingEmpty = conversations.find((c) => c.messages.length === 0);
      if (existingEmpty) {
        setActiveId(existingEmpty.id);
        vfs.setCwd(existingEmpty.cwd || "/workspace");
        setConversations((prev) =>
          prev.map((c) =>
            c.id === existingEmpty.id ? { ...c, harness: h, model: m } : c,
          ),
        );
        setStreaming("");
        setLiveTools([]);
        setError(null);
        return existingEmpty.id;
      }

      const convo = newConversation(m, h);
      vfs.setCwd(convo.cwd || "/workspace");
      setConversations((prev) => [convo, ...prev]);
      setActiveId(convo.id);
      setStreaming("");
      setLiveTools([]);
      setError(null);
      return convo.id;
    },
    [conversations, selectedHarness, selectedModel],
  );

  // Seed an initial conversation once (the caller guards on emptiness).
  const seedIfEmpty = useCallback(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const convo = newConversation(
      selectedModel || defaultsRef.current.model,
      selectedHarness || defaultsRef.current.harness,
    );
    vfs.setCwd(convo.cwd || "/workspace");
    setConversations([convo]);
    setActiveId(convo.id);
  }, [selectedHarness, selectedModel]);

  const select = useCallback((id: string) => {
    setActiveId(id);
    const convo = conversationsRef.current.find((c) => c.id === id);
    if (convo) {
      vfs.setCwd(convo.cwd || "/workspace");
      setSelectedHarness(convo.harness);
      saveSelectedHarness(convo.harness);
      defaultsRef.current.harness = convo.harness;
      setSelectedModel(convo.model);
      saveSelectedModel(convo.model);
      defaultsRef.current.model = convo.model;
    } else {
      vfs.setCwd("/workspace");
    }
    setStreaming("");
    setLiveTools([]);
    setError(null);
  }, []);

  const remove = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== id);
        if (id === activeId) setActiveId(next[0]?.id ?? null);
        return next;
      });
    },
    [activeId],
  );

  const setModel = useCallback(
    (model: string) => {
      setSelectedModel(model);
      saveSelectedModel(model);
      defaultsRef.current.model = model;
      if (activeId) {
        patchActive((c) => ({ ...c, model }));
      }
    },
    [activeId, patchActive],
  );

  const setHarness = useCallback(
    (harness: string) => {
      setSelectedHarness(harness);
      saveSelectedHarness(harness);
      defaultsRef.current.harness = harness;
      if (activeId) {
        patchActive((c) => ({ ...c, harness }));
      }
    },
    [activeId, patchActive],
  );

  // Run a generation for the given message list and append the result.
  const run = useCallback(
    async (convo: Conversation, messages: DisplayMessage[]) => {
      setBusy(true);
      setStreaming("");
      setLiveTools([]);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      let acc = "";
      let tokenCount = 0;
      const startedAt = performance.now();
      const tools: ToolEvent[] = [];
      const params: SamplingParams = {
        temperature: settingsRef.current.temperature,
        top_p: settingsRef.current.topP,
        max_tokens: settingsRef.current.maxTokens,
      };
      try {
        const payload = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        // The browser-agent harness runs the loop client-side (its tools act on
        // this app); everything else goes to the server harness via /api/chat.
        const ctx: BrowserToolContext = {
          listSessions: () =>
            conversationsRef.current.map((c) => ({ id: c.id, title: c.title })),
          renameActive: (title) =>
            setConversations((prev) =>
              prev.map((c) =>
                c.id === activeIdRef.current ? { ...c, title } : c,
              ),
            ),
          readActive: () =>
            (
              conversationsRef.current.find((c) => c.id === activeIdRef.current)
                ?.messages ?? []
            ).map((m) => ({ role: m.role, content: m.content })),
        };
        const isDsh = convo.harness === "deepseek" || convo.harness === "dsh";
        const source =
          convo.harness === BROWSER_AGENT_ID
            ? runBrowserAgent({
                model: convo.model,
                messages: payload,
                ctx,
                temperature: params.temperature,
                top_p: params.top_p,
                max_tokens: params.max_tokens,
                signal: controller.signal,
              })
            : isDsh && !hasBackend()
              ? runDeepSeekHarness({
                  messages: payload,
                  preset: "code",
                  temperature: params.temperature,
                  top_p: params.top_p,
                  max_tokens: params.max_tokens,
                  signal: controller.signal,
                })
              : streamChat(
                  {
                    model: convo.model,
                    harness: convo.harness,
                    messages: payload,
                    ...params,
                  },
                  controller.signal,
                );
        for await (const ev of source) {
          const chunk = ev.data || "";
          if (ev.type === "token") {
            if (acc.includes("<think>") && !acc.includes("</think>")) {
              acc += `</think>\n\n${chunk}`;
            } else {
              acc += chunk;
            }
            tokenCount += 1;
            setStreaming(acc);
          } else if (ev.type === "think") {
            if (!acc.includes("<think>")) {
              acc = `<think>${chunk}`;
            } else {
              acc += chunk;
            }
            setStreaming(acc);
          } else if (ev.type === "tool_call") {
            if (chunk) {
              try {
                const t = JSON.parse(chunk) as ToolEvent;
                tools.push(t);
                setLiveTools([...tools]);
              } catch {}
            }
          } else if (ev.type === "tool_result") {
            if (chunk) {
              try {
                const r = JSON.parse(chunk) as ToolEvent;
                const existing = tools.find((t) => t.id === r.id);
                if (existing) existing.result = r.result;
                else tools.push(r);
                setLiveTools([...tools]);
              } catch {}
            }
          } else if (ev.type === "error") {
            setError(chunk || "Execution error");
            break;
          }
        }
      } catch (e) {
        // Aborts surface as an error we swallow; offline network errors stream a friendly mock reply or run in Wasm Shell.
        if ((e as Error).name !== "AbortError") {
          const lastUser = messages.filter((m) => m.role === "user").pop()?.content || "";
          let mockReply = "";
          if (convo.harness === "terminal") {
            // Execute via In-Browser WebAssembly Shell with live streaming
            setStreaming("```\nprocessing…\n```");
            const wasmRes = await wasmShell.execute(lastUser, (chunk) => {
              setStreaming(`\`\`\`\n${chunk}\n\`\`\``);
            });
            if (wasmRes.output) {
              mockReply = `\`\`\`\n${wasmRes.output}\n\`\`\`\n\`● exit ${wasmRes.exitCode}\``;
            } else {
              mockReply = `\`● exit ${wasmRes.exitCode}\``;
            }
          } else {
            mockReply = `[Offline Mock via ${convo.model}] Backend server is currently disconnected. You said: "${lastUser}". Open ⚙ settings to start your Kaggle compute instance or connect a local server.`;
          }
          acc = mockReply;
          setStreaming(acc);
          tokenCount = convo.harness === "terminal" ? 0 : mockReply.split(/\s+/).length;
        }
      } finally {
        abortRef.current = null;
        const assistant: DisplayMessage = {
          role: "assistant",
          content: acc,
          tools: tools.length ? tools : undefined,
          stats:
            convo.harness === "terminal"
              ? { tokens: 0, ms: performance.now() - startedAt }
              : tokenCount
                ? { tokens: tokenCount, ms: performance.now() - startedAt }
                : undefined,
        };
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convo.id
              ? {
                  ...c,
                  cwd: convo.harness === "terminal" ? vfs.getCwd() : c.cwd,
                  messages: [...messages, assistant],
                  // Keep a custom/agent-set title; only auto-title the default.
                  title:
                    c.title && c.title !== "new session"
                      ? c.title
                      : titleFrom(messages),
                  updatedAt: Date.now(),
                }
              : c,
          ),
        );
        setStreaming("");
        setLiveTools([]);
        setBusy(false);
      }
    },
    [],
  );

  const send = useCallback(
    (text: string, forceNew?: boolean) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      // Ensure there is an active conversation to append to.
      let convo = active;
      const targetHarness = selectedHarness || defaultsRef.current.harness || "chat";
      const targetModel = selectedModel || defaultsRef.current.model;

      if (!convo || (forceNew && convo.messages.length > 0)) {
        convo = newConversation(
          targetModel,
          targetHarness,
        );
        setConversations((prev) => [convo!, ...prev]);
        setActiveId(convo.id);
      } else if (convo.messages.length === 0 && convo.harness !== targetHarness) {
        convo = { ...convo, harness: targetHarness, model: targetModel };
        setConversations((prev) =>
          prev.map((c) => (c.id === convo!.id ? convo! : c)),
        );
      }

      // Direct instant intercept for 'clear' command in terminal mode
      if ((convo.harness === "terminal" || targetHarness === "terminal") && trimmed === "clear") {
        setConversations((prev) =>
          prev.map((c) => (c.id === convo!.id ? { ...c, messages: [] } : c)),
        );
        setStreaming("");
        setLiveTools([]);
        setBusy(false);
        return;
      }

      const messages: DisplayMessage[] = [
        ...convo.messages,
        { role: "user", content: trimmed },
      ];

      // Optimistically append the user message right away so the UI feels instant.
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convo!.id ? { ...c, messages, updatedAt: Date.now() } : c,
        ),
      );

      run(convo, messages);
    },
    [active, busy, run, selectedHarness, selectedModel],
  );

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setBusy(false);
    setStreaming("");
    setLiveTools([]);
  }, []);

  const regenerate = useCallback(() => {
    if (!active || busy || active.messages.length === 0) return;
    // Find the last user message and slice the history up to and including it.
    let lastUserIdx = -1;
    for (let i = active.messages.length - 1; i >= 0; i--) {
      if (active.messages[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx === -1) return;
    const history = active.messages.slice(0, lastUserIdx + 1);
    setConversations((prev) =>
      prev.map((c) => (c.id === active.id ? { ...c, messages: history } : c)),
    );
    run(active, history);
  }, [active, busy, run]);

  const deleteMessage = useCallback(
    (index: number) => {
      if (!active) return;
      if (index === -1) {
        setConversations((prev) =>
          prev.map((c) => (c.id === active.id ? { ...c, messages: [] } : c)),
        );
        return;
      }
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== active.id) return c;
          const target = c.messages[index];
          // If deleting a user message, also auto-delete the paired assistant message right below it
          if (target?.role === "user" && c.messages[index + 1]?.role === "assistant") {
            return {
              ...c,
              messages: c.messages.filter((_, i) => i !== index && i !== index + 1),
            };
          }
          return {
            ...c,
            messages: c.messages.filter((_, i) => i !== index),
          };
        }),
      );
    },
    [active],
  );

  const editMessage = useCallback(
    async (index: number, newContent: string) => {
      if (!active || busy) return;
      const targetMsg = active.messages[index];
      if (!targetMsg) return;

      const isTerminal = active.harness === "terminal";

      if (isTerminal) {
        // In Terminal mode: update command and re-execute in Wasm shell immediately
        const updatedMessages = [...active.messages];
        updatedMessages[index] = { ...targetMsg, content: newContent };

        const nextMsg = updatedMessages[index + 1];
        const hasAssistant = nextMsg && nextMsg.role === "assistant";

        if (hasAssistant) {
          updatedMessages[index + 1] = {
            role: "assistant",
            content: "```\nrunning…\n```",
          };
        } else {
          updatedMessages.splice(index + 1, 0, {
            role: "assistant",
            content: "```\nrunning…\n```",
          });
        }

        setConversations((prev) =>
          prev.map((c) => (c.id === active.id ? { ...c, messages: updatedMessages } : c)),
        );

        // Execute updated command
        const startTime = performance.now();
        try {
          const res = await wasmShell.execute(newContent);
          const durationMs = Math.round(performance.now() - startTime);
          const outputContent = res.output
            ? `\`\`\`\n${res.output}\n\`\`\`\n\`● exit ${res.exitCode}\``
            : `\`● exit ${res.exitCode}\``;
          const finalMessages = [...updatedMessages];
          finalMessages[index + 1] = {
            role: "assistant",
            content: outputContent,
            stats: {
              tokens: 0,
              ms: durationMs,
            },
          };
          setConversations((prev) =>
            prev.map((c) => (c.id === active.id ? { ...c, messages: finalMessages } : c)),
          );
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const finalMessages = [...updatedMessages];
          finalMessages[index + 1] = {
            role: "assistant",
            content: `\`\`\`\nerror: ${msg}\n\`\`\``,
          };
          setConversations((prev) =>
            prev.map((c) => (c.id === active.id ? { ...c, messages: finalMessages } : c)),
          );
        }
      } else {
        // In Chat / Agent mode: update message text and re-generate from that turn
        const history = active.messages.slice(0, index);
        const updatedTurn: DisplayMessage = { ...targetMsg, content: newContent };
        const newHistory = [...history, updatedTurn];

        setConversations((prev) =>
          prev.map((c) => (c.id === active.id ? { ...c, messages: newHistory } : c)),
        );

        run(active, newHistory);
      }
    },
    [active, busy, run],
  );

  const compactActive = useCallback((focus?: string) => {
    const currentActive = conversationsRef.current.find((c) => c.id === activeIdRef.current);
    if (!currentActive || currentActive.messages.length < 2) return;

    const userMessages = currentActive.messages.filter((m) => m.role === "user");
    const initialGoal = userMessages[0]?.content || "Software Engineering Task";
    const toolCount = currentActive.messages.reduce((sum, m) => sum + (m.tools?.length || 0), 0);
    const vfsFiles = vfs.getAllEntries().map((e) => e.path).slice(0, 20);

    const summaryText = `### 📦 Session Context Compacted (${currentActive.messages.length} messages, ${toolCount} tool runs)

**Primary Objective:**
> ${initialGoal.slice(0, 250)}${initialGoal.length > 250 ? "…" : ""}

**Current Architecture & Workspace State:**
- **Working Directory:** \`${currentActive.cwd || "/workspace"}\`
- **Active Files (${vfsFiles.length}):** ${vfsFiles.map((f) => `\`${f}\``).join(", ") || "None"}
- **Verified Actions:** Completed ${toolCount} tool operations and environment checks.
${focus ? `\n**Focus Area:** ${focus}` : ""}

*Context window compressed. All subsequent instructions will execute with full token budget.*`;

    const compactedMessage: DisplayMessage = {
      role: "assistant",
      content: summaryText,
    };

    setConversations((prev) =>
      prev.map((c) =>
        c.id === currentActive.id
          ? {
              ...c,
              messages: [
                { role: "user", content: `[Context Compacted]: Please continue working on: ${initialGoal.slice(0, 150)}` },
                compactedMessage,
              ],
              updatedAt: Date.now(),
            }
          : c,
      ),
    );
  }, []);

  const undoLastTurn = useCallback(() => {
    const currentActive = conversationsRef.current.find((c) => c.id === activeIdRef.current);
    if (!currentActive || currentActive.messages.length === 0) return;

    const newMessages = [...currentActive.messages];
    if (newMessages.length > 0 && newMessages[newMessages.length - 1].role === "assistant") {
      newMessages.pop();
    }
    if (newMessages.length > 0 && newMessages[newMessages.length - 1].role === "user") {
      newMessages.pop();
    }

    setConversations((prev) =>
      prev.map((c) => (c.id === currentActive.id ? { ...c, messages: newMessages, updatedAt: Date.now() } : c)),
    );
  }, []);

  const forkConversation = useCallback((index: number): string => {
    const currentActive = conversationsRef.current.find((c) => c.id === activeIdRef.current);
    if (!currentActive || currentActive.messages.length === 0) return "";

    const sliced = currentActive.messages.slice(0, index + 1);
    const newId = `dsh_fork_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const forkedConvo: Conversation = {
      id: newId,
      title: `${currentActive.title || "session"} (fork #${index + 1})`,
      model: currentActive.model,
      harness: currentActive.harness,
      preset: currentActive.preset,
      parentId: currentActive.id,
      forkIndex: index,
      cwd: currentActive.cwd,
      messages: sliced,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    setConversations((prev) => [forkedConvo, ...prev]);
    setActiveId(newId);
    saveActiveId(newId);
    return newId;
  }, []);

  const effectiveHarness = selectedHarness || active?.harness || defaultsRef.current.harness || "chat";
  const effectiveModel = selectedModel || active?.model || defaultsRef.current.model;

  return {
    hydrated,
    conversations,
    active,
    harness: effectiveHarness,
    model: effectiveModel,
    streaming,
    liveTools,
    busy,
    error,
    create,
    seedIfEmpty,
    select,
    remove,
    setModel,
    setHarness,
    send,
    stop,
    regenerate,
    deleteMessage,
    editMessage,
    forkConversation,
    compactActive,
    undoLastTurn,
  };
}
