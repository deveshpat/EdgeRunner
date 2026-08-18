"use client";

import { useState } from "react";

import type { Role, ToolEvent } from "@/lib/api";
import type { MessageStats } from "@/lib/storage";
import { Markdown } from "./Markdown";

interface MessageProps {
  role: Role;
  content: string;
  tools?: ToolEvent[];
  stats?: MessageStats;
  streaming?: boolean;
  onDelete?: () => void;
}

const PROMPT: Record<Role, string> = {
  user: "you@edgerunner:~$",
  assistant: "agent >",
  system: "# system",
};

const COLOR: Record<Role, string> = {
  user: "text-term-green",
  assistant: "text-term-amber",
  system: "text-term-dim",
};

export function Message({
  role,
  content,
  tools,
  stats,
  streaming,
  onDelete,
}: MessageProps) {
  return (
    <div className="group py-1.5">
      {tools && tools.length > 0 && (
        <div className="mb-1 space-y-1">
          {tools.map((t) => (
            <ToolCall key={t.id} tool={t} />
          ))}
        </div>
      )}
      {(content || streaming) && (
        <div>
          <span className={`${COLOR[role]} select-none`}>{PROMPT[role]}</span>{" "}
          {role === "user" ? (
            <span className="whitespace-pre-wrap break-words">{content}</span>
          ) : (
            <AssistantBody content={content} streaming={streaming} />
          )}
        </div>
      )}
      {!streaming && (content || tools?.length) && (
        <div className="mt-1 flex flex-wrap items-center gap-2 sm:gap-3 text-[10px] text-term-dim opacity-70 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
          <CopyButton text={content} />
          {onDelete && (
            <button className="hover:text-term-red" onClick={onDelete}>
              delete
            </button>
          )}
          {stats && (
            <span className="ml-auto tabular-nums">
              {stats.tokens} tok · {tokPerSec(stats)} tok/s ·{" "}
              {(stats.ms / 1000).toFixed(1)}s
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Reasoning models emit <think>…</think> or begin thinking immediately ending with </think>.
// Split it out so the reasoning renders in a collapsible block and the answer stays clean.
function splitThinking(content: string): {
  reasoning: string | null;
  answer: string;
  thinking: boolean;
} {
  const open = content.indexOf("<think>");
  if (open === -1) {
    const close = content.indexOf("</think>");
    if (close !== -1) {
      const reasoning = content.slice(0, close);
      const answer = content.slice(close + "</think>".length).trimStart();
      return { reasoning, answer, thinking: false };
    }
    return { reasoning: null, answer: content, thinking: false };
  }
  const before = content.slice(0, open);
  const rest = content.slice(open + "<think>".length);
  const close = rest.indexOf("</think>");
  if (close === -1) {
    // still inside the reasoning block (streaming)
    return { reasoning: rest, answer: before, thinking: true };
  }
  const reasoning = rest.slice(0, close);
  const answer = (before + rest.slice(close + "</think>".length)).trimStart();
  return { reasoning, answer, thinking: false };
}

function AssistantBody({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}) {
  const { reasoning, answer, thinking } = splitThinking(content);
  return (
    <div className="mt-1 font-mono">
      {reasoning !== null && reasoning.trim() && (
        <ThinkBlock reasoning={reasoning} thinking={thinking} />
      )}
      <div className={streaming && !thinking ? "cursor-blink" : ""}>
        <Markdown content={answer} />
      </div>
    </div>
  );
}

function ThinkBlock({
  reasoning,
  thinking,
}: {
  reasoning: string;
  thinking: boolean;
}) {
  // Auto-expanded while the model is still reasoning; collapsed once done.
  const [open, setOpen] = useState(false);
  const show = thinking || open;
  return (
    <div className="mb-2 rounded border border-term-border/80 bg-term-panel/40 text-xs font-mono shadow-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-term-dim hover:text-term-fg transition-colors"
      >
        <span className="text-term-amber">
          {thinking ? "⚡" : "🧠"}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-wider text-term-dim">
          {thinking ? "Thinking process…" : open ? "▾ Reasoning Matrix" : "▸ Reasoning Matrix"}
        </span>
      </button>
      {show && (
        <div className="border-t border-term-border/60 px-3 py-2 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-term-dim/90 bg-term-bg/50">
          {reasoning.trim()}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="flex items-center gap-1 hover:text-term-green transition-colors font-mono"
      onClick={() =>
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        })
      }
    >
      <span>{copied ? "✓" : "⎘"}</span>
      <span>{copied ? "copied" : "copy"}</span>
    </button>
  );
}

function tokPerSec(stats: MessageStats): string {
  if (stats.ms <= 0) return "–";
  return (stats.tokens / (stats.ms / 1000)).toFixed(1);
}

function ToolCall({ tool }: { tool: ToolEvent }) {
  return (
    <div className="rounded border border-term-border bg-term-panel/60 px-2.5 py-1.5 text-xs font-mono">
      <div className="text-term-dim">
        <span className="text-term-green font-semibold">⚙ tool</span> {tool.name}
        {tool.arguments ? (
          <span className="text-term-fg">({tool.arguments})</span>
        ) : null}
      </div>
      {tool.result !== undefined && (
        <div className="mt-1 whitespace-pre-wrap break-words text-[11px] text-term-dim">
          <span className="text-term-amber font-semibold">↳</span> {tool.result}
        </div>
      )}
    </div>
  );
}
