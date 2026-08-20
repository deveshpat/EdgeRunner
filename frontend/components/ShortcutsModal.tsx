"use client";

import { useState, useEffect } from "react";

interface ShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutCategory {
  category: string;
  items: { mac: string[]; win: string[]; description: string }[];
}

const SHORTCUT_GROUPS: ShortcutCategory[] = [
  {
    category: "Modes & Navigation",
    items: [
      { mac: ["⌥ Option", "1"], win: ["Alt", "1"], description: "Mode [ 01 ]: Neural Chat (/chat or ⌘1 / Ctrl+1)" },
      { mac: ["⌥ Option", "2"], win: ["Alt", "2"], description: "Mode [ 02 ]: Autonomous Agent (/agent or ⌘2 / Ctrl+2)" },
      { mac: ["⌥ Option", "3"], win: ["Alt", "3"], description: "Mode [ 03 ]: Interactive Terminal (/terminal or ⌘3 / Ctrl+3 or ⌘J)" },
      { mac: ["⌥ Option", "4"], win: ["Alt", "4"], description: "Mode [ 04 ]: VS Code Workspace (/workspace or ⌘4 / Ctrl+4 or ⌘E)" },
      { mac: ["⌘", "K"], win: ["Ctrl", "K"], description: "Home: Command Center / Landing" },
      { mac: ["⌥ Option", "N"], win: ["Alt", "N"], description: "New Session" },
      { mac: ["⌘", "B"], win: ["Ctrl", "B"], description: "Toggle Sessions Sidebar (or ⌥B / Alt+B)" },
      { mac: ["⌘", "⌫"], win: ["Ctrl", "Backspace"], description: "Delete Active Session (or Shift+Delete)" },
    ],
  },
  {
    category: "Window Docking & Multitasking",
    items: [
      { mac: ["⌥ Option", "D"], win: ["Alt", "D"], description: "Toggle Split Dock (or ⌘\\ / Ctrl+\\)" },
      { mac: ["Tab"], win: ["Tab"], description: "Cycle Next Window" },
      { mac: ["Shift", "Tab"], win: ["Shift", "Tab"], description: "Cycle Previous Window" },
      { mac: ["Enter"], win: ["Enter"], description: "Expand Docked Window / Send Message" },
      { mac: ["Shift", "Enter"], win: ["Shift", "Enter"], description: "Insert Newline in Draft" },
    ],
  },
  {
    category: "Workspace, Editor & Terminal",
    items: [
      { mac: ["⌘", "S"], win: ["Ctrl", "S"], description: "Save Active File in Monaco Editor" },
      { mac: ["⌘", "Enter"], win: ["Ctrl", "Enter"], description: "Run Script / Commit Changes in Git" },
      { mac: ["Ctrl", "L"], win: ["Ctrl", "L"], description: "Clear Active Screen / Terminal Buffer" },
    ],
  },
  {
    category: "Slash Commands & Agent Control",
    items: [
      { mac: ["/compact"], win: ["/compact"], description: "Compact session context & summarize previous turns" },
      { mac: ["/undo"], win: ["/undo"], description: "Rewind and remove last user/assistant turn (/rewind)" },
      { mac: ["/clear"], win: ["/clear"], description: "Clear current session conversation or terminal buffer (/reset)" },
      { mac: ["/diff"], win: ["/diff"], description: "Inspect uncommitted git / workspace changes" },
      { mac: ["/review"], win: ["/review"], description: "Perform an automated code review on workspace files" },
      { mac: ["/init"], win: ["/init"], description: "Generate architectural blueprint & project config" },
      { mac: ["/preview"], win: ["/preview"], description: "Launch interactive web application preview" },
    ],
  },
  {
    category: "Settings & System",
    items: [
      { mac: ["⌘", ","], win: ["Ctrl", ","], description: "Settings & Compute Rig Config" },
      { mac: ["⌥ Option", "M"], win: ["Alt", "M"], description: "Model Matrix Picker (or ⌘M / Ctrl+M)" },
      { mac: ["⌥ Option", "T"], win: ["Alt", "T"], description: "Toggle Light / Dark Theme (or ⌘⇧L / Ctrl+⇧L)" },
      { mac: ["⌘", "/"], win: ["Ctrl", "/"], description: "Open Keyboard Shortcuts Guide (or ?)" },
      { mac: ["Escape"], win: ["Escape"], description: "Close Modals / Cancel Generation" },
    ],
  },
];

export function ShortcutsModal({ isOpen, onClose }: ShortcutsModalProps) {
  const [platform, setPlatform] = useState<"mac" | "win">("mac");

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      const isWin =
        navigator.userAgent.includes("Win") ||
        navigator.userAgent.includes("Linux") ||
        navigator.platform.includes("Win") ||
        navigator.platform.includes("Linux");
      setPlatform(isWin ? "win" : "mac");
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 sm:p-3 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-lg border border-term-border bg-term-bg shadow-2xl font-mono text-xs overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-term-border bg-term-panel/70 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="text-xs uppercase tracking-wider text-term-green font-bold flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                <path d="M20 5H4c-1.1 0-1.99.9-1.99 2L2 17c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm-9 3h2v2h-2V8zm0 3h2v2h-2v-2zM8 8h2v2H8V8zm0 3h2v2H8v-2zm-1 2H5v-2h2v2zm0-3H5V8h2v2zm9 7H8v-2h8v2zm0-4h-2v-2h2v2zm0-3h-2V8h2v2zm3 3h-2v-2h2v2zm0-3h-2V8h2v2z"/>
              </svg>
              <span className="hidden sm:inline">KEYBOARD SHORTCUTS MATRIX</span>
              <span className="sm:hidden">SHORTCUTS</span>
            </span>

            {/* Platform Selector Tabs */}
            <div className="flex items-center rounded border border-term-border/80 bg-term-bg p-0.5 text-[10px]">
              <button
                onClick={() => setPlatform("mac")}
                className={`px-2 py-0.5 rounded transition-colors ${
                  platform === "mac" ? "bg-term-green/20 text-term-green font-bold" : "text-term-dim hover:text-term-fg"
                }`}
              >
                macOS
              </button>
              <button
                onClick={() => setPlatform("win")}
                className={`px-2 py-0.5 rounded transition-colors ${
                  platform === "win" ? "bg-term-green/20 text-term-green font-bold" : "text-term-dim hover:text-term-fg"
                }`}
              >
                Windows / Linux
              </button>
            </div>
          </div>

          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded border border-term-border text-term-dim hover:border-term-green hover:text-term-fg text-xs transition-colors"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {SHORTCUT_GROUPS.map((group, gIdx) => (
            <div key={gIdx} className="space-y-1.5">
              <span className="text-[10px] uppercase font-bold tracking-wider text-term-dim">
                {group.category}
              </span>
              <div className="space-y-1">
                {group.items.map((s, i) => {
                  const activeKeys = platform === "mac" ? s.mac : s.win;
                  return (
                    <div
                      key={i}
                      className="flex flex-wrap items-center justify-between gap-1.5 rounded border border-term-border/60 bg-term-panel/30 px-3 py-1.5 transition-colors hover:border-term-dim text-[11px] sm:text-xs"
                    >
                      <span className="text-term-fg min-w-0 pr-2">{s.description}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        {activeKeys.map((k, j) => (
                          <kbd
                            key={j}
                            className="rounded border border-term-border bg-term-bg px-1.5 py-0.5 text-[9px] sm:text-[10px] font-semibold text-term-green shadow-inner"
                          >
                            {k}
                          </kbd>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-term-border bg-term-panel/30 px-4 py-2.5 text-[10px] text-term-dim">
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
