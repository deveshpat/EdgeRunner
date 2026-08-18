"use client";

import { useMemo, useState } from "react";

import type { Role, ToolEvent } from "@/lib/api";
import type { MessageStats } from "@/lib/storage";
import { Markdown } from "./Markdown";

interface MessageProps {
  role: Role;
  content: string;
  tools?: ToolEvent[];
  stats?: MessageStats;
  streaming?: boolean;
  harness?: string;
  onDelete?: () => void;
  onEdit?: (newContent: string) => void;
}

export function Message({
  role,
  content,
  tools,
  stats,
  streaming,
  harness = "chat",
  onDelete,
  onEdit,
}: MessageProps) {
  const isTerminal = harness === "terminal";
  const isAgent = harness === "agent";

  const [isEditing, setIsEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(content);

  const previewMatch = useMemo(() => {
    if (!content) return null;
    const urlMatch =
      content.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\S*/i) ||
      content.match(/https?:\/\/[^\s)]+/i);
    if (urlMatch) return { type: "url", target: urlMatch[0] };
    const htmlMatch = content.match(/\b[\w-]+\.html\b/i);
    if (htmlMatch) return { type: "html", target: htmlMatch[0] };
    return null;
  }, [content]);

  const promptLabel =
    role === "user"
      ? isTerminal
        ? "you@edgerunner:~/workspace$ "
        : "you@edgerunner:~$ "
      : role === "assistant"
        ? isTerminal
          ? "bash > "
          : isAgent
            ? "agent > "
            : "model > "
        : "# system ";

  const promptColor =
    role === "user"
      ? "text-term-green"
      : role === "assistant"
        ? isTerminal
          ? "text-term-dim"
          : "text-term-amber"
        : "text-term-dim";

  function handleSaveEdit() {
    const trimmed = editDraft.trim();
    if (!trimmed) return;
    setIsEditing(false);
    if (trimmed !== content && onEdit) {
      onEdit(trimmed);
    }
  }

  return (
    <div className="group py-2 font-mono text-sm sm:text-base leading-relaxed">
      {tools && tools.length > 0 && (
        <div className="mb-1.5 space-y-1">
          {tools.map((t) => (
            <ToolCall key={t.id} tool={t} />
          ))}
        </div>
      )}

      {isEditing ? (
        <div className="my-1.5 rounded border border-term-green/60 bg-term-panel/80 p-2.5 space-y-2">
          <div className="flex items-center justify-between text-xs text-term-dim">
            <span className="text-term-green font-semibold">Editing message…</span>
            <span>↵ to save · Esc to cancel · ⇧↵ for newline</span>
          </div>
          <textarea
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSaveEdit();
              } else if (e.key === "Escape") {
                setIsEditing(false);
                setEditDraft(content);
              }
            }}
            className="w-full min-h-[70px] p-2.5 rounded border border-term-border bg-term-bg text-term-fg text-sm focus:outline-none focus:border-term-green resize-y leading-relaxed font-mono"
            autoFocus
          />
          <div className="flex items-center gap-2 justify-end">
            <button
              onClick={() => {
                setIsEditing(false);
                setEditDraft(content);
              }}
              className="px-2.5 py-1 rounded border border-term-border text-xs text-term-dim hover:text-term-fg"
            >
              cancel
            </button>
            <button
              onClick={handleSaveEdit}
              className="px-2.5 py-1 rounded border border-term-green/60 bg-term-green/20 text-term-green text-xs font-bold hover:bg-term-green/30"
            >
              save & run ↵
            </button>
          </div>
        </div>
      ) : (
        (content || streaming) && (
          <div>
            <span className={`${promptColor} select-none font-bold`}>{promptLabel}</span>
            {role === "user" ? (
              <span className="whitespace-pre-wrap break-words">{content}</span>
            ) : (
              <AssistantBody content={content} streaming={streaming} />
            )}
          </div>
        )
      )}

      {!streaming && !isEditing && (content || tools?.length) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2.5 sm:gap-3.5 text-xs text-term-dim opacity-70 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity select-none">
          <CopyButton text={content} />
          {onEdit && (
            <button
              className="hover:text-term-green transition-colors"
              onClick={() => {
                setEditDraft(content);
                setIsEditing(true);
              }}
            >
              edit
            </button>
          )}
          {previewMatch && (
            <button
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.dispatchEvent(
                    new CustomEvent("edgerunner:open-preview", {
                      detail: { url: previewMatch.type === "url" ? previewMatch.target : undefined },
                    }),
                  );
                }
              }}
              className="flex items-center gap-1.5 rounded border border-term-green/60 bg-term-green/10 px-2 py-0.5 text-xs text-term-green hover:bg-term-green/20 transition-colors"
              title="Open in native Sandboxed Live Previewer"
            >
              <span>🌐</span>
              <span>Preview {previewMatch.target}</span>
            </button>
          )}
          {onDelete && (
            <button className="hover:text-term-red transition-colors" onClick={onDelete}>
              delete
            </button>
          )}
          {stats && (
            <span className="ml-auto tabular-nums text-xs">
              {isTerminal ? (
                `${(stats.ms / 1000).toFixed(2)}s`
              ) : (
                `${stats.tokens} tok · ${tokPerSec(stats)} tok/s · ${(stats.ms / 1000).toFixed(1)}s`
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function splitThinking(content: string): {
  reasoning: string | null;
  answer: string;
  thinking: boolean;
} {
  const closeIdx = content.indexOf("</think>");
  if (closeIdx !== -1) {
    const rawReasoning = content.slice(0, closeIdx).replace(/^<think>\s*/, "").trim();
    const answer = content.slice(closeIdx + 8).trimStart();
    return { reasoning: rawReasoning || null, answer, thinking: false };
  }
  if (content.startsWith("<think>")) {
    const rawReasoning = content.slice(7).trimStart();
    return { reasoning: rawReasoning, answer: "", thinking: true };
  }
  return { reasoning: null, answer: content, thinking: false };
}

function AssistantBody({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}) {
  const { reasoning, answer, thinking } = useMemo(
    () => splitThinking(content),
    [content],
  );

  return (
    <>
      {reasoning && (
        <details
          className="my-1 rounded border border-term-border bg-term-panel/40 px-2.5 py-1 text-xs text-term-dim"
          open={thinking}
        >
          <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wider text-term-amber">
            {thinking ? "⚡ thinking…" : "thought process"}
          </summary>
          <div className="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-term-dim border-l border-term-amber/30 pl-2">
            {reasoning}
          </div>
        </details>
      )}
      <Markdown content={answer} />
    </>
  );
}

function ToolCall({ tool }: { tool: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const isDone = tool.result !== undefined;

  return (
    <div className="rounded border border-term-border bg-term-panel/50 px-2 py-1 text-xs font-mono">
      <div
        className="flex cursor-pointer items-center justify-between gap-2 text-[11px]"
        onClick={() => isDone && setOpen((o) => !o)}
      >
        <div className="flex items-center gap-1.5 truncate">
          <span className="text-term-dim">tool:</span>
          <span className="text-term-green font-semibold">{tool.name}</span>
          {tool.arguments && (
            <span className="truncate text-term-dim text-[10px]">
              ({tool.arguments})
            </span>
          )}
        </div>
        <span className="text-[10px] text-term-dim">
          {isDone ? (open ? "▾ hide" : "▸ result") : "running…"}
        </span>
      </div>
      {open && tool.result && (
        <pre className="mt-1 max-h-48 overflow-y-auto rounded bg-term-bg/80 p-1.5 text-[10px] text-term-fg leading-tight">
          {tool.result}
        </pre>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="hover:text-term-fg"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function tokPerSec(s: MessageStats): string {
  if (!s.ms) return "0.0";
  return ((s.tokens / s.ms) * 1000).toFixed(1);
}
