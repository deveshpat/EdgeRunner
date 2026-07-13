"use client";

import { useLayoutEffect, useRef } from "react";

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}

// Auto-growing terminal input. Enter sends; Shift+Enter inserts a newline.
export function Composer({ value, onChange, onSubmit, disabled }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow/shrink to fit content, capped so it never eats the screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [value]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className="flex items-start gap-2">
      <span className="select-none pt-0.5 text-term-green">$</span>
      <textarea
        ref={ref}
        rows={1}
        className="flex-1 resize-none bg-transparent text-term-fg placeholder:text-term-dim
                   focus:outline-none"
        placeholder={
          disabled ? "streaming…" : "type a message — Enter to send, Shift+Enter for newline"
        }
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
      />
    </div>
  );
}
