"use client";

import { useEffect } from "react";
import type { Conversation } from "@/lib/storage";

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  open: boolean;
  onClose: () => void;
}

export function Sidebar({
  conversations,
  activeId,
  onSelect,
  onCreate,
  onDelete,
  open,
  onClose,
}: SidebarProps) {
  // Handle keyboard navigation when sidebar is open (Enter closes to selected session, Escape closes, Arrow keys navigate)
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

      {/* Slide-out Terminal Drawer */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[85vw] max-w-xs sm:w-80 flex-col
                    border-r border-term-border bg-term-bg shadow-2xl font-mono text-xs
                    transform transition-transform duration-200 ease-out
                    ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        {/* Drawer Header */}
        <div className="flex items-center justify-between p-3 border-b border-term-border/80 bg-term-panel/80">
          <div className="flex items-center gap-2">
            <span className="text-term-green font-bold text-xs uppercase tracking-wider">
              ☰ SESSIONS
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded border border-term-border text-term-dim hover:text-term-fg hover:border-term-green transition-colors text-xs"
            aria-label="Close sidebar"
            title="Close (Enter, ⌘B, or Esc)"
          >
            ✕
          </button>
        </div>

        {/* Action Bar */}
        <div className="p-3 border-b border-term-border/60">
          <button
            onClick={create}
            className="flex items-center justify-between w-full rounded border border-term-border/80 bg-term-panel/40 px-3 py-2 text-xs text-term-green font-semibold hover:border-term-green hover:bg-term-green/10 transition-all shadow-sm"
          >
            <span>+ New Session</span>
            <kbd className="rounded border border-term-border/60 bg-term-bg px-1.5 py-0.5 text-[9px] text-term-dim">
              ⌘⇧N
            </kbd>
          </button>
          <div className="pt-2 px-1 text-[10px] text-term-dim uppercase tracking-wider">
            Drag & Drop to Dock on Canvas
          </div>
        </div>

        {/* Conversation List */}
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

        {/* Drawer Footer */}
        <div className="p-2.5 border-t border-term-border/70 bg-term-panel/30 text-[10px] text-term-dim flex items-center justify-between">
          <span>↵ Enter to Resume Session</span>
          <kbd className="rounded border border-term-border/60 bg-term-bg px-1.5 py-0.5 text-[9px]">
            ⌘B to toggle
          </kbd>
        </div>
      </aside>
    </>
  );
}
