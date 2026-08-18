"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  bottomRight?: React.ReactNode;
  harness?: string;
}

// Auto-growing terminal sandbox input with outline-breaking corner controls and Up/Down history
export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  bottomRight,
  harness,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [history, setHistory] = useState<string[]>(() => {
    if (typeof window !== "undefined") {
      try {
        return JSON.parse(localStorage.getItem("edgerunner.cmd_history") || "[]");
      } catch {
        return [];
      }
    }
    return [];
  });
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const draftRef = useRef<string>("");

  // Grow/shrink to fit content, capped so it never eats the screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [value]);

  // Keep input focused when switching modes
  useLayoutEffect(() => {
    ref.current?.focus();
  }, [harness]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const clean = value.trim();
      if (clean) {
        setHistory((prev) => {
          const next = prev[prev.length - 1] === clean ? prev : [...prev.slice(-100), clean];
          if (typeof window !== "undefined") {
            try {
              localStorage.setItem("edgerunner.cmd_history", JSON.stringify(next));
            } catch {}
          }
          return next;
        });
      }
      setHistoryIndex(-1);
      draftRef.current = "";
      onSubmit();
      return;
    }

    // Up Arrow: cycle previous commands in history
    if (e.key === "ArrowUp") {
      const ta = ref.current;
      const isAtStart = ta ? ta.selectionStart === 0 && ta.selectionEnd === 0 : true;
      const isSingleLine = !value.includes("\n");

      if ((isAtStart || isSingleLine) && history.length > 0) {
        e.preventDefault();
        if (historyIndex === -1) {
          draftRef.current = value;
        }
        const nextIdx = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(nextIdx);
        onChange(history[nextIdx]);
        setTimeout(() => {
          if (ref.current) {
            ref.current.selectionStart = ref.current.selectionEnd = ref.current.value.length;
          }
        }, 0);
      }
    }

    // Down Arrow: cycle forward through history
    if (e.key === "ArrowDown") {
      const ta = ref.current;
      const isAtEnd = ta ? ta.selectionStart === value.length : true;
      const isSingleLine = !value.includes("\n");

      if ((isAtEnd || isSingleLine) && historyIndex !== -1) {
        e.preventDefault();
        const nextIdx = historyIndex + 1;
        if (nextIdx >= history.length) {
          setHistoryIndex(-1);
          onChange(draftRef.current);
        } else {
          setHistoryIndex(nextIdx);
          onChange(history[nextIdx]);
        }
        setTimeout(() => {
          if (ref.current) {
            ref.current.selectionStart = ref.current.selectionEnd = ref.current.value.length;
          }
        }, 0);
      }
    }
  }

  const isTerminal = harness === "terminal";
  const isAgent = harness === "agent";

  const defaultPlaceholder = isTerminal
    ? "Type a shell command (e.g. ls -la, python3 script.py, pip install …) [↵ to run]"
    : isAgent
      ? "Instruct the coding agent to solve and verify tasks… (↵ to send)"
      : "Type a message… (↵ to send)";

  return (
    <div
      onClick={() => ref.current?.focus()}
      className={`relative flex flex-col rounded-lg border bg-term-bg p-3 sm:p-3.5 pb-4 mb-3.5 shadow-sm transition-all cursor-text ${
        isTerminal
          ? "border-term-green/70 focus-within:border-term-green focus-within:shadow-[0_0_16px_rgba(57,255,20,0.18)]"
          : isAgent
            ? "border-term-amber/60 focus-within:border-term-amber focus-within:shadow-[0_0_16px_rgba(255,189,46,0.18)]"
            : "border-term-border focus-within:border-term-green/70 focus-within:shadow-[0_0_14px_rgba(57,255,20,0.12)]"
      }`}
    >
      <div className="flex items-start gap-2.5 sm:gap-3 pb-3 sm:pb-2">
        <span
          className={`select-none pt-0.5 font-bold font-mono text-sm sm:text-base shrink-0 ${
            isTerminal
              ? "text-term-green"
              : isAgent
                ? "text-term-amber"
                : "text-term-green"
          }`}
        >
          {isTerminal ? (
            <>
              <span className="hidden sm:inline">you@edgerunner:~/workspace</span>$
            </>
          ) : isAgent ? (
            "agent $"
          ) : (
            "$"
          )}
        </span>
        <textarea
          ref={ref}
          rows={1}
          className="flex-1 resize-none bg-transparent text-term-fg placeholder:text-term-dim/60 focus:outline-none text-sm sm:text-base font-mono leading-relaxed min-w-0"
          placeholder={
            placeholder || (disabled ? "processing…" : defaultPlaceholder)
          }
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
        {value.trim().length > 0 && (
          <button
            onClick={(e) => {
              e.preventDefault();
              onSubmit();
            }}
            disabled={disabled}
            className="sm:hidden flex items-center justify-center h-7 w-7 rounded border border-term-green/60 bg-term-green/20 text-term-green disabled:opacity-40 shrink-0 self-end transition-colors"
            title="Send (Enter)"
          >
            <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        )}
      </div>

      {bottomRight && (
        <div className="absolute -bottom-3.5 right-2 sm:right-4 max-w-[calc(100%-0.5rem)] flex items-center gap-1.5 sm:gap-2 bg-term-bg px-1.5 sm:px-2.5 z-10 select-none overflow-x-auto no-scrollbar">
          {bottomRight}
        </div>
      )}
    </div>
  );
}
