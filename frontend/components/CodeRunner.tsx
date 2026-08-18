"use client";

import { useState } from "react";
import { broadcastTerminalEntry } from "@/lib/useTerminal";
import { wasmShell } from "@/lib/wasmShell";

const RUNNABLE_LANGS = new Set([
  "python",
  "py",
  "python3",
  "bash",
  "sh",
  "shell",
  "zsh",
  "cmd",
  "javascript",
  "js",
  "mjs",
  "node",
  "html",
  "htm",
  "c",
  "cpp",
  "go",
  "rust",
  "rs",
]);

import { getBackendBase } from "@/lib/api";

export function isRunnable(lang: string | null): boolean {
  if (!lang) return false;
  return RUNNABLE_LANGS.has(lang.toLowerCase());
}

export function CodeRunner({
  getCode,
  lang,
}: {
  getCode: () => string;
  lang: string;
}) {
  const l = lang.toLowerCase();
  const isHtml = l === "html" || l === "htm";

  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [htmlPreviewCode, setHtmlPreviewCode] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<boolean>(true);

  async function run() {
    const rawCode = getCode().trim();
    if (!rawCode) return;

    if (isHtml) {
      setHtmlPreviewCode(rawCode);
      return;
    }

    setRunning(true);
    setOutput(null);
    setExitCode(null);
    setDurationMs(null);

    // Build command based on language
    let cmd = rawCode;
    if (l === "python" || l === "py" || l === "python3") {
      const escaped = rawCode.replace(/'/g, "'\"'\"'");
      cmd = `python3 -c '${escaped}'`;
    } else if (l === "javascript" || l === "js" || l === "node" || l === "mjs") {
      const escaped = rawCode.replace(/'/g, "'\"'\"'");
      cmd = `node -e '${escaped}'`;
    }

    const startTime = performance.now();
    try {
      const base = getBackendBase();
      const url = `${base}/api/terminal/exec`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });

      if (res.ok) {
        const data = await res.json();
        const elapsed = data.duration_ms || Math.round(performance.now() - startTime);
        setOutput(data.output || "(no output)");
        setExitCode(data.exit_code);
        setDurationMs(elapsed);

        // Broadcast to shared terminal console
        broadcastTerminalEntry({
          id: Math.random().toString(36).slice(2),
          timestamp: new Date().toLocaleTimeString(),
          type: "run",
          command: cmd,
          output: data.output,
          exitCode: data.exit_code,
          durationMs: elapsed,
        });
        setRunning(false);
        return;
      }
    } catch {
      // Backend offline -> Fallback to In-Browser WebAssembly Engine
    }

    try {
      // In-Browser Wasm Fallback (Pyodide Python / JS sandbox / Wasm Shell)
      const wasmRes = await wasmShell.execute(cmd);
      const elapsed = wasmRes.durationMs || Math.round(performance.now() - startTime);
      setOutput(wasmRes.output || "(no output)");
      setExitCode(wasmRes.exitCode);
      setDurationMs(elapsed);

      broadcastTerminalEntry({
        id: Math.random().toString(36).slice(2),
        timestamp: new Date().toLocaleTimeString(),
        type: "run",
        command: cmd,
        output: wasmRes.output,
        exitCode: wasmRes.exitCode,
        durationMs: elapsed,
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="border-t border-term-border/60 bg-term-panel/40 px-3 py-2 text-xs font-mono select-none">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={run}
          disabled={running}
          className="flex items-center gap-1.5 rounded border border-term-green/60 bg-term-green/10 px-2.5 py-1 text-[11px] font-semibold text-term-green transition-all hover:bg-term-green/20 hover:border-term-green hover:shadow-[0_0_12px_rgba(57,255,20,0.25)] active:scale-95 disabled:opacity-50"
          title="Execute code in the shared workspace sandbox"
        >
          <span>{running ? "⚡" : "▶"}</span>
          <span>{running ? "running…" : "run in workspace"}</span>
        </button>

        {exitCode !== null && (
          <div className="flex items-center gap-2 text-[10px]">
            <span
              className={`rounded px-1.5 py-0.2 font-bold ${
                exitCode === 0
                  ? "bg-term-green/20 text-term-green border border-term-green/40"
                  : "bg-term-red/20 text-term-red border border-term-red/40"
              }`}
            >
              ● exit {exitCode}
            </span>
            {durationMs !== null && (
              <span className="text-term-dim">{durationMs}ms</span>
            )}
            <button
              onClick={() => setExpanded((x) => !x)}
              className="text-term-dim hover:text-term-fg text-[9px] transition-colors"
            >
              {expanded ? "▾ hide" : "▸ show"}
            </button>
          </div>
        )}
      </div>

      {/* HTML Sandboxed Preview */}
      {htmlPreviewCode && (
        <div className="mt-2 rounded border border-term-border overflow-hidden bg-white">
          <iframe
            title="HTML Preview"
            sandbox="allow-scripts"
            className="w-full h-48 border-0"
            srcDoc={htmlPreviewCode}
          />
        </div>
      )}

      {/* Execution Output */}
      {output !== null && expanded && !isHtml && (
        <div className="mt-2 rounded border border-term-border/80 bg-term-bg/95 p-2 text-xs font-mono text-term-fg leading-relaxed overflow-x-auto max-h-48 whitespace-pre-wrap select-text shadow-inner">
          {output}
        </div>
      )}
    </div>
  );
}
