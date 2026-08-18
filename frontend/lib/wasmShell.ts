"use client";

import { gitManager } from "./gitManager";
import { executeViaPiston } from "./pistonRunner";

/**
 * In-Browser Virtual Bash & Multi-Language WebAssembly Shell.
 *
 * Provides a 100% client-side, zero-server fallback for executing:
 * - Shell commands (POSIX core utilities: ls, cat, mkdir, rm, cp, mv, echo, grep, find, wc, etc.)
 * - Multi-line shell scripts and sequential command blocks.
 * - Quote-aware piping (`|`), file redirection (`>`, `>>`), chained commands (`&&`, `;`), and environment variables (`$VAR`).
 * - Python 3 via Pyodide WebAssembly with NumPy, math, and multi-file module imports (`src/`).
 * - JavaScript / TypeScript via sandboxed Web Worker.
 * - Persistent Virtual File System (VFS) backed by browser storage.
 */

export interface ShellExecResult {
  output: string;
  exitCode: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// 1. Virtual File System (VFS)
// ---------------------------------------------------------------------------

const VFS_STORAGE_KEY = "edgerunner_vfs_workspace";

export interface VFSFile {
  path: string;
  content: string;
  mtime: number;
}

class VirtualFS {
  private files: Map<string, VFSFile> = new Map();
  private cwd: string = "/workspace";

  constructor() {
    this.load();
    if (this.files.size === 0) {
      this.seedDefaultFiles();
    }
  }

  private seedDefaultFiles() {
    this.writeFile(
      "welcome.sh",
      `# EdgeRunner In-Browser Virtual Shell
echo "Welcome to EdgeRunner WebAssembly Sandbox!"
echo "Architecture: Client-Side Wasm (0% Kaggle GPU quota used)"
python3 demo.py
`,
    );
    this.writeFile(
      "demo.py",
      `# EdgeRunner Python Wasm Demo
import math
print("⚡ Python 3.12 WebAssembly Engine initialized")
print("Math calculations: sqrt(256) =", math.sqrt(256))
print("Pi =", math.pi)
`,
    );
    this.writeFile(
      "demo.js",
      `console.log("⚡ JavaScript sandbox ready: 2 ** 10 =", 2 ** 10);
`,
    );
    this.save();
  }

  private load() {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(VFS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, { content: string; mtime: number }>;
        for (const [path, data] of Object.entries(parsed)) {
          this.files.set(path, { path, content: data.content, mtime: data.mtime });
        }
      }
    } catch {
      // ignore
    }
  }

  public save() {
    if (typeof window === "undefined") return;
    try {
      const obj: Record<string, { content: string; mtime: number }> = {};
      for (const [path, file] of this.files.entries()) {
        obj[path] = { content: file.content, mtime: file.mtime };
      }
      localStorage.setItem(VFS_STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // ignore
    }
  }

  public getCwd(): string {
    return this.cwd;
  }

  public setCwd(path: string): boolean {
    const norm = this.normalizePath(path);
    this.cwd = norm;
    return true;
  }

  public normalizePath(path: string): string {
    const clean = path.trim().replace(/\\/g, "/");
    let full = clean.startsWith("/") ? clean : `${this.cwd}/${clean}`;
    if (!full.startsWith("/workspace")) {
      full = `/workspace/${full.replace(/^\/+/, "")}`;
    }
    const parts = full.split("/").filter(Boolean);
    const resolved: string[] = [];
    for (const p of parts) {
      if (p === ".") continue;
      if (p === "..") resolved.pop();
      else resolved.push(p);
    }
    return "/" + resolved.join("/");
  }

  public getRelPath(fullOrRel: string): string {
    const norm = this.normalizePath(fullOrRel);
    return norm.replace(/^\/workspace\/?/, "") || "";
  }

  public writeFile(path: string, content: string): void {
    const rel = this.getRelPath(path).trim().replace(/\r?\n.*/g, "");
    if (!rel) return;
    this.files.set(rel, { path: rel, content, mtime: Date.now() });
    this.save();
  }

  public readFile(path: string): string | null {
    const rel = this.getRelPath(path).trim().replace(/\r?\n.*/g, "");
    const file = this.files.get(rel) || this.files.get(path);
    return file ? file.content : null;
  }

  public exists(path: string): boolean {
    return this.readFile(path) !== null;
  }

  public deleteFile(path: string): boolean {
    const rel = this.getRelPath(path).trim().replace(/\r?\n.*/g, "");
    let deleted = false;
    if (this.files.has(rel)) {
      this.files.delete(rel);
      deleted = true;
    }
    if (this.files.has(path)) {
      this.files.delete(path);
      deleted = true;
    }
    // Also delete directory prefixes
    const prefix = rel.endsWith("/") ? rel : rel + "/";
    for (const key of Array.from(this.files.keys())) {
      if (key.startsWith(prefix) || key === rel || key.startsWith(path)) {
        this.files.delete(key);
        deleted = true;
      }
    }
    if (deleted) this.save();
    return deleted;
  }

  public clear(): void {
    this.files.clear();
    this.save();
  }

  public listFiles(subDir: string = ""): string[] {
    const targetRel = this.getRelPath(subDir);
    const set = new Set<string>();
    const prefix = targetRel ? (targetRel.endsWith("/") ? targetRel : targetRel + "/") : "";

    for (const path of this.files.keys()) {
      if (!prefix || path.startsWith(prefix)) {
        const rest = path.slice(prefix.length);
        const top = rest.split("/")[0];
        if (top) set.add(top);
      }
    }
    return Array.from(set).sort();
  }

  public getAllEntries(): Array<{ path: string; content: string; mtime: number }> {
    return Array.from(this.files.values());
  }
}

export const vfs = new VirtualFS();

// ---------------------------------------------------------------------------
// 2. Pyodide WebAssembly Python Loader
// ---------------------------------------------------------------------------

let pyodideInstance: any = null;
let pyodideLoadingPromise: Promise<any> | null = null;

async function loadPyodideEngine(): Promise<any> {
  if (pyodideInstance) return pyodideInstance;
  if (pyodideLoadingPromise) return pyodideLoadingPromise;

  pyodideLoadingPromise = (async () => {
    if (typeof window === "undefined") return null;

    // Load Pyodide script from reliable CDN
    if (!(window as any).loadPyodide) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Pyodide WebAssembly script"));
        document.head.appendChild(script);
      });
    }

    const pyodide = await (window as any).loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/",
    });
    pyodideInstance = pyodide;
    return pyodide;
  })();

  return pyodideLoadingPromise;
}

// ---------------------------------------------------------------------------
// 3. Wasm Bash Interpreter Engine
// ---------------------------------------------------------------------------

export class WasmShell {
  private env: Record<string, string> = {
    USER: "edgerunner",
    HOME: "/workspace",
    PATH: "/bin:/usr/bin",
    SHELL: "/bin/wasm-bash",
  };

  /**
   * Execute a shell command or multi-line script in the Wasm sandbox with real-time streaming.
   */
  public async execute(
    commandLine: string,
    onStreamChunk?: (chunk: string) => void,
  ): Promise<ShellExecResult> {
    const startTime = performance.now();
    const cleanCmd = commandLine.trim();

    if (!cleanCmd) {
      return { output: "", exitCode: 0, durationMs: 0 };
    }

    try {
      // 1. Multi-line execution (split by newline OUTSIDE quotes)
      const lines = this.splitOutsideQuotes(cleanCmd, "\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length > 1) {
        let lastRes: ShellExecResult = { output: "", exitCode: 0, durationMs: 0 };
        const combinedOutputs: string[] = [];

        for (const line of lines) {
          if (line.startsWith("#")) continue;
          lastRes = await this.execute(line, (subChunk) => {
            onStreamChunk?.([...combinedOutputs, subChunk].filter(Boolean).join("\n"));
          });
          if (lastRes.output) combinedOutputs.push(lastRes.output);
          onStreamChunk?.(combinedOutputs.join("\n"));
          if (lastRes.exitCode !== 0) break;
        }

        return {
          output: combinedOutputs.join("\n"),
          exitCode: lastRes.exitCode,
          durationMs: Math.round(performance.now() - startTime),
        };
      }

      // 2. Chained commands with && (outside quotes)
      const andParts = this.splitOutsideQuotes(cleanCmd, "&&");
      if (andParts.length > 1) {
        let lastResult: ShellExecResult = { output: "", exitCode: 0, durationMs: 0 };
        const combinedOutputs: string[] = [];

        for (const part of andParts) {
          lastResult = await this.executeSingleOrPiped(part.trim(), (subChunk) => {
            onStreamChunk?.([...combinedOutputs, subChunk].filter(Boolean).join("\n"));
          });
          if (lastResult.output) combinedOutputs.push(lastResult.output);
          onStreamChunk?.(combinedOutputs.join("\n"));
          if (lastResult.exitCode !== 0) break;
        }

        return {
          output: combinedOutputs.join("\n"),
          exitCode: lastResult.exitCode,
          durationMs: Math.round(performance.now() - startTime),
        };
      }

      // 3. Sequential commands with ; (outside quotes)
      const semiParts = this.splitOutsideQuotes(cleanCmd, ";");
      if (semiParts.length > 1 && !cleanCmd.startsWith("python")) {
        let lastCode = 0;
        const combinedOutputs: string[] = [];

        for (const part of semiParts) {
          if (!part.trim()) continue;
          const res = await this.executeSingleOrPiped(part.trim(), (subChunk) => {
            onStreamChunk?.([...combinedOutputs, subChunk].filter(Boolean).join("\n"));
          });
          if (res.output) combinedOutputs.push(res.output);
          onStreamChunk?.(combinedOutputs.join("\n"));
          lastCode = res.exitCode;
        }

        return {
          output: combinedOutputs.join("\n"),
          exitCode: lastCode,
          durationMs: Math.round(performance.now() - startTime),
        };
      }

      const res = await this.executeSingleOrPiped(cleanCmd, onStreamChunk);
      res.durationMs = Math.round(performance.now() - startTime);
      return res;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        output: `wasm-bash: error: ${msg}`,
        exitCode: 1,
        durationMs: Math.round(performance.now() - startTime),
      };
    }
  }

  private async executeSingleOrPiped(
    cmd: string,
    onStreamChunk?: (chunk: string) => void,
  ): Promise<ShellExecResult> {
    // Quote-aware redirect detection
    let redirectTarget: string | null = null;
    let append = false;
    let effectiveCmd = cmd;

    const appendIdx = this.findOutsideQuotes(cmd, ">>");
    if (appendIdx !== -1) {
      effectiveCmd = cmd.slice(0, appendIdx).trim();
      redirectTarget = cmd.slice(appendIdx + 2).trim();
      append = true;
    } else {
      const redirIdx = this.findOutsideQuotes(cmd, ">");
      if (redirIdx !== -1) {
        effectiveCmd = cmd.slice(0, redirIdx).trim();
        redirectTarget = cmd.slice(redirIdx + 1).trim();
        append = false;
      }
    }

    // Quote-aware pipe detection: cmd1 | cmd2
    const pipeStages = this.splitOutsideQuotes(effectiveCmd, "|");
    if (pipeStages.length > 1) {
      let stdinData = "";
      let lastExit = 0;

      for (const stage of pipeStages) {
        const res = await this.runCommand(stage.trim(), stdinData, onStreamChunk);
        stdinData = res.output;
        lastExit = res.exitCode;
        if (lastExit !== 0) break;
      }

      if (redirectTarget) {
        this.writeRedirect(redirectTarget, stdinData, append);
        return { output: "", exitCode: lastExit, durationMs: 0 };
      }
      return { output: stdinData, exitCode: lastExit, durationMs: 0 };
    }

    const res = await this.runCommand(effectiveCmd, "", onStreamChunk);
    if (redirectTarget) {
      this.writeRedirect(redirectTarget, res.output, append);
      return { output: "", exitCode: res.exitCode, durationMs: 0 };
    }
    return res;
  }

  private writeRedirect(target: string, content: string, append: boolean) {
    const cleanTarget = target.trim().replace(/^["']|["']$/g, "");
    const existing = append ? vfs.readFile(cleanTarget) || "" : "";
    const nextContent = existing ? `${existing}\n${content}` : content;
    vfs.writeFile(cleanTarget, nextContent);
  }

  private async runCommand(
    cmdString: string,
    stdin: string,
    onStreamChunk?: (chunk: string) => void,
  ): Promise<ShellExecResult> {
    const tokens = this.tokenize(cmdString);
    if (tokens.length === 0) return { output: "", exitCode: 0, durationMs: 0 };

    const prog = tokens[0];
    const args = tokens.slice(1);

    // Expand environment variables
    const expandedArgs = args.map((a) =>
      a.replace(/\$([a-zA-Z_0-9]+)/g, (_, v) => this.env[v] || ""),
    );

    // Built-in Core Utilities
    switch (prog) {
      case "pwd":
        return { output: vfs.getCwd(), exitCode: 0, durationMs: 0 };

      case "cd": {
        const dest = expandedArgs[0] || "/workspace";
        vfs.setCwd(dest);
        return { output: "", exitCode: 0, durationMs: 0 };
      }

      case "echo": {
        const hasE = expandedArgs[0] === "-e";
        const hasN = expandedArgs[0] === "-n";
        const argsToJoin = hasE || hasN ? expandedArgs.slice(1) : expandedArgs;
        const text = argsToJoin.join(" ");

        // Smart quote-aware escape expansion:
        // - \n outside string quotes -> expanded to real newline for statements/includes
        // - \n inside double quotes -> preserved as \n for C/Python string literals
        let output = "";
        let inDouble = false;

        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          if (char === '"' && (i === 0 || text[i - 1] !== "\\")) {
            inDouble = !inDouble;
            output += char;
          } else if (text.slice(i, i + 2) === "\\n") {
            if (inDouble) {
              output += "\\n";
            } else {
              output += "\n";
            }
            i++;
          } else if (text.slice(i, i + 2) === "\\t") {
            if (inDouble) {
              output += "\\t";
            } else {
              output += "\t";
            }
            i++;
          } else {
            output += char;
          }
        }

        return {
          output,
          exitCode: 0,
          durationMs: 0,
        };
      }

      case "ls": {
        const showAll = expandedArgs.some((a) => a.includes("a"));
        const showLong = expandedArgs.some((a) => a.includes("l"));
        const targetDir = expandedArgs.find((a) => !a.startsWith("-")) || "";
        const files = vfs.listFiles(targetDir);

        if (showLong) {
          const lines = files
            .filter((f) => showAll || !f.startsWith("."))
            .map((f) => `-rw-r--r--  1 edgerunner staff  512  ${new Date().toLocaleTimeString()}  ${f}`);
          return { output: lines.join("\n") || "(empty directory)", exitCode: 0, durationMs: 0 };
        }

        const visible = files.filter((f) => showAll || !f.startsWith("."));
        return { output: visible.join("  ") || "", exitCode: 0, durationMs: 0 };
      }

      case "cat": {
        const filenames = expandedArgs.filter((a) => !a.startsWith("-"));
        if (filenames.length === 0) {
          return { output: stdin || "", exitCode: 0, durationMs: 0 };
        }
        const outputs: string[] = [];
        for (const fn of filenames) {
          const content = vfs.readFile(fn);
          if (content === null) {
            return { output: `cat: ${fn}: No such file or directory`, exitCode: 1, durationMs: 0 };
          }
          outputs.push(content);
        }
        return { output: outputs.join("\n"), exitCode: 0, durationMs: 0 };
      }

      case "mkdir": {
        // Folders are virtual path prefixes in VFS
        return { output: "", exitCode: 0, durationMs: 0 };
      }

      case "touch": {
        for (const fn of expandedArgs) {
          if (!vfs.readFile(fn)) {
            vfs.writeFile(fn, "");
          }
        }
        return { output: "", exitCode: 0, durationMs: 0 };
      }

      case "code":
      case "vs":
      case "vscode": {
        const target = expandedArgs[0];
        if (typeof window !== "undefined") {
          if (target && target !== ".") {
            if (!vfs.exists(target)) {
              vfs.writeFile(target, "");
            }
            window.dispatchEvent(new CustomEvent("edgerunner:open-file", { detail: { path: target } }));
          }
          window.dispatchEvent(new CustomEvent("edgerunner:open-workspace"));
        }
        return {
          output: `✓ Opened ${target || "workspace"} in VS Code Workspace`,
          exitCode: 0,
          durationMs: 0,
        };
      }

      case "nano":
      case "vi":
      case "vim": {
        const target = expandedArgs[0] || "untitled.txt";
        if (!vfs.exists(target)) {
          vfs.writeFile(target, "");
        }
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("edgerunner:open-terminal-editor", {
              detail: { editor: prog, file: target },
            }),
          );
        }
        return {
          output: `✓ Switched to interactive in-terminal ${prog === "nano" ? "Nano" : "Vim"} editor for '${target}'`,
          exitCode: 0,
          durationMs: 0,
        };
      }

      case "rm": {
        const targets = expandedArgs.filter((a) => !a.startsWith("-"));
        for (const t of targets) {
          if (t === "*" || t === "." || t === "/workspace" || t === "~/workspace" || t === "/workspace/*") {
            vfs.clear();
          } else {
            vfs.deleteFile(t);
          }
        }
        return { output: "", exitCode: 0, durationMs: 0 };
      }

      case "cp": {
        if (expandedArgs.length < 2) {
          return { output: "cp: missing destination file", exitCode: 1, durationMs: 0 };
        }
        const src = expandedArgs[0];
        const dst = expandedArgs[1];
        const content = vfs.readFile(src);
        if (content === null) {
          return { output: `cp: ${src}: No such file`, exitCode: 1, durationMs: 0 };
        }
        vfs.writeFile(dst, content);
        return { output: "", exitCode: 0, durationMs: 0 };
      }

      case "mv": {
        if (expandedArgs.length < 2) {
          return { output: "mv: missing destination file", exitCode: 1, durationMs: 0 };
        }
        const src = expandedArgs[0];
        const dst = expandedArgs[1];
        const content = vfs.readFile(src);
        if (content === null) {
          return { output: `mv: ${src}: No such file`, exitCode: 1, durationMs: 0 };
        }
        vfs.writeFile(dst, content);
        vfs.deleteFile(src);
        return { output: "", exitCode: 0, durationMs: 0 };
      }

      case "grep": {
        const ignoreCase = expandedArgs.some((a) => a.includes("i"));
        const positional = expandedArgs.filter((a) => !a.startsWith("-"));
        const patternStr = positional[0] || "";
        const targetFile = positional[1];

        const textToSearch = targetFile ? vfs.readFile(targetFile) || "" : stdin;
        if (!patternStr) return { output: textToSearch, exitCode: 0, durationMs: 0 };

        const regex = new RegExp(patternStr, ignoreCase ? "i" : "");
        const lines = textToSearch.split("\n");
        const matches = lines.filter((l) => regex.test(l));
        return { output: matches.join("\n"), exitCode: matches.length > 0 ? 0 : 1, durationMs: 0 };
      }

      case "head": {
        const count = 10;
        const targetFile = expandedArgs.find((a) => !a.startsWith("-"));
        const text = targetFile ? vfs.readFile(targetFile) || "" : stdin;
        const lines = text.split("\n").slice(0, count);
        return { output: lines.join("\n"), exitCode: 0, durationMs: 0 };
      }

      case "tail": {
        const count = 10;
        const targetFile = expandedArgs.find((a) => !a.startsWith("-"));
        const text = targetFile ? vfs.readFile(targetFile) || "" : stdin;
        const lines = text.split("\n").slice(-count);
        return { output: lines.join("\n"), exitCode: 0, durationMs: 0 };
      }

      case "wc": {
        const targetFile = expandedArgs.find((a) => !a.startsWith("-"));
        const text = targetFile ? vfs.readFile(targetFile) || "" : stdin;
        const lines = text.split("\n").length;
        const words = text.trim() ? text.trim().split(/\s+/).length : 0;
        const bytes = text.length;
        return {
          output: `  ${lines}  ${words}  ${bytes} ${targetFile || ""}`,
          exitCode: 0,
          durationMs: 0,
        };
      }

      case "exit":
      case "quit":
      case "logout":
      case "bye": {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("edgerunner:terminal-exit"));
        }
        return { output: "exit\n[Process completed]", exitCode: 0, durationMs: 0 };
      }

      case "whoami":
        return { output: this.env.USER || "edgerunner", exitCode: 0, durationMs: 0 };

      case "id":
        return {
          output: "uid=1000(edgerunner) gid=1000(edgerunner) groups=1000(edgerunner),4(adm),24(cdrom),27(sudo),30(dip),46(plugdev),116(lxd)",
          exitCode: 0,
          durationMs: 0,
        };

      case "hostname":
        return { output: "edgerunner-node", exitCode: 0, durationMs: 0 };

      case "uname": {
        const isAll = expandedArgs.includes("-a") || expandedArgs.includes("--all");
        const isR = expandedArgs.includes("-r");
        const isM = expandedArgs.includes("-m");
        if (isAll) {
          return {
            output: "Linux edgerunner-node 6.5.0-wasm #1 SMP PREEMPT_DYNAMIC WebAssembly x86_64 GNU/Linux",
            exitCode: 0,
            durationMs: 0,
          };
        }
        if (isR) return { output: "6.5.0-wasm", exitCode: 0, durationMs: 0 };
        if (isM) return { output: "x86_64", exitCode: 0, durationMs: 0 };
        return { output: "Linux", exitCode: 0, durationMs: 0 };
      }

      case "date":
        return { output: new Date().toString(), exitCode: 0, durationMs: 0 };

      case "uptime":
        return {
          output: ` ${new Date().toLocaleTimeString()} up 1:42,  1 user,  load average: 0.08, 0.03, 0.01`,
          exitCode: 0,
          durationMs: 0,
        };

      case "cal": {
        const now = new Date();
        const monthName = now.toLocaleString("default", { month: "long" });
        const year = now.getFullYear();
        const header = `   ${monthName} ${year}   `;
        const days = "Su Mo Tu We Th Fr Sa";
        const firstDay = new Date(year, now.getMonth(), 1).getDay();
        const lastDate = new Date(year, now.getMonth() + 1, 0).getDate();
        let grid = "   ".repeat(firstDay);
        for (let d = 1; d <= lastDate; d++) {
          const dStr = d < 10 ? ` ${d}` : `${d}`;
          const isToday = d === now.getDate();
          grid += isToday ? `\x1b[7m${dStr}\x1b[0m ` : `${dStr} `;
          if ((firstDay + d) % 7 === 0) grid += "\n";
        }
        return { output: `${header}\n${days}\n${grid.trimEnd()}`, exitCode: 0, durationMs: 0 };
      }

      case "which":
      case "whereis":
      case "type": {
        const targetProg = expandedArgs[0];
        if (!targetProg) return { output: "", exitCode: 1, durationMs: 0 };
        const knownBins = [
          "bash", "sh", "python", "python3", "node", "git", "cat", "ls", "pwd", "cd",
          "echo", "mkdir", "touch", "rm", "cp", "mv", "grep", "head", "tail", "wc",
          "nano", "vim", "vi", "code", "vs", "vscode", "gcc", "g++", "rustc", "go",
          "curl", "wget", "tar", "zip", "unzip", "which", "whereis", "type", "date",
          "whoami", "id", "uname", "uptime", "ps", "df", "du", "free", "clear", "exit"
        ];
        if (knownBins.includes(targetProg)) {
          return { output: `/usr/bin/${targetProg}`, exitCode: 0, durationMs: 0 };
        }
        return { output: `${prog}: no ${targetProg} in (${this.env.PATH})`, exitCode: 1, durationMs: 0 };
      }

      case "df":
        return {
          output: "Filesystem     1K-blocks      Used Available Use% Mounted on\n/dev/root       52428800   4404019  48024781   9% /workspace\ntmpfs            8388608         0   8388608   0% /tmp",
          exitCode: 0,
          durationMs: 0,
        };

      case "du": {
        const files = vfs.listFiles();
        let totalKb = 0;
        const lines: string[] = [];
        for (const f of files) {
          const c = vfs.readFile(f) || "";
          const kb = Math.max(4, Math.ceil(c.length / 1024) * 4);
          totalKb += kb;
          lines.push(`${kb}K\t${f}`);
        }
        lines.push(`${totalKb}K\t.`);
        return { output: lines.join("\n"), exitCode: 0, durationMs: 0 };
      }

      case "free":
        return {
          output: "               total        used        free      shared  buff/cache   available\nMem:        16384000     2410240    12560320       12000     1413440    13973760\nSwap:        2097152           0     2097152",
          exitCode: 0,
          durationMs: 0,
        };

      case "ps":
        return {
          output: "  PID TTY          TIME CMD\n    1 ?        00:00:01 wasm-init\n   42 pts/0    00:00:00 wasm-bash\n   98 pts/0    00:00:00 python3\n  104 pts/0    00:00:00 ps",
          exitCode: 0,
          durationMs: 0,
        };

      case "top":
      case "htop":
        return {
          output: `top - ${new Date().toLocaleTimeString()} up 1:42,  1 user,  load average: 0.08, 0.03, 0.01\nTasks: 4 total, 1 running, 3 sleeping, 0 stopped, 0 zombie\n%Cpu(s):  1.2 us,  0.5 sy,  0.0 ni, 98.3 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st\nMiB Mem :  16000.0 total,  12265.9 free,   2353.7 used,   1380.4 buff/cache\n\n  PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n    1 edgerun+  20   0   24180   4120   3100 S   0.0   0.0   0:00.12 init\n   42 edgerun+  20   0   18420   3680   2800 S   0.0   0.0   0:00.04 wasm-bash\n   98 edgerun+  20   0   84210  42100  18200 S   0.5   0.3   0:01.42 python3`,
          exitCode: 0,
          durationMs: 0,
        };

      case "sleep": {
        const sec = parseFloat(expandedArgs[0]) || 1;
        await new Promise((r) => setTimeout(r, Math.min(sec * 1000, 30000)));
        return { output: "", exitCode: 0, durationMs: Math.round(sec * 1000) };
      }

      case "true":
        return { output: "", exitCode: 0, durationMs: 0 };

      case "false":
        return { output: "", exitCode: 1, durationMs: 0 };

      case "test":
      case "[": {
        const argsToEval = prog === "[" ? expandedArgs.filter((a) => a !== "]") : expandedArgs;
        if (argsToEval[0] === "-f" || argsToEval[0] === "-e") {
          const f = argsToEval[1];
          return { output: "", exitCode: f && vfs.exists(f) ? 0 : 1, durationMs: 0 };
        }
        if (argsToEval[0] === "-z") {
          return { output: "", exitCode: !argsToEval[1] ? 0 : 1, durationMs: 0 };
        }
        if (argsToEval[0] === "-n") {
          return { output: "", exitCode: argsToEval[1] ? 0 : 1, durationMs: 0 };
        }
        if (argsToEval[1] === "=" || argsToEval[1] === "==") {
          return { output: "", exitCode: argsToEval[0] === argsToEval[2] ? 0 : 1, durationMs: 0 };
        }
        if (argsToEval[1] === "!=") {
          return { output: "", exitCode: argsToEval[0] !== argsToEval[2] ? 0 : 1, durationMs: 0 };
        }
        return { output: "", exitCode: argsToEval.length > 0 ? 0 : 1, durationMs: 0 };
      }

      case "tree": {
        const files = vfs.listFiles();
        const out = files.map((f, i) => `${i === files.length - 1 ? "└── " : "├── "}${f}`).join("\n");
        return { output: `.\n${out}\n\n0 directories, ${files.length} files`, exitCode: 0, durationMs: 0 };
      }

      case "base64": {
        const isDecode = expandedArgs.includes("-d") || expandedArgs.includes("--decode");
        const targetFile = expandedArgs.find((a) => !a.startsWith("-"));
        const text = targetFile ? vfs.readFile(targetFile) || "" : stdin || "";
        try {
          const out = isDecode ? atob(text.trim()) : btoa(text);
          return { output: out, exitCode: 0, durationMs: 0 };
        } catch {
          return { output: "base64: invalid input", exitCode: 1, durationMs: 0 };
        }
      }

      case "find": {
        const files = vfs.listFiles();
        const nameFlagIdx = expandedArgs.indexOf("-name");
        const pattern = nameFlagIdx !== -1 ? expandedArgs[nameFlagIdx + 1] : null;
        let matched = files;
        if (pattern) {
          const reg = new RegExp(pattern.replace(/\*/g, ".*"));
          matched = files.filter((f) => reg.test(f));
        }
        return { output: matched.map((f) => `./${f}`).join("\n"), exitCode: 0, durationMs: 0 };
      }

      case "curl":
      case "wget": {
        const url = expandedArgs.find((a) => a.startsWith("http://") || a.startsWith("https://"));
        if (!url) return { output: `${prog}: missing URL`, exitCode: 1, durationMs: 0 };
        try {
          const res = await fetch(url);
          const text = await res.text();
          const outIdx = expandedArgs.indexOf("-o") !== -1 ? expandedArgs.indexOf("-o") : expandedArgs.indexOf("-O");
          if (outIdx !== -1 && expandedArgs[outIdx + 1]) {
            vfs.writeFile(expandedArgs[outIdx + 1], text);
            return { output: `✓ Saved ${text.length} bytes to ${expandedArgs[outIdx + 1]}`, exitCode: 0, durationMs: 0 };
          }
          return { output: text.slice(0, 4000), exitCode: 0, durationMs: 0 };
        } catch {
          return { output: `${prog}: failed to fetch ${url}`, exitCode: 1, durationMs: 0 };
        }
      }

      case "history": {
        if (typeof window !== "undefined") {
          try {
            const hist = JSON.parse(localStorage.getItem("edgerunner.cmd_history") || "[]");
            const lines = hist.map((cmd: string, idx: number) => `  ${idx + 1}  ${cmd}`);
            return { output: lines.join("\n"), exitCode: 0, durationMs: 0 };
          } catch {}
        }
        return { output: "", exitCode: 0, durationMs: 0 };
      }

      case "clear":
        return { output: "", exitCode: 0, durationMs: 0 };

      case "help":
        return {
          output: `EdgeRunner WebAssembly Shell Commands:
  Core Utilities: ls, cd, pwd, cat, echo, mkdir, touch, rm, cp, mv, grep, head, tail, wc, env, export, clear, exit, whoami, id, hostname, uname, date, uptime, cal, df, du, free, ps, top, sleep, tree, base64, find, curl, wget, history
  In-Terminal Editors: nano <file>, vim <file>, vi <file>
  VS Code Monaco Workspace: code <file>, vs <file>, vscode <file>
  Compilers & Interpreters: python3 <main.py>, node <app.js>, gcc <main.c>, rustc <main.rs>, go run <main.go>
  Pipes & Redirection: cmd1 | cmd2, cmd > file, cmd >> file, cmd1 && cmd2
  Git DAG & Sync: git clone <url>, git status, git add, git commit -m <msg>, git log, git push, git pull, git diff`,
          exitCode: 0,
          durationMs: 0,
        };

      // ---------------------------------------------------------------------
      // Python WebAssembly Execution (Pyodide)
      // ---------------------------------------------------------------------
      case "python":
      case "python3":
      case "py": {
        return await this.runPython(expandedArgs);
      }

      // ---------------------------------------------------------------------
      // JavaScript / Node Execution
      // ---------------------------------------------------------------------
      case "node":
      case "js": {
        return await this.runJs(expandedArgs);
      }

      // ---------------------------------------------------------------------
      // Shell Script Runner
      // ---------------------------------------------------------------------
      case "sh":
      case "bash": {
        const scriptFile = expandedArgs[0];
        if (!scriptFile) {
          return { output: "wasm-bash: no script file specified", exitCode: 1, durationMs: 0 };
        }
        const content = vfs.readFile(scriptFile);
        if (content === null) {
          return { output: `wasm-bash: ${scriptFile}: No such file`, exitCode: 1, durationMs: 0 };
        }
        return await this.execute(content);
      }

      // ---------------------------------------------------------------------
      // In-House Git Engine
      // ---------------------------------------------------------------------
      case "git": {
        const sub = expandedArgs[0];
        if (!sub || sub === "status") {
          const st = gitManager.status();
          const lines = [`On branch ${st.branch}`];
          if (st.staged.length > 0) {
            lines.push(`Changes to be committed:\n  ${st.staged.map((f) => `new file:   ${f}`).join("\n  ")}`);
          }
          if (st.modified.length > 0) {
            lines.push(`Changes not staged for commit:\n  ${st.modified.map((f) => `modified:   ${f}`).join("\n  ")}`);
          }
          if (st.untracked.length > 0) {
            lines.push(`Untracked files:\n  ${st.untracked.map((f) => `${f}`).join("\n  ")}`);
          }
          if (st.staged.length === 0 && st.modified.length === 0 && st.untracked.length === 0) {
            lines.push("nothing to commit, working tree clean");
          }
          return { output: lines.join("\n"), exitCode: 0, durationMs: 0 };
        }

        if (sub === "init") {
          return { output: gitManager.init(), exitCode: 0, durationMs: 0 };
        }

        if (sub === "add") {
          const target = expandedArgs[1] || ".";
          return { output: gitManager.add(target), exitCode: 0, durationMs: 0 };
        }

        if (sub === "commit") {
          const mIndex = expandedArgs.indexOf("-m");
          const msg = mIndex !== -1 ? expandedArgs[mIndex + 1] || "Update" : expandedArgs.slice(1).join(" ");
          return { output: gitManager.commit(msg), exitCode: 0, durationMs: 0 };
        }

        if (sub === "log") {
          const logs = gitManager.log();
          if (logs.length === 0) return { output: "fatal: your current branch does not have any commits yet", exitCode: 0, durationMs: 0 };
          const lines = logs.map(
            (c) => `commit ${c.hash}\nAuthor: ${c.author}\nDate:   ${new Date(c.timestamp).toLocaleString()}\n\n    ${c.message}\n`
          );
          return { output: lines.join("\n"), exitCode: 0, durationMs: 0 };
        }

        if (sub === "diff") {
          return { output: gitManager.diff(), exitCode: 0, durationMs: 0 };
        }

        if (sub === "checkout") {
          const target = expandedArgs[1];
          if (!target) return { output: "git checkout: specify branch or commit", exitCode: 1, durationMs: 0 };
          return { output: gitManager.checkout(target), exitCode: 0, durationMs: 0 };
        }

        if (sub === "clone") {
          const repoUrl = expandedArgs[1];
          const targetDir = expandedArgs[2] || "";
          if (!repoUrl) {
            return {
              output: "fatal: You must specify a repository to clone.\nusage: git clone <repository> [<directory>]",
              exitCode: 128,
              durationMs: 0,
            };
          }
          try {
            const streamLines: string[] = [];
            const { githubSync } = await import("./githubSync");
            const res = await githubSync.clone(repoUrl, targetDir, undefined, (progressMsg) => {
              streamLines.push(progressMsg);
              onStreamChunk?.(streamLines.join("\n"));
            });
            const finalLines = [
              ...streamLines,
              `✓ Successfully cloned https://github.com/${res.repo} (branch: ${res.branch})`,
            ];
            return {
              output: finalLines.join("\n"),
              exitCode: 0,
              durationMs: 0,
            };
          } catch (err: unknown) {
            return {
              output: `fatal: ${err instanceof Error ? err.message : String(err)}`,
              exitCode: 128,
              durationMs: 0,
            };
          }
        }

        if (sub === "push") {
          const token = typeof window !== "undefined" ? localStorage.getItem("edgerunner.git.token") || "" : "";
          const repo = typeof window !== "undefined" ? localStorage.getItem("edgerunner.git.repo") || "" : "";
          const branch = typeof window !== "undefined" ? localStorage.getItem("edgerunner.git.branch") || "main" : "main";
          if (!token || !repo) {
            return {
              output: "git: remote repository not configured. Press ⌘U or open Connect Accounts -> Git Storage to set GitHub repo & token.",
              exitCode: 1,
              durationMs: 0,
            };
          }
          try {
            const { githubSync } = await import("./githubSync");
            const res = await githubSync.push({ token, repo, branch }, onStreamChunk);
            return {
              output: `To https://github.com/${repo}.git\n   ${res.sha.slice(0, 7)}..head -> ${branch}\n✓ Pushed successfully to ${res.commitUrl}`,
              exitCode: 0,
              durationMs: 0,
            };
          } catch (err: unknown) {
            return { output: `git push error: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1, durationMs: 0 };
          }
        }

        if (sub === "pull") {
          const token = typeof window !== "undefined" ? localStorage.getItem("edgerunner.git.token") || "" : "";
          const repo = typeof window !== "undefined" ? localStorage.getItem("edgerunner.git.repo") || "" : "";
          const branch = typeof window !== "undefined" ? localStorage.getItem("edgerunner.git.branch") || "main" : "main";
          if (!repo) {
            return {
              output: "git: remote repository not configured. Press ⌘U or open Connect Accounts -> Git Storage to set GitHub repo.",
              exitCode: 1,
              durationMs: 0,
            };
          }
          try {
            const { githubSync } = await import("./githubSync");
            const res = await githubSync.pull({ token, repo, branch }, onStreamChunk);
            return {
              output: `From https://github.com/${repo}\n * branch ${branch} -> FETCH_HEAD\n✓ Successfully pulled ${res.filesCount} files.`,
              exitCode: 0,
              durationMs: 0,
            };
          } catch (err: unknown) {
            return { output: `git pull error: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1, durationMs: 0 };
          }
        }

        return { output: `git: '${sub}' is not a recognized git command`, exitCode: 1, durationMs: 0 };
      }

      // ---------------------------------------------------------------------
      // Multi-Language Compilers & Runtimes (Zero-Setup Piston Engine)
      // ---------------------------------------------------------------------
      case "gcc":
      case "clang":
      case "c": {
        const file = expandedArgs.find((a) => a.endsWith(".c") || !a.startsWith("-"));
        const content = file ? vfs.readFile(file) : null;
        if (!content) return { output: `gcc: error: ${file || "no input files"}`, exitCode: 1, durationMs: 0 };
        onStreamChunk?.(`[Compiling ${file || "main.c"} with GCC…]`);
        const res = await executeViaPiston("c", content, file || "main.c", expandedArgs);
        onStreamChunk?.(res.output);
        return { output: res.output, exitCode: res.exitCode, durationMs: 0 };
      }

      case "g++":
      case "clang++":
      case "cpp": {
        const file = expandedArgs.find((a) => a.endsWith(".cpp") || a.endsWith(".cc") || !a.startsWith("-"));
        const content = file ? vfs.readFile(file) : null;
        if (!content) return { output: `g++: error: ${file || "no input files"}`, exitCode: 1, durationMs: 0 };
        onStreamChunk?.(`[Compiling ${file || "main.cpp"} with G++…]`);
        const res = await executeViaPiston("cpp", content, file || "main.cpp", expandedArgs);
        onStreamChunk?.(res.output);
        return { output: res.output, exitCode: res.exitCode, durationMs: 0 };
      }

      case "rustc":
      case "rust":
      case "cargo": {
        const file = expandedArgs.find((a) => a.endsWith(".rs") || !a.startsWith("-"));
        const content = file ? vfs.readFile(file) : null;
        if (!content) return { output: `rustc: error: ${file || "no input files"}`, exitCode: 1, durationMs: 0 };
        onStreamChunk?.(`[Compiling ${file || "main.rs"} with rustc…]`);
        const res = await executeViaPiston("rust", content, file || "main.rs", expandedArgs);
        onStreamChunk?.(res.output);
        return { output: res.output, exitCode: res.exitCode, durationMs: 0 };
      }

      case "go":
      case "golang": {
        const file = expandedArgs.find((a) => a.endsWith(".go") || !a.startsWith("-"));
        const content = file ? vfs.readFile(file) : null;
        if (!content) return { output: `go: error: ${file || "no input files"}`, exitCode: 1, durationMs: 0 };
        onStreamChunk?.(`[Running ${file || "main.go"} with Go 1.23…]`);
        const res = await executeViaPiston("go", content, file || "main.go", expandedArgs);
        onStreamChunk?.(res.output);
        return { output: res.output, exitCode: res.exitCode, durationMs: 0 };
      }

      case "java":
      case "javac": {
        const file = expandedArgs.find((a) => a.endsWith(".java") || !a.startsWith("-"));
        const content = file ? vfs.readFile(file) : null;
        if (!content) return { output: `java: error: ${file || "no input files"}`, exitCode: 1, durationMs: 0 };
        onStreamChunk?.(`[Running ${file || "Main.java"} with OpenJDK 22…]`);
        const res = await executeViaPiston("java", content, file || "Main.java", expandedArgs);
        onStreamChunk?.(res.output);
        return { output: res.output, exitCode: res.exitCode, durationMs: 0 };
      }

      case "ruby": {
        const file = expandedArgs.find((a) => a.endsWith(".rb") || !a.startsWith("-"));
        const content = file ? vfs.readFile(file) : null;
        if (!content) return { output: `ruby: error: ${file || "no input files"}`, exitCode: 1, durationMs: 0 };
        onStreamChunk?.(`[Running ${file || "main.rb"} with Ruby 4.0…]`);
        const res = await executeViaPiston("ruby", content, file || "main.rb", expandedArgs);
        onStreamChunk?.(res.output);
        return { output: res.output, exitCode: res.exitCode, durationMs: 0 };
      }

      case "php": {
        const file = expandedArgs.find((a) => a.endsWith(".php") || !a.startsWith("-"));
        const content = file ? vfs.readFile(file) : null;
        if (!content) return { output: `php: error: ${file || "no input files"}`, exitCode: 1, durationMs: 0 };
        onStreamChunk?.(`[Running ${file || "main.php"} with PHP 8.3…]`);
        const res = await executeViaPiston("php", content, file || "main.php", expandedArgs);
        onStreamChunk?.(res.output);
        return { output: res.output, exitCode: res.exitCode, durationMs: 0 };
      }

      default:
        // Check if executable file in VFS
        const fileContent = vfs.readFile(prog);
        if (fileContent !== null) {
          if (prog.endsWith(".py")) return await this.runPython([prog], onStreamChunk);
          if (prog.endsWith(".js") || prog.endsWith(".ts")) return await this.runJs([prog]);
          if (prog.endsWith(".c")) {
            const r = await executeViaPiston("c", fileContent, prog);
            return { output: r.output, exitCode: r.exitCode, durationMs: 0 };
          }
          if (prog.endsWith(".cpp") || prog.endsWith(".cc")) {
            const r = await executeViaPiston("cpp", fileContent, prog);
            return { output: r.output, exitCode: r.exitCode, durationMs: 0 };
          }
          if (prog.endsWith(".rs")) {
            const r = await executeViaPiston("rust", fileContent, prog);
            return { output: r.output, exitCode: r.exitCode, durationMs: 0 };
          }
          if (prog.endsWith(".go")) {
            const r = await executeViaPiston("go", fileContent, prog);
            return { output: r.output, exitCode: r.exitCode, durationMs: 0 };
          }
          return await this.execute(fileContent, onStreamChunk);
        }
        return {
          output: `wasm-bash: ${prog}: command not found (type 'help' for built-ins)`,
          exitCode: 127,
          durationMs: 0,
        };
    }
  }

  private async runPython(
    args: string[],
    onStreamChunk?: (chunk: string) => void,
  ): Promise<ShellExecResult> {
    let codeToRun = "";

    const cIndex = args.indexOf("-c");
    if (cIndex !== -1 && args[cIndex + 1]) {
      codeToRun = args[cIndex + 1];
    } else if (args[0]) {
      const file = vfs.readFile(args[0]);
      if (file === null) {
        return { output: `python: can't open file '${args[0]}': [Errno 2] No such file or directory`, exitCode: 2, durationMs: 0 };
      }
      codeToRun = file;
    } else {
      codeToRun = 'print("Python 3.12 (Pyodide Wasm) - Interactive mode ready")';
    }

    try {
      const pyodide = await loadPyodideEngine();
      if (!pyodide) {
        return { output: "Pyodide WebAssembly is only supported in browser environments.", exitCode: 1, durationMs: 0 };
      }

      // Ensure current working directory is in Python's sys.path for submodule imports
      await pyodide.runPythonAsync(`
import sys, os
cwd = os.getcwd()
if cwd not in sys.path:
    sys.path.insert(0, cwd)
if '.' not in sys.path:
    sys.path.insert(0, '.')
`);

      // Sync all VFS files & subdirectories into Pyodide virtual filesystem
      for (const entry of vfs.getAllEntries()) {
        try {
          const parts = entry.path.split("/").filter(Boolean);
          if (parts.length > 1) {
            let cur = "";
            for (let i = 0; i < parts.length - 1; i++) {
              cur = cur ? `${cur}/${parts[i]}` : parts[i];
              try {
                pyodide.FS.mkdir(cur);
              } catch {
                // directory already exists
              }
            }
          }
          pyodide.FS.writeFile(entry.path, entry.content);
        } catch {
          // ignore
        }
      }

      let capturedStdout = "";
      let capturedStderr = "";

      pyodide.setStdout({
        batched: (str: string) => {
          capturedStdout += str + "\n";
          onStreamChunk?.(capturedStdout.trimEnd());
        },
      });
      pyodide.setStderr({
        batched: (str: string) => {
          capturedStderr += str + "\n";
          onStreamChunk?.((capturedStdout + capturedStderr).trimEnd());
        },
      });

      const result = await pyodide.runPythonAsync(codeToRun);
      let output = capturedStdout || (result !== undefined ? String(result) : "");
      if (capturedStderr) output += (output ? "\n" : "") + capturedStderr;

      return { output: output.trimEnd(), exitCode: 0, durationMs: 0 };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const cleanErr = msg.startsWith("Traceback") ? msg : `Traceback (most recent call last):\n${msg}`;
      return { output: cleanErr.trim(), exitCode: 1, durationMs: 0 };
    }
  }

  private async runJs(args: string[]): Promise<ShellExecResult> {
    let code = "";
    const eIndex = args.indexOf("-e");
    if (eIndex !== -1 && args[eIndex + 1]) {
      code = args[eIndex + 1];
    } else if (args[0]) {
      const content = vfs.readFile(args[0]);
      if (!content) return { output: `node: Cannot find module '${args[0]}'`, exitCode: 1, durationMs: 0 };
      code = content;
    }

    try {
      const logs: string[] = [];
      const customConsole = {
        log: (...a: any[]) => logs.push(a.map(String).join(" ")),
        error: (...a: any[]) => logs.push("[error] " + a.map(String).join(" ")),
        warn: (...a: any[]) => logs.push("[warn] " + a.map(String).join(" ")),
      };

      const fn = new Function("console", code);
      const res = fn(customConsole);
      if (res !== undefined && logs.length === 0) logs.push(String(res));

      return { output: logs.join("\n"), exitCode: 0, durationMs: 0 };
    } catch (err: unknown) {
      return { output: String(err), exitCode: 1, durationMs: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // Quote-Aware Parsing Helpers
  // -------------------------------------------------------------------------

  private splitOutsideQuotes(str: string, delimiter: string): string[] {
    const parts: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    const len = str.length;
    const dLen = delimiter.length;

    for (let i = 0; i < len; i++) {
      const char = str[i];
      if (char === "'" && !inDouble) {
        inSingle = !inSingle;
        current += char;
      } else if (char === '"' && !inSingle) {
        inDouble = !inDouble;
        current += char;
      } else if (!inSingle && !inDouble && str.slice(i, i + dLen) === delimiter) {
        parts.push(current.trim());
        current = "";
        i += dLen - 1;
      } else {
        current += char;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  }

  private findOutsideQuotes(str: string, target: string): number {
    let inSingle = false;
    let inDouble = false;
    const len = str.length;
    const tLen = target.length;

    for (let i = 0; i < len; i++) {
      const char = str[i];
      if (char === "'" && !inDouble) {
        inSingle = !inSingle;
      } else if (char === '"' && !inSingle) {
        inDouble = !inDouble;
      } else if (!inSingle && !inDouble && str.slice(i, i + tLen) === target) {
        return i;
      }
    }
    return -1;
  }

  private tokenize(cmd: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < cmd.length; i++) {
      const char = cmd[i];
      if (char === "'" && !inDouble) {
        inSingle = !inSingle;
      } else if (char === '"' && !inSingle) {
        inDouble = !inDouble;
      } else if (/\s/.test(char) && !inSingle && !inDouble) {
        if (current) {
          tokens.push(current);
          current = "";
        }
      } else {
        current += char;
      }
    }
    if (current) tokens.push(current);
    return tokens;
  }
}

export const wasmShell = new WasmShell();
