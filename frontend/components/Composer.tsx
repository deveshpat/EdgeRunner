"use client";

import { useLayoutEffect, useRef } from "react";

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  disabled?: boolean;
  bottomRight?: React.ReactNode;
}

// Auto-growing terminal sandbox input with outline-breaking corner controls
export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled,
  bottomRight,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow/shrink to fit content, capped so it never eats the screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [value]);

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className="relative flex flex-col rounded-lg border border-term-border bg-term-bg p-3.5 pb-4 mb-3.5 shadow-sm transition-all focus-within:border-term-green/70 focus-within:shadow-[0_0_14px_rgba(57,255,20,0.12)]">
      <div className="flex items-start gap-2.5 pb-3 sm:pb-2">
        <span className="select-none pt-0.5 text-term-green font-bold text-sm">$</span>
        <textarea
          ref={ref}
          rows={1}
          className="flex-1 resize-none bg-transparent text-term-fg placeholder:text-term-dim/60 focus:outline-none text-xs sm:text-sm font-mono leading-relaxed"
          placeholder={
            placeholder || (disabled ? "processing…" : "Type a message…")
          }
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
      </div>

      {bottomRight && (
        <div className="absolute -bottom-3 right-4 flex items-center gap-1.5 bg-term-bg px-2 z-10 select-none">
          {bottomRight}
        </div>
      )}
    </div>
  );
}
