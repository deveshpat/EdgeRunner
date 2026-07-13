"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Composer } from "@/components/Composer";
import {
  KaggleControl,
  STATE_COLOR,
  STATE_LABEL,
} from "@/components/KaggleControl";
import { Logo } from "@/components/Logo";
import { Message } from "@/components/Message";
import { Picker } from "@/components/Picker";
import { SettingsPanel } from "@/components/Settings";
import { Sidebar } from "@/components/Sidebar";
import { fetchCatalog, type Catalog } from "@/lib/api";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from "@/lib/storage";
import { useConversations } from "@/lib/useConversations";
import { useKaggle } from "@/lib/useKaggle";

export default function Home() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Kaggle control plane (declared before catalog effects so its setApiBase
  // effect runs first when the active backend changes).
  const kaggle = useKaggle();

  const chat = useConversations(
    {
      model: catalog?.models[0]?.id ?? "",
      harness: catalog?.harnesses[0]?.id ?? "",
    },
    settings,
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadCatalog = useCallback(() => {
    setCatalogError(null);
    fetchCatalog()
      .then(setCatalog)
      .catch((e) => setCatalogError(`Could not reach backend: ${e.message}`));
  }, []);

  // Load settings on mount.
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  // (Re)load the catalog whenever the active backend changes — i.e. when the
  // Kaggle session comes online (tunnel) or goes back offline (local).
  useEffect(() => {
    loadCatalog();
  }, [loadCatalog, kaggle.state, kaggle.publicUrl]);

  // Once hydrated and the catalog is loaded, make sure there is a session.
  useEffect(() => {
    if (
      chat.hydrated &&
      catalog &&
      catalog.models.length > 0 &&
      chat.conversations.length === 0
    ) {
      chat.seedIfEmpty();
    }
  }, [chat.hydrated, catalog, chat.conversations.length, chat.seedIfEmpty]);

  // Autoscroll only when the user is already at the bottom.
  useEffect(() => {
    if (atBottom) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [chat.active, chat.streaming, chat.liveTools, atBottom]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const active = chat.active;
  const model = active?.model || catalog?.models[0]?.id || "";
  const harness = active?.harness || catalog?.harnesses[0]?.id || "";
  const canRegenerate =
    !chat.busy &&
    !!active &&
    active.messages.some((m) => m.role === "assistant");

  function submit() {
    const text = input.trim();
    if (!text || chat.busy) return;
    chat.send(text);
    setInput("");
  }

  return (
    <main className="flex h-screen">
      <Sidebar
        conversations={chat.conversations}
        activeId={active?.id ?? null}
        onSelect={chat.select}
        onCreate={chat.create}
        onDelete={chat.remove}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="mx-auto flex h-screen max-w-4xl flex-1 flex-col p-4">
        {/* Header */}
        <header className="border-b border-term-border pb-3">
          <div className="relative flex items-center">
            <button
              onClick={() => setSidebarOpen(true)}
              className="absolute left-0 top-0 z-10 shrink-0 rounded border border-term-border
                         px-2 py-1 text-term-dim hover:border-term-green hover:text-term-green
                         md:hidden"
              aria-label="open sidebar"
            >
              ☰
            </button>
            <Logo />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <Picker
              label="model"
              options={catalog?.models ?? []}
              value={model}
              onChange={chat.setModel}
              disabled={chat.busy}
            />
            <Picker
              label="harness"
              options={catalog?.harnesses ?? []}
              value={harness}
              onChange={chat.setHarness}
              disabled={chat.busy}
            />
            <button
              onClick={() => setShowSettings((s) => !s)}
              className={`text-xs ${
                showSettings ? "text-term-green" : "text-term-dim"
              } hover:text-term-green`}
              aria-expanded={showSettings}
            >
              ⚙ settings
            </button>

            {/* Kaggle power button */}
            <button
              onClick={() => {
                if (!kaggle.configured) {
                  setShowSettings(true);
                } else if (
                  ["online", "packing", "pushing", "provisioning"].includes(
                    kaggle.state,
                  )
                ) {
                  kaggle.stop();
                } else {
                  kaggle.start(); // uses the selected accelerator
                }
              }}
              disabled={kaggle.busy}
              className={`text-xs ${STATE_COLOR[kaggle.state]} hover:opacity-80
                          disabled:opacity-40`}
              title="Kaggle backend"
            >
              ⏻ kaggle: {STATE_LABEL[kaggle.state]}
            </button>

            <span className="ml-auto text-xs text-term-dim">
              {catalog ? "● connected" : "○ connecting…"}
            </span>
          </div>
          {showSettings && (
            <>
              <SettingsPanel settings={settings} onChange={updateSettings} />
              <KaggleControl kaggle={kaggle} />
            </>
          )}
        </header>

        {/* Transcript */}
        <div className="relative flex-1 overflow-hidden">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="h-full overflow-y-auto px-1 py-4 text-sm leading-relaxed sm:px-2"
          >
            {!active || active.messages.length === 0 ? (
              <p className="text-term-dim">
                Pick a model and harness, then type a message to start.
              </p>
            ) : (
              active.messages.map((m, i) => (
                <Message
                  key={i}
                  role={m.role}
                  content={m.content}
                  tools={m.tools}
                  stats={m.stats}
                  onDelete={() => chat.deleteMessage(i)}
                />
              ))
            )}
            {(chat.streaming || chat.liveTools.length > 0) && (
              <Message
                role="assistant"
                content={chat.streaming}
                tools={chat.liveTools}
                streaming
              />
            )}
            {chat.error && <p className="py-2 text-term-red">! {chat.error}</p>}
            {catalogError &&
              (kaggle.state === "online" ? (
                // Online but the tunnel isn't answering yet — a real problem.
                <p className="py-2 text-term-red">! {catalogError}</p>
              ) : (
                // No backend yet — guide instead of alarm (common on mobile).
                <p className="py-2 text-term-dim">
                  No backend connected yet. Open ⚙ settings → Kaggle backend and
                  hit start, or run a backend locally.
                </p>
              ))}
          </div>

          {!atBottom && (
            <button
              onClick={scrollToBottom}
              className="absolute bottom-3 right-3 rounded border border-term-border
                         bg-term-panel px-2 py-1 text-xs text-term-dim
                         hover:border-term-green hover:text-term-green"
            >
              ↓ bottom
            </button>
          )}
        </div>

        {/* Controls */}
        <div className="border-t border-term-border pt-3">
          <div className="mb-2 flex gap-2 text-xs">
            {chat.busy ? (
              <button
                onClick={chat.stop}
                className="rounded border border-term-border px-2 py-1 text-term-red
                           hover:border-term-red"
              >
                ■ stop
              </button>
            ) : (
              <button
                onClick={chat.regenerate}
                disabled={!canRegenerate}
                className="rounded border border-term-border px-2 py-1 text-term-dim
                           hover:border-term-green hover:text-term-green
                           disabled:opacity-30 disabled:hover:border-term-border
                           disabled:hover:text-term-dim"
              >
                ↻ regenerate
              </button>
            )}
          </div>
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={submit}
            disabled={chat.busy}
          />
        </div>
      </div>
    </main>
  );
}
