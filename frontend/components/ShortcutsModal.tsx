"use client";

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  description: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: ["⌘ / Ctrl", "K"], description: "New Session / Clear to Landing" },
  { keys: ["⌘ / Ctrl", "Shift", "N"], description: "Create New Session" },
  { keys: ["Tab"], description: "Cycle Next Window / Session" },
  { keys: ["Shift", "Tab"], description: "Cycle Previous Window / Session" },
  { keys: ["⌘ / Ctrl", "\\"], description: "Cycle Dock All Windows ↔ Focus Selected" },
  { keys: ["⌘ / Ctrl", "B"], description: "Toggle Sessions History Sidebar" },
  { keys: ["⌘ / Ctrl", "M"], description: "Open Neural Payload Matrix (Model Picker)" },
  { keys: ["⌘ / Ctrl", ","], description: "Toggle Settings & Hardware Rig" },
  { keys: ["⌘ / Ctrl", "L"], description: "Clear Active Transcript" },
  { keys: ["Enter"], description: "Send Prompt" },
  { keys: ["Shift", "Enter"], description: "Insert Newline in Composer" },
  { keys: ["Escape"], description: "Close Modals / Dismiss Panels / Stop Stream" },
  { keys: ["?"], description: "Open Keyboard Shortcuts Matrix" },
];

export function ShortcutsModal({ isOpen, onClose }: ShortcutsModalProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded border border-term-border bg-term-bg shadow-2xl font-mono text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-term-border bg-term-panel/70 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-term-green font-bold">
              ⌨ KEYBOARD MATRIX
            </span>
          </div>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded border border-term-border text-term-dim hover:border-term-green hover:text-term-fg text-xs transition-colors"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {SHORTCUTS.map((s, i) => (
            <div
              key={i}
              className="flex items-center justify-between rounded border border-term-border/60 bg-term-panel/30 px-3 py-2 transition-colors hover:border-term-dim"
            >
              <span className="text-term-fg text-xs">{s.description}</span>
              <div className="flex items-center gap-1">
                {s.keys.map((k, j) => (
                  <kbd
                    key={j}
                    className="rounded border border-term-border bg-term-bg px-2 py-0.5 text-[10px] font-semibold text-term-green shadow-inner"
                  >
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-term-border bg-term-panel/30 p-3 text-[10px] text-term-dim">
          <span>PRESS [ESC] TO CLOSE</span>
          <button
            onClick={onClose}
            className="flex items-center gap-1 rounded border border-term-border px-2.5 py-1 text-term-dim hover:text-term-fg hover:border-term-green transition-colors"
          >
            <span>✕</span>
            <span>Close</span>
          </button>
        </div>
      </div>
    </div>
  );
}
