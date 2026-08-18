"use client";

import { useEffect, useRef, useState } from "react";
import { wasmShell, vfs } from "@/lib/wasmShell";

interface InteractiveTerminalProps {
  initialCommand?: string;
  onClose?: () => void;
  isDrawer?: boolean;
  className?: string;
}

const darkTheme = {
  background: "#0a0e0a",
  foreground: "#f4d5fd",
  cursor: "#39FF14",
  cursorAccent: "#0a0e0a",
  selectionBackground: "#39ff1433",
  black: "#1e2a1e",
  red: "#e6483e",
  green: "#39FF14",
  yellow: "#e6b23e",
  blue: "#38bdf8",
  magenta: "#c084fc",
  cyan: "#2dd4bf",
  white: "#f4d5fd",
  brightBlack: "#4a5a4a",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fbbf24",
  brightBlue: "#60a5fa",
  brightMagenta: "#e879f9",
  brightCyan: "#5eead4",
  brightWhite: "#ffffff",
};

const lightTheme = {
  background: "#eceff3",
  foreground: "#030712",
  cursor: "#0284c7",
  cursorAccent: "#eceff3",
  selectionBackground: "#0284c733",
  black: "#94a3b8",
  red: "#e11d48",
  green: "#0284c7",
  yellow: "#d97706",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#030712",
  brightBlack: "#64748b",
  brightRed: "#f43f5e",
  brightGreen: "#0ea5e9",
  brightYellow: "#f59e0b",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#000000",
};

interface NanoEditorState {
  active: boolean;
  type: "nano" | "vim";
  filename: string;
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  scrollRow: number;
  isModified: boolean;
  promptExit: boolean;
  status: string;
  vimMode: "insert" | "normal" | "command";
  vimCmd: string;
}

export function InteractiveTerminal({
  initialCommand,
  onClose,
  isDrawer = false,
  className = "",
}: InteractiveTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<any>(null);
  const fitAddonRef = useRef<any>(null);
  const bufferRef = useRef<string>("");
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1);
  const runningRef = useRef<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const editorRef = useRef<NanoEditorState>({
    active: false,
    type: "nano",
    filename: "",
    lines: [""],
    cursorRow: 0,
    cursorCol: 0,
    scrollRow: 0,
    isModified: false,
    promptExit: false,
    status: "",
    vimMode: "normal",
    vimCmd: "",
  });

  // Load history from localStorage
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("edgerunner.cmd_history") || "[]");
      if (Array.isArray(saved)) historyRef.current = saved;
    } catch {}
  }, []);

  const PROMPT = "\x1b[1;32medgerunner\x1b[0m:\x1b[1;34m~/workspace\x1b[0m$ ";

  // Watch for Theme changes on <html data-theme="...">
  useEffect(() => {
    function applyCurrentTheme() {
      if (typeof document === "undefined") return;
      const isLight = document.documentElement.getAttribute("data-theme") === "light";
      if (termRef.current) {
        termRef.current.options.theme = isLight ? lightTheme : darkTheme;
      }
    }
    applyCurrentTheme();
    const observer = new MutationObserver(applyCurrentTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // Renders the full in-terminal nano or vim editor screen
  function renderNanoScreen(term: any) {
    const ed = editorRef.current;
    const rows = term.rows || 24;
    const cols = term.cols || 80;
    const viewRows = Math.max(5, rows - 4);

    // Keep cursor in view
    if (ed.cursorRow < ed.scrollRow) {
      ed.scrollRow = ed.cursorRow;
    } else if (ed.cursorRow >= ed.scrollRow + viewRows) {
      ed.scrollRow = ed.cursorRow - viewRows + 1;
    }

    let out = "\x1b[H\x1b[2J"; // Home and clear

    // 1. Top Header Bar
    const titleText = ed.type === "nano" ? "  GNU nano 7.2" : "  VIM - Vi IMproved";
    const modMarker = ed.isModified ? "Modified" : "";
    const headerLeft = `${titleText}                ${ed.filename}`;
    const headerPad = Math.max(1, cols - headerLeft.length - modMarker.length - 2);
    const header = `${headerLeft}${" ".repeat(headerPad)}${modMarker}  `;
    out += `\x1b[7m${header.slice(0, cols)}\x1b[0m\r\n`;

    // 2. Editor Text Body
    for (let r = 0; r < viewRows; r++) {
      const lineIdx = ed.scrollRow + r;
      if (lineIdx < ed.lines.length) {
        const line = ed.lines[lineIdx] || "";
        out += `${line.slice(0, cols)}\r\n`;
      } else {
        out += `\x1b[34m~\x1b[0m\r\n`;
      }
    }

    // 3. Status Bar
    let statusText = ed.status || (ed.promptExit ? "Save modified buffer (ANSWERING \"No\" WILL DESTROY CHANGES) ? (Y/N)" : "");
    if (ed.type === "vim") {
      if (ed.vimMode === "insert") statusText = "-- INSERT --";
      else if (ed.vimMode === "command") statusText = `:${ed.vimCmd}`;
    }
    const statusPad = Math.max(0, cols - statusText.length);
    out += `\x1b[7m${statusText}${" ".repeat(statusPad)}\x1b[0m\r\n`;

    // 4. Shortcut Help Bar (for Nano)
    if (ed.type === "nano") {
      const helpRow1 = "^G Get Help   ^O WriteOut   ^W Where Is   ^K Cut Text   ^J Justify";
      const helpRow2 = "^X Exit       ^R Read File  ^\\ Replace    ^U Paste      ^T Execute";
      out += `\x1b[7m${helpRow1.slice(0, cols)}\x1b[0m\r\n`;
      out += `\x1b[7m${helpRow2.slice(0, cols)}\x1b[0m`;
    }

    // 5. Position cursor in terminal
    const screenCursorRow = 2 + (ed.cursorRow - ed.scrollRow);
    const screenCursorCol = 1 + ed.cursorCol;
    out += `\x1b[${screenCursorRow};${screenCursorCol}H`;

    term.write(out);
  }

  function openInTerminalEditor(term: any, type: "nano" | "vim", filename: string) {
    let content = vfs.readFile(filename);
    let lines = [""];
    if (content !== null) {
      lines = content.split("\n");
    } else {
      vfs.writeFile(filename, "");
    }
    if (lines.length === 0) lines = [""];

    editorRef.current = {
      active: true,
      type,
      filename,
      lines,
      cursorRow: 0,
      cursorCol: 0,
      scrollRow: 0,
      isModified: false,
      promptExit: false,
      status: `[ Read ${lines.length} lines ]`,
      vimMode: "normal",
      vimCmd: "",
    };

    term.write("\x1b[?1049h"); // Alternate screen buffer
    renderNanoScreen(term);
  }

  function closeInTerminalEditor(term: any) {
    editorRef.current.active = false;
    term.write("\x1b[?1049l"); // Restore primary screen buffer
    term.reset();
    term.write(PROMPT);
  }

  function handleEditorInput(data: string, term: any) {
    const ed = editorRef.current;

    // --- NANO INPUT HANDLING ---
    if (ed.type === "nano") {
      // Exit prompt answering (Y/N)
      if (ed.promptExit) {
        if (data.toLowerCase() === "y") {
          vfs.writeFile(ed.filename, ed.lines.join("\n"));
          closeInTerminalEditor(term);
          return;
        } else if (data.toLowerCase() === "n") {
          closeInTerminalEditor(term);
          return;
        } else if (data === "\x03" || data === "\x18") {
          ed.promptExit = false;
          ed.status = "[ Cancelled ]";
          renderNanoScreen(term);
          return;
        }
        return;
      }

      // Ctrl+X (Exit)
      if (data === "\x18") {
        if (ed.isModified) {
          ed.promptExit = true;
          renderNanoScreen(term);
        } else {
          closeInTerminalEditor(term);
        }
        return;
      }

      // Ctrl+O (WriteOut / Save)
      if (data === "\x0f") {
        vfs.writeFile(ed.filename, ed.lines.join("\n"));
        ed.isModified = false;
        ed.status = `[ Wrote ${ed.lines.length} lines to ${ed.filename} ]`;
        renderNanoScreen(term);
        return;
      }

      // Ctrl+G (Help)
      if (data === "\x07") {
        ed.status = "GNU nano 7.2: Type text directly, ^O to save, ^X to exit.";
        renderNanoScreen(term);
        return;
      }

      // Arrow Keys
      if (data.startsWith("\x1b[")) {
        const code = data.slice(2);
        if (code === "A") {
          // Up
          ed.cursorRow = Math.max(0, ed.cursorRow - 1);
          ed.cursorCol = Math.min(ed.cursorCol, (ed.lines[ed.cursorRow] || "").length);
        } else if (code === "B") {
          // Down
          ed.cursorRow = Math.min(ed.lines.length - 1, ed.cursorRow + 1);
          ed.cursorCol = Math.min(ed.cursorCol, (ed.lines[ed.cursorRow] || "").length);
        } else if (code === "C") {
          // Right
          const curLen = (ed.lines[ed.cursorRow] || "").length;
          if (ed.cursorCol < curLen) ed.cursorCol++;
          else if (ed.cursorRow < ed.lines.length - 1) {
            ed.cursorRow++;
            ed.cursorCol = 0;
          }
        } else if (code === "D") {
          // Left
          if (ed.cursorCol > 0) ed.cursorCol--;
          else if (ed.cursorRow > 0) {
            ed.cursorRow--;
            ed.cursorCol = (ed.lines[ed.cursorRow] || "").length;
          }
        }
        ed.status = "";
        renderNanoScreen(term);
        return;
      }

      // Enter
      if (data === "\r" || data === "\n") {
        const curLine = ed.lines[ed.cursorRow] || "";
        const head = curLine.slice(0, ed.cursorCol);
        const tail = curLine.slice(ed.cursorCol);
        ed.lines[ed.cursorRow] = head;
        ed.lines.splice(ed.cursorRow + 1, 0, tail);
        ed.cursorRow++;
        ed.cursorCol = 0;
        ed.isModified = true;
        ed.status = "";
        renderNanoScreen(term);
        return;
      }

      // Backspace
      if (data === "\x7f" || data === "\b") {
        if (ed.cursorCol > 0) {
          const curLine = ed.lines[ed.cursorRow] || "";
          ed.lines[ed.cursorRow] = curLine.slice(0, ed.cursorCol - 1) + curLine.slice(ed.cursorCol);
          ed.cursorCol--;
          ed.isModified = true;
        } else if (ed.cursorRow > 0) {
          const prevLine = ed.lines[ed.cursorRow - 1] || "";
          const curLine = ed.lines[ed.cursorRow] || "";
          ed.cursorCol = prevLine.length;
          ed.lines[ed.cursorRow - 1] = prevLine + curLine;
          ed.lines.splice(ed.cursorRow, 1);
          ed.cursorRow--;
          ed.isModified = true;
        }
        ed.status = "";
        renderNanoScreen(term);
        return;
      }

      // Regular character
      if (data >= " " && data <= "~") {
        const curLine = ed.lines[ed.cursorRow] || "";
        ed.lines[ed.cursorRow] = curLine.slice(0, ed.cursorCol) + data + curLine.slice(ed.cursorCol);
        ed.cursorCol++;
        ed.isModified = true;
        ed.status = "";
        renderNanoScreen(term);
        return;
      }
    }

    // --- VIM INPUT HANDLING ---
    if (ed.type === "vim") {
      if (ed.vimMode === "normal") {
        if (data === "i") {
          ed.vimMode = "insert";
          renderNanoScreen(term);
          return;
        }
        if (data === ":") {
          ed.vimMode = "command";
          ed.vimCmd = "";
          renderNanoScreen(term);
          return;
        }
        if (data === "h" || data === "\x1b[D") {
          if (ed.cursorCol > 0) ed.cursorCol--;
          renderNanoScreen(term);
          return;
        }
        if (data === "l" || data === "\x1b[C") {
          const curLen = (ed.lines[ed.cursorRow] || "").length;
          if (ed.cursorCol < curLen - 1) ed.cursorCol++;
          renderNanoScreen(term);
          return;
        }
        if (data === "k" || data === "\x1b[A") {
          ed.cursorRow = Math.max(0, ed.cursorRow - 1);
          ed.cursorCol = Math.min(ed.cursorCol, (ed.lines[ed.cursorRow] || "").length);
          renderNanoScreen(term);
          return;
        }
        if (data === "j" || data === "\x1b[B") {
          ed.cursorRow = Math.min(ed.lines.length - 1, ed.cursorRow + 1);
          ed.cursorCol = Math.min(ed.cursorCol, (ed.lines[ed.cursorRow] || "").length);
          renderNanoScreen(term);
          return;
        }
        if (data === "x") {
          const curLine = ed.lines[ed.cursorRow] || "";
          if (curLine.length > 0) {
            ed.lines[ed.cursorRow] = curLine.slice(0, ed.cursorCol) + curLine.slice(ed.cursorCol + 1);
            ed.isModified = true;
            renderNanoScreen(term);
          }
          return;
        }
      } else if (ed.vimMode === "insert") {
        if (data === "\x1b") {
          ed.vimMode = "normal";
          renderNanoScreen(term);
          return;
        }
        if (data === "\r" || data === "\n") {
          const curLine = ed.lines[ed.cursorRow] || "";
          const head = curLine.slice(0, ed.cursorCol);
          const tail = curLine.slice(ed.cursorCol);
          ed.lines[ed.cursorRow] = head;
          ed.lines.splice(ed.cursorRow + 1, 0, tail);
          ed.cursorRow++;
          ed.cursorCol = 0;
          ed.isModified = true;
          renderNanoScreen(term);
          return;
        }
        if (data === "\x7f" || data === "\b") {
          if (ed.cursorCol > 0) {
            const curLine = ed.lines[ed.cursorRow] || "";
            ed.lines[ed.cursorRow] = curLine.slice(0, ed.cursorCol - 1) + curLine.slice(ed.cursorCol);
            ed.cursorCol--;
            ed.isModified = true;
          }
          renderNanoScreen(term);
          return;
        }
        if (data >= " " && data <= "~") {
          const curLine = ed.lines[ed.cursorRow] || "";
          ed.lines[ed.cursorRow] = curLine.slice(0, ed.cursorCol) + data + curLine.slice(ed.cursorCol);
          ed.cursorCol++;
          ed.isModified = true;
          renderNanoScreen(term);
          return;
        }
      } else if (ed.vimMode === "command") {
        if (data === "\x1b") {
          ed.vimMode = "normal";
          ed.vimCmd = "";
          renderNanoScreen(term);
          return;
        }
        if (data === "\r" || data === "\n") {
          const cmd = ed.vimCmd.trim();
          if (cmd === "w") {
            vfs.writeFile(ed.filename, ed.lines.join("\n"));
            ed.isModified = false;
            ed.vimMode = "normal";
            ed.status = `"${ed.filename}" ${ed.lines.length}L written`;
            renderNanoScreen(term);
          } else if (cmd === "q") {
            if (ed.isModified) {
              ed.status = "E37: No write since last change (add ! to override)";
              ed.vimMode = "normal";
              renderNanoScreen(term);
            } else {
              closeInTerminalEditor(term);
            }
          } else if (cmd === "q!") {
            closeInTerminalEditor(term);
          } else if (cmd === "wq" || cmd === "x") {
            vfs.writeFile(ed.filename, ed.lines.join("\n"));
            closeInTerminalEditor(term);
          } else {
            ed.status = `E492: Not an editor command: ${cmd}`;
            ed.vimMode = "normal";
            renderNanoScreen(term);
          }
          return;
        }
        if (data === "\x7f" || data === "\b") {
          if (ed.vimCmd.length > 0) ed.vimCmd = ed.vimCmd.slice(0, -1);
          else ed.vimMode = "normal";
          renderNanoScreen(term);
          return;
        }
        if (data >= " " && data <= "~") {
          ed.vimCmd += data;
          renderNanoScreen(term);
          return;
        }
      }
    }
  }

  useEffect(() => {
    let disposed = false;

    async function initTerminal() {
      if (!containerRef.current) return;

      try {
        const { Terminal } = await import("@xterm/xterm");
        const { FitAddon } = await import("@xterm/addon-fit");

        if (disposed || !containerRef.current) return;

        // Clean existing terminal if any
        containerRef.current.innerHTML = "";

      const isLight = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "light";

      const term = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontSize: 14.5,
        fontFamily: "'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
        theme: isLight ? lightTheme : darkTheme,
        convertEol: true,
        scrollback: 5000,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);

      term.open(containerRef.current);
      fitAddon.fit();

      // Observe theme changes in real-time
      if (typeof document !== "undefined") {
        const themeObserver = new MutationObserver(() => {
          const currentIsLight = document.documentElement.getAttribute("data-theme") === "light";
          term.options.theme = currentIsLight ? lightTheme : darkTheme;
        });
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
      }

      termRef.current = term;
      fitAddonRef.current = fitAddon;

      // Welcome Banner
      term.writeln("\x1b[1;32m╔════════════════════════════════════════════════════════════════════╗\x1b[0m");
      term.writeln("\x1b[1;32m║\x1b[0m \x1b[1;37mEdgeRunner Interactive Terminal (xterm.js + WebAssembly Engine)\x1b[0m   \x1b[1;32m║\x1b[0m");
      term.writeln("\x1b[1;32m║\x1b[0m \x1b[2mType 'nano <file>' or 'vim <file>' for in-terminal editing.\x1b[0m         \x1b[1;32m║\x1b[0m");
      term.writeln("\x1b[1;32m║\x1b[0m \x1b[2mType 'code <file>' or 'vs <file>' to open VS Code Workspace.\x1b[0m        \x1b[1;32m║\x1b[0m");
      term.writeln("\x1b[1;32m╚════════════════════════════════════════════════════════════════════╝\x1b[0m\r\n");
      term.write(PROMPT);

      // Handle Key Input
      term.onData(async (data: string) => {
        // If in nano / vim editor mode, route all keystrokes to editor
        if (editorRef.current.active) {
          handleEditorInput(data, term);
          return;
        }

        if (runningRef.current) {
          // Interrupt with Ctrl+C
          if (data === "\x03") {
            term.writeln("^C");
            runningRef.current = false;
            bufferRef.current = "";
            term.write(PROMPT);
          }
          return;
        }

        // Enter Key
        if (data === "\r" || data === "\n") {
          const rawCmd = bufferRef.current.trim();
          term.writeln("");
          bufferRef.current = "";
          historyIdxRef.current = -1;

          if (!rawCmd) {
            term.write(PROMPT);
            return;
          }

          // Save to command history
          historyRef.current.push(rawCmd);
          try {
            localStorage.setItem(
              "edgerunner.cmd_history",
              JSON.stringify(historyRef.current.slice(-100)),
            );
          } catch {}

          // Handle Built-in clear
          if (rawCmd === "clear") {
            bufferRef.current = "";
            historyIdxRef.current = -1;
            term.reset();
            term.write(PROMPT);
            return;
          }

          // Handle Built-in exit / logout
          if (rawCmd === "exit" || rawCmd === "quit" || rawCmd === "logout") {
            bufferRef.current = "";
            historyIdxRef.current = -1;
            term.writeln("exit");
            term.writeln("\x1b[2m[Process completed]\x1b[0m");
            if (onClose) {
              setTimeout(() => onClose(), 300);
            } else {
              term.write(PROMPT);
            }
            return;
          }

          // Check for in-terminal text editors: nano, vim, vi
          const tokens = rawCmd.split(/\s+/);
          const prog = tokens[0]?.toLowerCase();
          const targetFile = tokens[1] || "untitled.txt";

          if (prog === "nano") {
            openInTerminalEditor(term, "nano", targetFile);
            return;
          }
          if (prog === "vim" || prog === "vi") {
            openInTerminalEditor(term, "vim", targetFile);
            return;
          }

          // Check for VS Code Workspace commands: code, vs, vscode
          if (prog === "code" || prog === "vs" || prog === "vscode" || prog === "workspace") {
            if (typeof window !== "undefined") {
              if (targetFile && targetFile !== ".") {
                window.dispatchEvent(new CustomEvent("edgerunner:open-file", { detail: { path: targetFile } }));
              }
              window.dispatchEvent(new CustomEvent("edgerunner:open-workspace"));
            }
            term.writeln(`\x1b[32m✓ Opened ${targetFile === "." ? "workspace" : targetFile} in VS Code Workspace\x1b[0m`);
            term.write(PROMPT);
            return;
          }

          // Execute via Wasm Shell with streaming chunks
          runningRef.current = true;
          try {
            let lastOutputLen = 0;
            const res = await wasmShell.execute(rawCmd, (chunk) => {
              if (chunk.length > lastOutputLen) {
                const delta = chunk.slice(lastOutputLen);
                term.write(delta.replace(/\n/g, "\r\n"));
                lastOutputLen = chunk.length;
              }
            });

            if (res.output && lastOutputLen === 0) {
              term.writeln(res.output.replace(/\n/g, "\r\n"));
            } else if (lastOutputLen > 0) {
              term.writeln("");
            }

            if (res.exitCode !== 0) {
              term.writeln(`\x1b[31m● exit ${res.exitCode}\x1b[0m`);
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            term.writeln(`\x1b[31merror: ${msg}\x1b[0m`);
          } finally {
            runningRef.current = false;
            term.write(PROMPT);
          }
          return;
        }

        // Backspace
        if (data === "\x7f" || data === "\b") {
          if (bufferRef.current.length > 0) {
            bufferRef.current = bufferRef.current.slice(0, -1);
            term.write("\b \b");
          }
          return;
        }

        // Ctrl+C
        if (data === "\x03") {
          term.writeln("^C");
          bufferRef.current = "";
          historyIdxRef.current = -1;
          term.write(PROMPT);
          return;
        }

        // Ctrl+L (Clear Screen)
        if (data === "\x0c") {
          bufferRef.current = "";
          historyIdxRef.current = -1;
          term.reset();
          term.write(PROMPT);
          return;
        }

        // Tab Autocompletion
        if (data === "\t") {
          const currentText = bufferRef.current;
          const tokens = currentText.split(" ");
          const lastToken = tokens[tokens.length - 1] || "";
          const files = vfs.listFiles();
          const matches = files.filter((f) => f.startsWith(lastToken));

          if (matches.length === 1) {
            const completion = matches[0].slice(lastToken.length);
            bufferRef.current += completion;
            term.write(completion);
          } else if (matches.length > 1) {
            term.writeln("\r\n" + matches.join("  "));
            term.write(PROMPT + bufferRef.current);
          }
          return;
        }

        // Arrow Keys (Escape sequence \x1b[A, \x1b[B, \x1b[C, \x1b[D)
        if (data.startsWith("\x1b[")) {
          const code = data.slice(2);
          // Up Arrow
          if (code === "A" && historyRef.current.length > 0) {
            const hist = historyRef.current;
            const nextIdx =
              historyIdxRef.current === -1
                ? hist.length - 1
                : Math.max(0, historyIdxRef.current - 1);
            historyIdxRef.current = nextIdx;
            const targetCmd = hist[nextIdx];

            while (bufferRef.current.length > 0) {
              term.write("\b \b");
              bufferRef.current = bufferRef.current.slice(0, -1);
            }
            bufferRef.current = targetCmd;
            term.write(targetCmd);
            return;
          }

          // Down Arrow
          if (code === "B" && historyIdxRef.current !== -1) {
            const hist = historyRef.current;
            const nextIdx = historyIdxRef.current + 1;

            while (bufferRef.current.length > 0) {
              term.write("\b \b");
              bufferRef.current = bufferRef.current.slice(0, -1);
            }

            if (nextIdx >= hist.length) {
              historyIdxRef.current = -1;
              bufferRef.current = "";
            } else {
              historyIdxRef.current = nextIdx;
              const targetCmd = hist[nextIdx];
              bufferRef.current = targetCmd;
              term.write(targetCmd);
            }
            return;
          }
          return;
        }

        // Regular printable character
        if (data >= " " && data <= "~") {
          bufferRef.current += data;
          term.write(data);
        }
      });

      // Handle ResizeObserver
      const resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon.fit();
        } catch {}
      });
      resizeObserver.observe(containerRef.current);

      // Execute initial command if provided
      if (initialCommand) {
        setTimeout(async () => {
          term.writeln(initialCommand);
          runningRef.current = true;
          try {
            const res = await wasmShell.execute(initialCommand);
            if (res.output) term.writeln(res.output.replace(/\n/g, "\r\n"));
            if (res.exitCode !== 0) term.writeln(`\x1b[31m● exit ${res.exitCode}\x1b[0m`);
          } finally {
            runningRef.current = false;
            term.write(PROMPT);
          }
        }, 100);
      }
      } catch (err) {
        console.warn("xterm terminal init error:", err);
      }
    }

    initTerminal();

    function handleOpenTerminalEditor(e: any) {
      if (termRef.current && e.detail?.editor && e.detail?.file) {
        openInTerminalEditor(termRef.current, e.detail.editor, e.detail.file);
      }
    }
    window.addEventListener("edgerunner:open-terminal-editor", handleOpenTerminalEditor);

    return () => {
      disposed = true;
      window.removeEventListener("edgerunner:open-terminal-editor", handleOpenTerminalEditor);
      if (termRef.current) {
        termRef.current.dispose();
      }
    };
  }, [initialCommand]);

  function handleClear() {
    if (termRef.current) {
      bufferRef.current = "";
      historyIdxRef.current = -1;
      runningRef.current = false;
      editorRef.current.active = false;
      termRef.current.reset();
      termRef.current.write(PROMPT);
    }
  }

  function handleCopyAll() {
    if (termRef.current) {
      termRef.current.selectAll();
      const selection = termRef.current.getSelection();
      navigator.clipboard.writeText(selection);
      termRef.current.clearSelection();
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className={`flex flex-col h-full w-full bg-term-bg border border-term-border rounded-lg overflow-hidden font-mono text-xs shadow-2xl ${className}`}>
      {/* Terminal Toolbar Header */}
      <div className="flex items-center justify-between border-b border-term-border bg-term-panel px-3 py-1.5 shrink-0 select-none text-[11px]">
        <div className="flex items-center gap-2">
          <span className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-term-red" />
            <span className="h-2.5 w-2.5 rounded-full bg-term-amber" />
            <span className="h-2.5 w-2.5 rounded-full bg-term-green" />
          </span>
          <span className="text-term-fg font-semibold ml-1">wasm-bash / pty</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyAll}
            className="rounded border border-term-border px-1.5 py-0.5 text-[10px] text-term-dim hover:text-term-fg transition-colors"
            title="Copy terminal contents"
          >
            {copied ? "copied" : "copy"}
          </button>
          <button
            onClick={handleClear}
            className="rounded border border-term-border px-1.5 py-0.5 text-[10px] text-term-dim hover:text-term-fg transition-colors"
            title="Clear terminal screen"
          >
            clear
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-term-dim hover:text-term-fg px-1 text-xs"
              title="Close terminal"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Terminal Container */}
      <div
        ref={containerRef}
        className="flex-1 w-full h-full p-2 overflow-hidden bg-[#0a0e0a]"
        style={{ minHeight: "150px" }}
      />

      {/* Mobile Soft-Keys Helper Bar */}
      <div className="flex sm:hidden items-center justify-between border-t border-term-border/60 bg-term-panel/80 px-2 py-1 gap-1 overflow-x-auto text-[10px] select-none shrink-0">
        <div className="flex items-center gap-1 overflow-x-auto">
          <button
            onClick={() => {
              if (termRef.current) {
                if (editorRef.current.active) {
                  handleEditorInput("\x1b", termRef.current);
                } else {
                  termRef.current.write("^[\r\n" + PROMPT);
                }
              }
            }}
            className="rounded border border-term-border bg-term-bg px-2 py-0.5 font-bold text-term-dim active:text-term-green"
          >
            Esc
          </button>
          <button
            onClick={() => {
              if (termRef.current) {
                if (editorRef.current.active) {
                  handleEditorInput("\t", termRef.current);
                } else {
                  bufferRef.current += "  ";
                  termRef.current.write("  ");
                }
              }
            }}
            className="rounded border border-term-border bg-term-bg px-2 py-0.5 font-bold text-term-dim active:text-term-green"
          >
            Tab
          </button>
          <button
            onClick={() => {
              if (termRef.current) {
                runningRef.current = false;
                bufferRef.current = "";
                termRef.current.writeln("^C");
                termRef.current.write(PROMPT);
              }
            }}
            className="rounded border border-term-border bg-term-bg px-2 py-0.5 font-bold text-term-red active:bg-term-red/20"
          >
            ^C
          </button>
          <button
            onClick={() => {
              if (termRef.current) {
                if (editorRef.current.active) {
                  handleEditorInput("\x1b[A", termRef.current);
                } else if (historyRef.current.length > 0) {
                  const idx = historyIdxRef.current === -1 ? historyRef.current.length - 1 : Math.max(0, historyIdxRef.current - 1);
                  historyIdxRef.current = idx;
                  const prevCmd = historyRef.current[idx];
                  while (bufferRef.current.length > 0) {
                    termRef.current.write("\b \b");
                    bufferRef.current = bufferRef.current.slice(0, -1);
                  }
                  bufferRef.current = prevCmd;
                  termRef.current.write(prevCmd);
                }
              }
            }}
            className="rounded border border-term-border bg-term-bg px-2 py-0.5 font-bold text-term-dim active:text-term-green"
          >
            ▲
          </button>
          <button
            onClick={() => {
              if (termRef.current) {
                if (editorRef.current.active) {
                  handleEditorInput("\x1b[B", termRef.current);
                } else if (historyIdxRef.current !== -1) {
                  const idx = historyIdxRef.current + 1;
                  while (bufferRef.current.length > 0) {
                    termRef.current.write("\b \b");
                    bufferRef.current = bufferRef.current.slice(0, -1);
                  }
                  if (idx >= historyRef.current.length) {
                    historyIdxRef.current = -1;
                    bufferRef.current = "";
                  } else {
                    historyIdxRef.current = idx;
                    const nextCmd = historyRef.current[idx];
                    bufferRef.current = nextCmd;
                    termRef.current.write(nextCmd);
                  }
                }
              }
            }}
            className="rounded border border-term-border bg-term-bg px-2 py-0.5 font-bold text-term-dim active:text-term-green"
          >
            ▼
          </button>
          <button
            onClick={handleClear}
            className="rounded border border-term-border bg-term-bg px-2 py-0.5 text-term-dim active:text-term-fg"
          >
            clear
          </button>
          <button
            onClick={() => {
              if (onClose) onClose();
            }}
            className="rounded border border-term-border bg-term-bg px-2 py-0.5 text-term-dim active:text-term-fg"
          >
            exit
          </button>
        </div>
      </div>
    </div>
  );
}
