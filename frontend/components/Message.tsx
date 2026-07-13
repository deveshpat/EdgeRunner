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
        <div className="mt-1 flex items-center gap-3 text-[10px] text-term-dim opacity-0 transition-opacity group-hover:opacity-100">
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

// Reasoning models emit <think>…</think> before the answer. Split it out so
// the reasoning renders in a collapsible block and the answer stays clean.
function splitThinking(content: string): {
  reasoning: string | null;
  answer: string;
  thinking: boolean;
} {
  const open = content.indexOf("<think>");
  if (open === -1) return { reasoning: null, answer: content, thinking: false };
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
    <div className="mt-1">
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
    <div className="mb-1 rounded border border-term-border bg-term-panel/40 text-xs">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-1 text-term-dim hover:text-term-fg"
      >
        <span className="text-term-amber">🧠</span>
        {thinking ? "thinking…" : open ? "▾ reasoning" : "▸ reasoning"}
      </button>
      {show && (
        <div className="border-t border-term-border px-2 py-1 whitespace-pre-wrap break-words text-term-dim">
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
      className="hover:text-term-green"
      onClick={() =>
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        })
      }
    >
      {copied ? "✓ copied" : "copy"}
    </button>
  );
}

function tokPerSec(stats: MessageStats): string {
  if (stats.ms <= 0) return "–";
  return (stats.tokens / (stats.ms / 1000)).toFixed(1);
}

function ToolCall({ tool }: { tool: ToolEvent }) {
  return (
    <div className="rounded border border-term-border bg-term-panel/60 px-2 py-1 text-xs">
      <div className="text-term-dim">
        <span className="text-term-green">⚙ tool</span> {tool.name}
        {tool.arguments ? (
          <span className="text-term-fg">({tool.arguments})</span>
        ) : null}
      </div>
      {tool.result !== undefined && (
        <div className="mt-0.5 whitespace-pre-wrap break-words text-term-dim">
          <span className="text-term-amber">↳</span> {tool.result}
        </div>
      )}
    </div>
  );
}
