"use client";

import { useCallback, useEffect, useState } from "react";
import { getBackendBase } from "@/lib/api";
import { wasmShell } from "@/lib/wasmShell";

export interface TerminalEntry {
  id: string;
  timestamp: string;
  type: "user" | "agent" | "run";
  command: string;
  output: string;
  exitCode: number;
  durationMs?: number;
}

export interface UseTerminal {
  entries: TerminalEntry[];
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  toggle: () => void;
  isRunning: boolean;
  executeCommand: (command: string, type?: "user" | "agent" | "run") => Promise<TerminalEntry>;
  clear: () => void;
}

// Global event bus for broadcasting code executions to the terminal console
type TerminalListener = (entry: TerminalEntry) => void;
const listeners = new Set<TerminalListener>();

export function broadcastTerminalEntry(entry: TerminalEntry) {
  listeners.forEach((fn) => fn(entry));
}

export function useTerminal(): UseTerminal {
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [isRunning, setIsRunning] = useState<boolean>(false);

  useEffect(() => {
    const handler: TerminalListener = (entry) => {
      setEntries((prev) => [...prev, entry]);
    };
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, []);

  const toggle = useCallback(() => setIsOpen((prev) => !prev), []);
  const clear = useCallback(() => setEntries([]), []);

  const executeCommand = useCallback(
    async (command: string, type: "user" | "agent" | "run" = "user"): Promise<TerminalEntry> => {
      const cleanCmd = command.trim();
      if (!cleanCmd) {
        throw new Error("Empty command");
      }

      setIsRunning(true);
      const startTime = performance.now();
      const timeStr = new Date().toLocaleTimeString();

      try {
        try {
          const base = getBackendBase();
          const url = `${base}/api/terminal/exec`;
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: cleanCmd }),
          });

          if (res.ok) {
            const data = (await res.json()) as {
              output: string;
              exit_code: number;
              duration_ms: number;
            };

            const entry: TerminalEntry = {
              id: Math.random().toString(36).slice(2),
              timestamp: timeStr,
              type,
              command: cleanCmd,
              output: data.output,
              exitCode: data.exit_code,
              durationMs: data.duration_ms,
            };

            setEntries((prev) => [...prev, entry]);
            return entry;
          }
        } catch {
          // Backend offline -> Fallback to client-side WebAssembly Shell
        }

        const wasmRes = await wasmShell.execute(cleanCmd);
        const entry: TerminalEntry = {
          id: Math.random().toString(36).slice(2),
          timestamp: timeStr,
          type,
          command: cleanCmd,
          output: wasmRes.output,
          exitCode: wasmRes.exitCode,
          durationMs: wasmRes.durationMs || Math.round(performance.now() - startTime),
        };

        setEntries((prev) => [...prev, entry]);
        return entry;
      } finally {
        setIsRunning(false);
      }
    },
    [],
  );

  return {
    entries,
    isOpen,
    setIsOpen,
    toggle,
    isRunning,
    executeCommand,
    clear,
  };
}
