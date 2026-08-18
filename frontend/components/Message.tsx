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
        (content || streaming || (tools && tools.length > 0)) && (
          <div>
            <span className={`${promptColor} select-none font-bold`}>{promptLabel}</span>
            {role === "user" ? (
              <span className="whitespace-pre-wrap break-words">{content}</span>
            ) : (
              <AssistantBody content={content} streaming={streaming} tools={tools} />
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

function parseMessageContent(content: string, propTools?: ToolEvent[]) {
  let reasoning: string | null = null;
  let answer = content;
  let thinking = false;

  // 1. Handle thinking tags: <think>, </think>, <thought>, </thought>, <reasoning>, </reasoning>, etc.
  const closeThinkMatch = content.match(/<\/(?:think|thought|reasoning|thought_process)>|\[\/THINK\]/i);
  if (closeThinkMatch && closeThinkMatch.index !== undefined) {
    const closeIdx = closeThinkMatch.index;
    const rawReasoning = content
      .slice(0, closeIdx)
      .replace(/^<(?:think|thought|reasoning|thought_process)>\s*|^\[THINK\]\s*/i, "")
      .trim();
    reasoning = rawReasoning || null;
    answer = content.slice(closeIdx + closeThinkMatch[0].length).trimStart();
    thinking = false;
  } else if (/^<(?:think|thought|reasoning|thought_process)>|^\[THINK\]/i.test(content)) {
    reasoning = content
      .replace(/^<(?:think|thought|reasoning|thought_process)>\s*|^\[THINK\]\s*/i, "")
      .trimStart();
    answer = "";
    thinking = true;
  }

  // 2. Extract inline <tool_call>...</tool_call> or <function=...> from answer
  const inlineTools: ToolEvent[] = [];
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match;
  let callCount = 0;

  while ((match = toolCallRegex.exec(answer)) !== null) {
    callCount++;
    const inner = match[1].trim();

    // Try parsing JSON
    let parsedJson: any = null;
    try {
      parsedJson = JSON.parse(inner);
    } catch {}

    if (parsedJson && typeof parsedJson === "object") {
      const name = parsedJson.name || parsedJson.function?.name || "terminal";
      const args = parsedJson.arguments || parsedJson.parameters || parsedJson.function?.arguments || parsedJson;
      inlineTools.push({
        id: `inline_tool_${callCount}`,
        name: String(name),
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      });
      continue;
    }

    // Try parsing XML <function=...> or <function name="...">
    const fnMatch = inner.match(/<function(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)(?:<\/function>|$)/i);
    if (fnMatch) {
      const fnName = fnMatch[1].trim();
      const fnBody = fnMatch[2].trim();
      const paramMatches = [...fnBody.matchAll(/<parameter(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)<\/parameter>/gi)];
      let cmd = "";
      if (paramMatches.length > 0) {
        cmd = paramMatches.map((m) => m[2].trim()).join("\n");
      } else {
        cmd = fnBody;
      }
      inlineTools.push({
        id: `inline_tool_${callCount}`,
        name: fnName,
        arguments: cmd,
      });
      continue;
    }

    if (inner) {
      inlineTools.push({
        id: `inline_tool_${callCount}`,
        name: "terminal",
        arguments: inner,
      });
    }
  }

  // Clean raw <tool_call> tags from markdown display
  const cleanAnswer = answer
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>[\s\S]*?<\/function>/gi, "")
    .trim();

  const allTools = propTools && propTools.length > 0 ? propTools : inlineTools;

  return {
    reasoning,
    answer: cleanAnswer,
    thinking,
    allTools,
  };
}

function AssistantBody({
  content,
  streaming,
  tools,
}: {
  content: string;
  streaming?: boolean;
  tools?: ToolEvent[];
}) {
  const { reasoning, answer, thinking, allTools } = useMemo(
    () => parseMessageContent(content, tools),
    [content, tools],
  );

  return (
    <>
      {allTools && allTools.length > 0 && (
        <div className="my-1.5 space-y-1">
          {allTools.map((t) => (
            <ToolCall key={t.id} tool={t} />
          ))}
        </div>
      )}

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
  const [localRunning, setLocalRunning] = useState(false);
  const [localResult, setLocalResult] = useState<string | null>(tool.result || null);

  const isDone = Boolean(localResult || tool.result);
  const displayResult = localResult || tool.result;

  const handleRunInTerminal = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (typeof window !== "undefined") {
      let cmd = tool.arguments || "";
      try {
        const parsed = JSON.parse(cmd);
        if (typeof parsed === "object") {
          cmd = parsed.command || parsed.cmd || parsed.code || cmd;
        }
      } catch {}

      setLocalRunning(true);
      window.dispatchEvent(
        new CustomEvent("edgerunner:run-command", {
          detail: { command: cmd },
        })
      );
      setTimeout(() => {
        setLocalRunning(false);
        setLocalResult("Command sent to workspace terminal.");
      }, 500);
    }
  };

  return (
    <div className="rounded border border-term-border bg-term-panel/50 px-2.5 py-1.5 text-xs font-mono">
      <div
        className="flex cursor-pointer items-center justify-between gap-2 text-xs"
        onClick={() => isDone && setOpen((o) => !o)}
      >
        <div className="flex items-center gap-1.5 truncate">
          <span className="text-term-dim">tool:</span>
          <span className="text-term-green font-semibold">{tool.name}</span>
          {tool.arguments && (
            <span className="truncate text-term-dim text-[11px] max-w-[200px] sm:max-w-md">
              ({tool.arguments})
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!isDone && (
            <button
              onClick={handleRunInTerminal}
              disabled={localRunning}
              className="flex items-center gap-1 rounded bg-term-green/20 border border-term-green/50 px-2 py-0.5 text-[10px] font-semibold text-term-green hover:bg-term-green/30 transition-colors"
              title="Run this command in the active terminal"
            >
              <span>{localRunning ? "running…" : "▶ Run in Terminal"}</span>
            </button>
          )}
          {isDone && (
            <span className="text-[10px] text-term-dim">
              {open ? "▾ hide" : "▸ result"}
            </span>
          )}
        </div>
      </div>
      {open && displayResult && (
        <pre className="mt-1.5 max-h-48 overflow-y-auto rounded bg-term-bg/80 p-2 text-xs text-term-fg leading-relaxed whitespace-pre-wrap break-words border border-term-border/40 font-mono">
          {displayResult}
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
