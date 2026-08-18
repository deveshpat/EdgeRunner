"use client";

import { useEffect } from "react";
import type { Conversation } from "@/lib/storage";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (harness?: string) => void;
  onDelete: (id: string) => void;
  open: boolean;
  onClose: () => void;
  harness?: string;
  onSetHarness?: (h: "chat" | "agent" | "terminal" | "workspace") => void;
  onOpenSettings?: () => void;
  onOpenShortcuts?: () => void;
  onOpenModels?: () => void;
  isLight?: boolean;
  onToggleTheme?: () => void;
}

export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  open,
  onClose,
  harness = "chat",
  onSetHarness,
  onOpenSettings,
  onOpenShortcuts,
  onOpenModels,
  isLight = false,
  onToggleTheme,
}: SidebarProps) {
  // Keyboard navigation inside sidebar
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!open) return;

      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        if (activeId) {
          onSelect(activeId);
        } else if (conversations.length > 0) {
          onSelect(conversations[0].id);
        } else {
          onCreate();
        }
        onClose();
        return;
      }

      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        if (activeId) {
          onDelete(activeId);
        }
        return;
      }

      if (conversations.length > 1 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        const currentIndex = conversations.findIndex((c) => c.id === activeId);
        const nextIndex =
          e.key === "ArrowDown"
            ? (currentIndex + 1) % conversations.length
            : (currentIndex - 1 + conversations.length) % conversations.length;
        onSelect(conversations[nextIndex].id);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, activeId, conversations, onSelect, onCreate, onDelete, onClose]);

  const select = (id: string) => {
    onSelect(id);
    onClose();
  };

  const create = () => {
    onCreate();
    onClose();
  };

  return (
    <>
      {/* Dimmed Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-[2px] transition-opacity duration-200"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Slide-out Universal Navigation Drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[85vw] max-w-xs sm:w-80 flex-col
                    border-r border-term-border bg-term-bg shadow-2xl font-mono text-xs
                    transform transition-transform duration-200 ease-out
                    ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        {/* Drawer Header */}
        <div className="flex items-center justify-between p-3 border-b border-term-border/80 bg-term-panel/80">
          <div className="flex items-center gap-2">
            <span className="text-term-green font-bold text-xs uppercase tracking-wider flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z"/>
              </svg>
              <span>EDGERUNNER MENU</span>
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded border border-term-border text-term-dim hover:text-term-fg hover:border-term-green transition-colors text-xs"
            aria-label="Close sidebar"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Quick Mode Switcher (Pill Matrix) */}
        {onSetHarness && (
          <div className="p-2.5 border-b border-term-border/60 bg-term-panel/30">
            <div className="text-[10px] text-term-dim uppercase tracking-wider mb-1.5 font-bold">
              Active Mode
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  { id: "chat", label: "/chat", desc: "Neural" },
                  { id: "agent", label: "/agent", desc: "ReAct" },
                  { id: "terminal", label: "/terminal", desc: "Shell" },
                  { id: "workspace", label: "/workspace", desc: "VS Code" },
                ] as const
              ).map((m) => {
                const isActive = harness === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => {
                      onSetHarness(m.id);
                      onClose();
                    }}
                    className={`flex items-center justify-between px-2.5 py-1.5 rounded border text-xs transition-all ${
                      isActive
                        ? "border-term-green bg-term-green/15 text-term-green font-bold shadow-sm"
                        : "border-term-border bg-term-bg/60 text-term-dim hover:text-term-fg hover:border-term-border"
                    }`}
                  >
                    <span>{m.label}</span>
                    <span className="text-[9px] opacity-70">{m.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Action Bar */}
        <div className="p-2.5 border-b border-term-border/60">
          <button
            onClick={create}
            className="flex items-center justify-between w-full rounded border border-term-border/80 bg-term-panel/40 px-3 py-2 text-xs text-term-green font-semibold hover:border-term-green hover:bg-term-green/10 transition-all shadow-sm"
          >
            <span>+ New Session</span>
            <kbd className="rounded border border-term-border/60 bg-term-bg px-1.5 py-0.5 text-[9px] text-term-dim">
              ⌘⇧N
            </kbd>
          </button>
        </div>

        {/* Sessions List */}
        <div className="px-3 pt-2.5 pb-1 text-[10px] text-term-dim uppercase font-bold tracking-wider flex items-center justify-between">
          <span>Sessions ({conversations.length})</span>
          <span className="text-[9px] lowercase opacity-60">drag to dock</span>
        </div>
        <nav className="flex-1 overflow-y-auto p-2 space-y-1">
          {conversations.length === 0 ? (
            <div className="p-4 text-center text-term-dim text-xs">
              No previous sessions found.
            </div>
          ) : (
            conversations.map((c) => {
              const isActive = c.id === activeId;
              return (
                <div
                  key={c.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", c.id);
                    e.dataTransfer.setData(
                      "application/edgerunner-session-id",
                      c.id,
                    );
                    e.dataTransfer.effectAllowed = "copyMove";
                  }}
                  className={`group flex items-center justify-between rounded px-2.5 py-2 text-xs cursor-grab active:cursor-grabbing transition-all ${
                    isActive
                      ? "bg-term-panel/90 text-term-fg border border-term-green/50 shadow-sm"
                      : "text-term-dim hover:bg-term-panel/50 hover:text-term-fg border border-transparent"
                  }`}
                >
                  <div
                    onClick={() => select(c.id)}
                    className="flex-1 flex items-center gap-2 min-w-0 cursor-pointer"
                  >
                    <span className="text-term-dim text-[11px] opacity-40 group-hover:opacity-100 select-none">
                      ⠿
                    </span>
                    <span
                      className={`truncate ${
                        isActive ? "text-term-green font-semibold" : "text-term-fg"
                      }`}
                      title={c.title}
                    >
                      {c.title || "Untitled Session"}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[9px] text-term-dim uppercase">
                      {c.messages.length} msgs
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(c.id);
                      }}
                      aria-label="Delete session"
                      className="opacity-0 transition-opacity hover:text-term-red text-[11px] group-hover:opacity-100 px-1"
                      title="Delete this session"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </nav>

        {/* System Tools & Actions (Settings, Shortcuts, Models, Theme) */}
        <div className="p-2.5 border-t border-term-border/70 bg-term-panel/40 space-y-1.5">
          <div className="text-[10px] text-term-dim uppercase font-bold tracking-wider mb-1">
            System & Tools
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {onOpenSettings && (
              <button
                onClick={() => {
                  onOpenSettings();
                  onClose();
                }}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-term-border bg-term-bg/60 text-term-dim hover:text-term-fg hover:border-term-green text-[11px] transition-colors"
                title="Settings & Rig Config (⌘,)"
              >
                <svg className="w-3.5 h-3.5 fill-current shrink-0" viewBox="0 0 24 24">
                  <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                </svg>
                <span>Settings</span>
              </button>
            )}

            {onOpenShortcuts && (
              <button
                onClick={() => {
                  onOpenShortcuts();
                  onClose();
                }}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-term-border bg-term-bg/60 text-term-dim hover:text-term-fg hover:border-term-green text-[11px] transition-colors"
                title="Keyboard Shortcuts Guide (⌘/)"
              >
                <span>⌨</span>
                <span>Shortcuts</span>
              </button>
            )}

            {onOpenModels && (
              <button
                onClick={() => {
                  onOpenModels();
                  onClose();
                }}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-term-border bg-term-bg/60 text-term-dim hover:text-term-fg hover:border-term-green text-[11px] transition-colors"
                title="Model Matrix (⌘M)"
              >
                <span>◧</span>
                <span>Models</span>
              </button>
            )}

            {onToggleTheme && (
              <button
                onClick={onToggleTheme}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-term-border bg-term-bg/60 text-term-dim hover:text-term-fg hover:border-term-green text-[11px] transition-colors"
                title="Toggle Theme (⌥T)"
              >
                <span>{isLight ? "☀️ Light" : "🌙 Dark"}</span>
              </button>
            )}
          </div>
        </div>

        {/* Drawer Footer */}
        <div className="p-2.5 border-t border-term-border/70 bg-term-panel/20 text-[10px] text-term-dim flex items-center justify-between">
          <span>EdgeRunner v0.1.0</span>
          <kbd className="rounded border border-term-border/60 bg-term-bg px-1.5 py-0.5 text-[9px]">
            ⌘B to toggle
          </kbd>
        </div>
      </aside>
    </>
  );
}
