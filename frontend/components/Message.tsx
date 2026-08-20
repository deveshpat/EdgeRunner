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
  onFork?: () => void;
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
  onFork,
}: MessageProps) {
  const isTerminal = harness === "terminal";
  const isAgent = harness === "agent";
  const isDeepSeek = harness === "deepseek" || harness === "dsh";

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
            : isDeepSeek
              ? "deepseek > "
              : "model > "
        : "# system ";

  const promptColor =
    role === "user"
      ? "text-term-green"
      : role === "assistant"
        ? isTerminal
          ? "text-term-dim"
          : isAgent
            ? "text-term-amber"
            : isDeepSeek
              ? "text-cyan-400"
              : "text-term-dim"
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
          {onFork && (
            <button
              className="hover:text-cyan-400 transition-colors"
              onClick={onFork}
              title="Fork session from this checkpoint"
            >
              ⑂ fork
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

export type MessageSegment =
  | { type: "think"; content: string; open: boolean }
  | { type: "tool"; tool: ToolEvent }
  | { type: "markdown"; content: string };

function parseChronologicalSegments(
  content: string,
  propTools?: ToolEvent[],
): MessageSegment[] {
  const segments: MessageSegment[] = [];
  if (!content && (!propTools || propTools.length === 0)) return segments;

  let toolIdx = 0;
  const toolsPool = propTools ? [...propTools] : [];
  let remaining = content || "";

  while (remaining.length > 0) {
    const openThinkMatch = remaining.match(/<(?:think|thought|reasoning|thought_process)>|\[THINK\]/i);
    const closeThinkMatch = remaining.match(/<\/(?:think|thought|reasoning|thought_process)>|\[\/THINK\]/i);
    const toolCallMatch = remaining.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
    const fnCallMatch = remaining.match(/<function(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)<\/function>/i);

    const matches = [
      openThinkMatch && openThinkMatch.index !== undefined ? { type: "open_think", idx: openThinkMatch.index, match: openThinkMatch } : null,
      closeThinkMatch && closeThinkMatch.index !== undefined ? { type: "close_think", idx: closeThinkMatch.index, match: closeThinkMatch } : null,
      toolCallMatch && toolCallMatch.index !== undefined ? { type: "tool_call", idx: toolCallMatch.index, match: toolCallMatch } : null,
      fnCallMatch && fnCallMatch.index !== undefined ? { type: "fn_call", idx: fnCallMatch.index, match: fnCallMatch } : null,
    ].filter(Boolean).sort((a, b) => a!.idx - b!.idx);

    if (matches.length === 0) {
      const clean = remaining.trim();
      if (clean) segments.push({ type: "markdown", content: clean });
      break;
    }

    const first = matches[0]!;
    const prefix = remaining.slice(0, first.idx);

    if (first.type === "open_think") {
      if (prefix.trim()) segments.push({ type: "markdown", content: prefix.trim() });
      const afterOpen = remaining.slice(first.idx + first.match[0].length);
      const closeMatch = afterOpen.match(/<\/(?:think|thought|reasoning|thought_process)>|\[\/THINK\]/i);
      if (closeMatch && closeMatch.index !== undefined) {
        const thoughtContent = afterOpen.slice(0, closeMatch.index).trim();
        if (thoughtContent) {
          segments.push({ type: "think", content: thoughtContent, open: false });
        }
        remaining = afterOpen.slice(closeMatch.index + closeMatch[0].length);
      } else {
        const thoughtContent = afterOpen.trim();
        if (thoughtContent) {
          segments.push({ type: "think", content: thoughtContent, open: true });
        }
        remaining = "";
      }
    } else if (first.type === "close_think") {
      const thoughtContent = prefix.replace(/^<(?:think|thought|reasoning|thought_process)>\s*|^\[THINK\]\s*/i, "").trim();
      if (thoughtContent) {
        segments.push({ type: "think", content: thoughtContent, open: false });
      }
      remaining = remaining.slice(first.idx + first.match[0].length);
    } else if (first.type === "tool_call" || first.type === "fn_call") {
      if (prefix.trim()) segments.push({ type: "markdown", content: prefix.trim() });

      let toolName = "terminal";
      let toolCmd = "";

      if (first.type === "tool_call") {
        const inner = first.match[1].trim();
        try {
          const parsed = JSON.parse(inner);
          if (parsed && typeof parsed === "object") {
            toolName = parsed.name || parsed.function?.name || "terminal";
            const args = parsed.arguments || parsed.parameters || parsed.function?.arguments || parsed;
            toolCmd = typeof args === "string" ? args : JSON.stringify(args);
          }
        } catch {}

        if (!toolCmd) {
          const innerFn = inner.match(/<function(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)(?:<\/function>|$)/i);
          if (innerFn) {
            toolName = innerFn[1].trim();
            const paramMatches = [...innerFn[2].matchAll(/<parameter(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)<\/parameter>/gi)];
            toolCmd = paramMatches.length > 0 ? paramMatches.map((m) => m[2].trim()).join("\n") : innerFn[2].trim();
          } else {
            toolCmd = inner;
          }
        }
      } else if (first.type === "fn_call") {
        toolName = first.match[1].trim();
        const paramMatches = [...first.match[2].matchAll(/<parameter(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)<\/parameter>/gi)];
        toolCmd = paramMatches.length > 0 ? paramMatches.map((m) => m[2].trim()).join("\n") : first.match[2].trim();
      }

      let matchedToolIndex = toolsPool.findIndex((t) => {
        if (t.arguments && toolCmd) {
          const normA = t.arguments.replace(/\s+/g, " ").trim();
          const normB = toolCmd.replace(/\s+/g, " ").trim();
          if (normA === normB || normA.includes(normB) || normB.includes(normA)) return true;
        }
        return t.name === toolName;
      });

      let matchedTool: ToolEvent | null = null;
      if (matchedToolIndex !== -1) {
        matchedTool = toolsPool.splice(matchedToolIndex, 1)[0];
      } else if (toolsPool.length > 0) {
        matchedTool = toolsPool.shift() || null;
      }

      const toolObj: ToolEvent = matchedTool || {
        id: `inline_call_${++toolIdx}`,
        name: toolName,
        arguments: toolCmd,
      };

      segments.push({ type: "tool", tool: toolObj });
      remaining = remaining.slice(first.idx + first.match[0].length);
    }
  }

  // Any remaining unassigned tools
  while (toolsPool.length > 0) {
    const t = toolsPool.shift()!;
    segments.push({ type: "tool", tool: t });
  }

  return segments;
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
  const segments = useMemo(
    () => parseChronologicalSegments(content, tools),
    [content, tools],
  );

  if (segments.length === 0) {
    return <Markdown content={content} />;
  }

  return (
    <div className="space-y-2">
      {segments.map((seg, idx) => {
        if (seg.type === "think") {
          return (
            <details
              key={`think_${idx}`}
              className="my-2 rounded-md border border-term-border bg-term-panel/80 px-3 py-1.5 text-xs text-term-dim shadow-sm"
              open={seg.open}
            >
              <summary className="cursor-pointer select-none font-semibold text-[11px] uppercase tracking-wider text-term-amber hover:text-term-fg transition-colors">
                {seg.open ? "⚡ Thinking Process…" : "💡 Thought Process"}
              </summary>
              <div className="mt-2 whitespace-pre-wrap font-mono text-[11px] sm:text-xs leading-relaxed text-term-fg border-l-2 border-term-amber/50 pl-2.5">
                {seg.content}
              </div>
            </details>
          );
        }

        if (seg.type === "tool") {
          return <ToolCall key={seg.tool.id || `tool_${idx}`} tool={seg.tool} />;
        }

        return <Markdown key={`md_${idx}`} content={seg.content} />;
      })}
    </div>
  );
}

function ToolCall({ tool }: { tool: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const [localRunning, setLocalRunning] = useState(false);
  const [localResult, setLocalResult] = useState<string | null>(tool.result || null);

  const isDone = Boolean(localResult || tool.result);
  const displayResult = localResult || tool.result;

  const handleRunInTerminal = async (e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    let cmd = tool.arguments || "";
    try {
      const parsed = JSON.parse(cmd);
      if (typeof parsed === "object") {
        cmd = parsed.command || parsed.cmd || parsed.code || cmd;
      }
    } catch {}

    if (!cmd.trim()) return;

    setLocalRunning(true);
    try {
      // 1. Try executing via backend API if available
      const backendUrl = typeof window !== "undefined" ? localStorage.getItem("edgerunner.backendUrl") : null;
      let executed = false;
      let outputText = "";

      if (backendUrl) {
        try {
          const res = await fetch(`${backendUrl.replace(/\/+$/, "")}/api/terminal/exec`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: cmd }),
          });
          if (res.ok) {
            const data = await res.json();
            outputText = data.output ? `${data.output}\n● exit ${data.exit_code}` : `● exit ${data.exit_code}`;
            executed = true;
          }
        } catch {}
      }

      // 2. Fallback to in-browser WebAssembly shell execution
      if (!executed) {
        const { wasmShell } = await import("@/lib/wasmShell");
        const res = await wasmShell.execute(cmd);
        outputText = res.output ? `${res.output}\n● exit ${res.exitCode}` : `● exit ${res.exitCode}`;
      }

      setLocalResult(outputText);
      setOpen(true);
    } catch (err: unknown) {
      setLocalResult(`error: ${err instanceof Error ? err.message : String(err)}`);
      setOpen(true);
    } finally {
      setLocalRunning(false);
    }
  };

  const isFailed = Boolean(
    displayResult &&
      ((displayResult.includes("exit code") && !displayResult.includes("exit code 0") && !displayResult.includes("● exit 0")) ||
        displayResult.startsWith("error:") ||
        displayResult.includes("[stderr]"))
  );

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
            <span className="flex items-center gap-1.5 text-[10px] text-term-green animate-pulse font-medium">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-term-green"></span>
              <span>{localRunning ? "running…" : "executing…"}</span>
            </span>
          )}
          {isDone && (
            <div className="flex items-center gap-1.5">
              {isFailed && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRunInTerminal();
                  }}
                  disabled={localRunning}
                  className="flex items-center gap-1 rounded bg-term-red/10 border border-term-red/40 px-1.5 py-0.5 text-[10px] font-semibold text-term-red hover:bg-term-red/20 transition-colors"
                  title="Execution failed. Click to re-run in active terminal"
                >
                  <span>{localRunning ? "retrying…" : "↺ Retry in Terminal"}</span>
                </button>
              )}
              <span className="text-[10px] text-term-dim">
                {open ? "▾ hide" : "▸ result"}
              </span>
            </div>
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
