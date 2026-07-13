"use client";

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
  // On mobile, selecting/creating also dismisses the drawer.
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
      {/* Backdrop (mobile only, when open) */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col
                    border-r border-term-border bg-term-bg
                    transform transition-transform duration-200 ease-out
                    md:static md:z-auto md:translate-x-0
                    ${open ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center gap-2 p-2">
          <button
            onClick={create}
            className="flex-1 rounded border border-term-border px-3 py-2 text-left text-xs
                       text-term-green hover:border-term-green hover:bg-term-panel"
          >
            + new session
          </button>
          {/* Close button (mobile only) */}
          <button
            onClick={onClose}
            className="rounded border border-term-border px-2 py-2 text-xs text-term-dim
                       hover:text-term-green md:hidden"
            aria-label="close sidebar"
          >
            ✕
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {conversations.length === 0 && (
            <p className="px-1 py-2 text-xs text-term-dim">no sessions yet</p>
          )}
          {conversations.map((c) => {
            const isActive = c.id === activeId;
            return (
              <div
                key={c.id}
                className={`group flex items-center gap-1 rounded px-2 py-1.5 text-xs
                            ${
                              isActive
                                ? "bg-term-panel text-term-fg"
                                : "text-term-dim hover:bg-term-panel/50"
                            }`}
              >
                <button
                  onClick={() => select(c.id)}
                  className="flex-1 truncate text-left"
                  title={c.title}
                >
                  <span className="mr-1 text-term-dim">›</span>
                  {c.title}
                </button>
                <button
                  onClick={() => onDelete(c.id)}
                  aria-label="delete session"
                  className="opacity-0 transition-opacity hover:text-term-red
                             group-hover:opacity-100"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </nav>
      </aside>
    </>
  );
}
