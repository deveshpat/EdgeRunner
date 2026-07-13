"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { streamChat, type SamplingParams, type ToolEvent } from "./api";
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
  create: () => void;
  seedIfEmpty: () => void;
  select: (id: string) => void;
  remove: (id: string) => void;
  setModel: (model: string) => void;
  setHarness: (harness: string) => void;
  send: (text: string) => void;
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

  const create = useCallback(() => {
    const convo = newConversation(
      active?.model ?? defaultsRef.current.model,
      active?.harness ?? defaultsRef.current.harness,
    );
    setConversations((prev) => [convo, ...prev]);
    setActiveId(convo.id);
    setStreaming("");
    setLiveTools([]);
    setError(null);
  }, [active]);

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
        for await (const ev of streamChat(
          {
            model: convo.model,
            harness: convo.harness,
            messages: payload,
            ...params,
          },
          controller.signal,
        )) {
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
        // Aborts surface as an error we swallow; anything else we show.
        if ((e as Error).name !== "AbortError") {
          setError((e as Error).message);
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
                  title: titleFrom(messages),
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
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;

      // Ensure there is an active conversation to append to.
      let convo = active;
      if (!convo) {
        convo = newConversation(
          defaultsRef.current.model,
          defaultsRef.current.harness,
        );
        setConversations((prev) => [convo!, ...prev]);
        setActiveId(convo.id);
      }

      const messages: DisplayMessage[] = [
        ...convo.messages,
        { role: "user", content: trimmed },
      ];
      // Optimistically show the user message.
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convo!.id ? { ...c, messages } : c,
        ),
      );
      void run(convo, messages);
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
