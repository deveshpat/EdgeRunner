"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { streamChat, type SamplingParams, type ToolEvent } from "./api";
import { BROWSER_AGENT_ID, runBrowserAgent } from "./browserAgent";
import type { BrowserToolContext } from "./browserTools";
import {
  Conversation,
  DisplayMessage,
  Settings,
  loadActiveId,
  loadConversations,
  newConversation,
  saveActiveId,
  saveConversations,
  titleFrom,
} from "./storage";

export type { DisplayMessage };

export interface UseConversations {
  hydrated: boolean;
  conversations: Conversation[];
  active: Conversation | null;
  streaming: string;
  liveTools: ToolEvent[];
  busy: boolean;
  error: string | null;
  create: () => string;
  seedIfEmpty: () => void;
  select: (id: string) => void;
  remove: (id: string) => void;
  setModel: (model: string) => void;
  setHarness: (harness: string) => void;
  send: (text: string, forceNew?: boolean) => void;
  stop: () => void;
  regenerate: () => void;
  deleteMessage: (index: number) => void;
}

export function useConversations(
  defaults: { model: string; harness: string },
  settings: Settings,
): UseConversations {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const [streaming, setStreaming] = useState("");
  const [liveTools, setLiveTools] = useState<ToolEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Keep the latest defaults (from the async-loaded catalog) in a ref so
  // create()/send() always seed new conversations with real values.
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
    setActiveId(loadActiveId() ?? loaded[0]?.id ?? null);
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

  const create = useCallback((): string => {
    // If an empty session already exists (0 messages), reuse it instead of creating duplicate empty sessions!
    const existingEmpty = conversations.find((c) => c.messages.length === 0);
    if (existingEmpty) {
      setActiveId(existingEmpty.id);
      setStreaming("");
      setLiveTools([]);
      setError(null);
      return existingEmpty.id;
    }

    const convo = newConversation(
      active?.model ?? defaultsRef.current.model,
      active?.harness ?? defaultsRef.current.harness,
    );
    setConversations((prev) => [convo, ...prev]);
    setActiveId(convo.id);
    setStreaming("");
    setLiveTools([]);
    setError(null);
    return convo.id;
  }, [active, conversations]);

  // Seed an initial conversation once (the caller guards on emptiness). Both
  // setters run from an effect, never inside a render/updater.
  const seedIfEmpty = useCallback(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const convo = newConversation(
      defaultsRef.current.model,
      defaultsRef.current.harness,
    );
    setConversations([convo]);
    setActiveId(convo.id);
  }, []);

  const select = useCallback((id: string) => {
    setActiveId(id);
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
    (model: string) => patchActive((c) => ({ ...c, model })),
    [patchActive],
  );
  const setHarness = useCallback(
    (harness: string) => patchActive((c) => ({ ...c, harness })),
    [patchActive],
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
          if (ev.type === "token") {
            acc += ev.data;
            tokenCount += 1;
            setStreaming(acc);
          } else if (ev.type === "tool_call") {
            const t = JSON.parse(ev.data) as ToolEvent;
            tools.push(t);
            setLiveTools([...tools]);
          } else if (ev.type === "tool_result") {
            const r = JSON.parse(ev.data) as ToolEvent;
            const existing = tools.find((t) => t.id === r.id);
            if (existing) existing.result = r.result;
            else tools.push(r);
            setLiveTools([...tools]);
          } else if (ev.type === "error") {
            setError(ev.data);
            break;
          }
        }
      } catch (e) {
        // Aborts surface as an error we swallow; offline network errors stream a friendly mock reply.
        if ((e as Error).name !== "AbortError") {
          const lastUser = messages.filter((m) => m.role === "user").pop()?.content || "";
          const mockReply = `[Offline Mock via ${convo.model}] Backend server is currently disconnected. You said: "${lastUser}". Open ⚙ settings to start your Kaggle compute instance or connect a local server.`;
          acc = mockReply;
          setStreaming(acc);
          tokenCount = mockReply.split(/\s+/).length;
        }
      } finally {
        abortRef.current = null;
        const assistant: DisplayMessage = {
          role: "assistant",
          content: acc,
          tools: tools.length ? tools : undefined,
          stats: tokenCount
            ? { tokens: tokenCount, ms: performance.now() - startedAt }
            : undefined,
        };
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convo.id
              ? {
                  ...c,
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
      if (!convo || (forceNew && convo.messages.length > 0)) {
        convo = newConversation(
          active?.model ?? defaultsRef.current.model,
          active?.harness ?? defaultsRef.current.harness,
        );
        setConversations((prev) => [convo!, ...prev]);
        setActiveId(convo.id);
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
    [active, busy, run],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const regenerate = useCallback(() => {
    if (busy || !active) return;
    // Drop the trailing assistant message and re-run the prior turn.
    const msgs = [...active.messages];
    if (msgs.length && msgs[msgs.length - 1].role === "assistant") msgs.pop();
    if (!msgs.length) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === active.id ? { ...c, messages: msgs } : c)),
    );
    void run(active, msgs);
  }, [active, busy, run]);

  const deleteMessage = useCallback(
    (index: number) => {
      if (busy || !active) return;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === active.id
            ? { ...c, messages: c.messages.filter((_, i) => i !== index) }
            : c,
        ),
      );
    },
    [active, busy],
  );

  return {
    hydrated,
    conversations,
    active,
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
  };
}
