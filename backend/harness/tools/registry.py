"""
OpenCode-inspired tool registry.

OpenCode (anomalyco/opencode) ships built-ins:
  bash, read, write, edit, grep, glob, apply_patch, todowrite,
  skill, webfetch, websearch, question

EdgeRunner ports the high-leverage subset for local/Kaggle GGUF agents
(no native JSON tool-calling required; models emit XML/JSON tool directives).

Names and parameter shapes match OpenCode where practical so prompts and
muscle memory transfer. GGUF adaptations:
  - Text protocol: <tool name="…">{json}</tool>
  - Extra helpers: run_python, list_dir, done
  - Aliases for older EdgeRunner names (shell_exec, read_file, …)
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional


@dataclass
class ToolResult:
    ok: bool
    content: str
    title: str = ""
    metadata: dict = field(default_factory=dict)

    def observation(self) -> str:
        status = "ok" if self.ok else "error"
        head = f"[{status}] {self.title}".strip()
        body = (self.content or "").strip()
        if len(body) > 8000:
            body = body[:8000] + "\n…[truncated]"
        return f"{head}\n{body}" if body else head


ToolHandler = Callable[[dict[str, Any], "ToolContext"], ToolResult]


@dataclass
class ToolContext:
    cwd: Path
    todos: list[dict] = field(default_factory=list)
    step: int = 0
    # OpenCode: edit requires a prior read of the same path
    read_paths: set[str] = field(default_factory=set)
    last_test_ok: bool = False


@dataclass
class ToolDef:
    name: str
    description: str
    parameters: dict
    handler: ToolHandler
    readonly: bool = False


# OpenCode-style tool descriptions (condensed from packages/opencode/src/tool/*.txt)
_DESC = {
    "bash": (
        "Run a shell command in the workspace. Prefer for builds, tests, git, "
        "and package managers. Capture exit code, stdout, and stderr."
    ),
    "read": (
        "Read a file from the workspace. Relative paths resolve in the workspace. "
        "Output uses line numbers as `N|line`. Use offset/limit for large files."
    ),
    "write": (
        "Write a full file (create or overwrite). Prefer edit for small changes. "
        "If the file already exists, prefer reading it first."
    ),
    "edit": (
        "Exact string replace in a file (OpenCode-style). oldString must match exactly "
        "once unless replaceAll=true. You must read the file at least once before editing."
    ),
    "glob": "Find files by glob pattern under the workspace (e.g. **/*.py).",
    "grep": (
        "Search file contents with a regex (ripgrep if available, else Python). "
        "Returns path:line:content hits."
    ),
    "apply_patch": (
        "Apply a multi-file patch. Supports OpenCode-ish *** Begin Patch blocks and "
        "Aider-style SEARCH/REPLACE hunks."
    ),
    "todowrite": (
        "Replace the task todo list (OpenCode todowrite). Use for multi-step work. "
        "Statuses: pending | in_progress | completed | cancelled."
    ),
    "webfetch": (
        "Fetch a URL and return text content (HTML stripped lightly). "
        "Use for docs or API examples when internet is available."
    ),
    "websearch": (
        "Web search (Python-only, no Node MCP). Returns title/url/snippet hits. "
        "Use for research; then webfetch specific URLs for full pages."
    ),
    "run_python": (
        "Execute a Python file or -c snippet in the workspace (fast path for tests)."
    ),
    "list_dir": "List files in a directory (workspace-relative).",
    "done": (
        "Finish the task. Call when the user request is complete. "
        "Include a short summary and optional main solution path."
    ),
}


class ToolRegistry:
    def __init__(self, cwd: Optional[Path] = None):
        self.cwd = Path(cwd or tempfile.mkdtemp(prefix="edgerunner_ws_")).resolve()
        self.cwd.mkdir(parents=True, exist_ok=True)
        self.ctx = ToolContext(cwd=self.cwd)
        self._tools: dict[str, ToolDef] = {}
        self._aliases: dict[str, str] = {}
        self._register_builtins()
        self._register_aliases()

    def _register_builtins(self) -> None:
        # Names match OpenCode where possible
        self.register(
            ToolDef(
                "bash",
                _DESC["bash"],
                {
                    "type": "object",
                    "properties": {
                        "command": {"type": "string", "description": "Shell command"},
                        "timeout": {
                            "type": "number",
                            "description": "Timeout ms (default 120000, max 600000)",
                        },
                    },
                    "required": ["command"],
                },
                self._bash,
            )
        )
        self.register(
            ToolDef(
                "read",
                _DESC["read"],
                {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "offset": {"type": "integer", "description": "1-based start line"},
                        "limit": {"type": "integer", "description": "Max lines"},
                    },
                    "required": ["path"],
                },
                self._read,
                readonly=True,
            )
        )
        self.register(
            ToolDef(
                "write",
                _DESC["write"],
                {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["path", "content"],
                },
                self._write,
            )
        )
        self.register(
            ToolDef(
                "edit",
                _DESC["edit"],
                {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "oldString": {"type": "string"},
                        "newString": {"type": "string"},
                        "replaceAll": {"type": "boolean"},
                    },
                    "required": ["path", "oldString", "newString"],
                },
                self._edit,
            )
        )
        self.register(
            ToolDef(
                "glob",
                _DESC["glob"],
                {
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string"},
                        "path": {"type": "string", "description": "Subdirectory"},
                    },
                    "required": ["pattern"],
                },
                self._glob,
                readonly=True,
            )
        )
        self.register(
            ToolDef(
                "grep",
                _DESC["grep"],
                {
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string"},
                        "path": {"type": "string"},
                        "glob": {"type": "string"},
                        "case_insensitive": {"type": "boolean"},
                    },
                    "required": ["pattern"],
                },
                self._grep,
                readonly=True,
            )
        )
        self.register(
            ToolDef(
                "apply_patch",
                _DESC["apply_patch"],
                {
                    "type": "object",
                    "properties": {
                        "patchText": {
                            "type": "string",
                            "description": "Full patch text (*** Begin Patch or SEARCH/REPLACE)",
                        }
                    },
                    "required": ["patchText"],
                },
                self._apply_patch,
            )
        )
        self.register(
            ToolDef(
                "todowrite",
                _DESC["todowrite"],
                {
                    "type": "object",
                    "properties": {
                        "todos": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "id": {"type": "string"},
                                    "content": {"type": "string"},
                                    "status": {
                                        "type": "string",
                                        "enum": [
                                            "pending",
                                            "in_progress",
                                            "completed",
                                            "cancelled",
                                        ],
                                    },
                                },
                            },
                        }
                    },
                    "required": ["todos"],
                },
                self._todowrite,
                readonly=True,
            )
        )
        self.register(
            ToolDef(
                "webfetch",
                _DESC["webfetch"],
                {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string"},
                        "format": {
                            "type": "string",
                            "enum": ["text", "markdown", "html"],
                            "description": "Default text",
                        },
                    },
                    "required": ["url"],
                },
                self._webfetch,
                readonly=True,
            )
        )
        self.register(
            ToolDef(
                "websearch",
                _DESC["websearch"],
                {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "Search query",
                        },
                        "num_results": {
                            "type": "integer",
                            "description": "Max hits (default 5, max 10)",
                        },
                    },
                    "required": ["query"],
                },
                self._websearch,
                readonly=True,
            )
        )
        self.register(
            ToolDef(
                "run_python",
                _DESC["run_python"],
                {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Workspace-relative .py file",
                        },
                        "code": {
                            "type": "string",
                            "description": "Inline code if no path",
                        },
                        "timeout": {"type": "number"},
                    },
                },
                self._run_python,
            )
        )
        self.register(
            ToolDef(
                "list_dir",
                _DESC["list_dir"],
                {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                },
                self._list_dir,
                readonly=True,
            )
        )
        self.register(
            ToolDef(
                "done",
                _DESC["done"],
                {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string"},
                        "path": {
                            "type": "string",
                            "description": "Main solution file path if applicable",
                        },
                    },
                    "required": ["summary"],
                },
                self._done,
                readonly=True,
            )
        )

    def _register_aliases(self) -> None:
        # Older EdgeRunner / MCP-style names → OpenCode names
        for old, new in (
            ("shell_exec", "bash"),
            ("shell", "bash"),
            ("read_file", "read"),
            ("write_file", "write"),
            ("str_replace", "edit"),
            ("search_replace", "edit"),
            ("python_exec", "run_python"),
            ("todo", "todowrite"),
            ("todoread", "todowrite"),
            ("web_fetch", "webfetch"),
            ("fetch", "webfetch"),
            ("web_search", "websearch"),
            ("search", "websearch"),
            ("ddg", "websearch"),
        ):
            self._aliases[old] = new

    def register(self, tool: ToolDef) -> None:
        self._tools[tool.name] = tool

    def resolve_name(self, name: str) -> str:
        n = (name or "").strip()
        return self._aliases.get(n, n)

    def list_for_prompt(self, *, plan_mode: bool = False) -> str:
        lines = [
            "## Tools (OpenCode-compatible)",
            "",
            "Call tools with this exact XML form (one call preferred per step):",
            '<tool name="TOOL_NAME">',
            '{"arg": "value"}',
            "</tool>",
            "",
            "After tools run you receive observations. When finished, call `done`.",
            "",
        ]
        for t in self._tools.values():
            if plan_mode and not t.readonly:
                continue
            lines.append(f"### {t.name}")
            lines.append(t.description)
            lines.append(f"Parameters: {json.dumps(t.parameters)}")
            lines.append("")
        if plan_mode:
            lines.append(
                "PLAN MODE: only readonly tools are allowed "
                "(read, grep, glob, list_dir, webfetch, websearch, todowrite, done)."
            )
        return "\n".join(lines)

    def names(self, *, plan_mode: bool = False) -> list[str]:
        return [n for n, t in self._tools.items() if not plan_mode or t.readonly]

    def call(self, name: str, arguments: Optional[dict] = None) -> ToolResult:
        resolved = self.resolve_name(name)
        tool = self._tools.get(resolved)
        if not tool:
            known = ", ".join(sorted(self._tools))
            return ToolResult(
                False,
                f"Unknown tool: {name}. Known: {known}",
                title=name,
            )
        # Normalize camelCase / snake_case arg variants
        args = _normalize_args(arguments or {})
        try:
            return tool.handler(args, self.ctx)
        except Exception as e:
            return ToolResult(False, f"{type(e).__name__}: {e}", title=resolved)

    def _safe(self, rel: str) -> Path:
        if not rel and rel != "":
            raise ValueError("empty path")
        raw = rel if rel is not None else "."
        p = (self.cwd / raw).resolve() if not Path(raw).is_absolute() else Path(raw).resolve()
        cwd_s = str(self.cwd)
        if not (str(p) == cwd_s or str(p).startswith(cwd_s + os.sep)):
            raise ValueError(f"path escapes workspace: {rel}")
        return p

    def _relkey(self, path: Path) -> str:
        try:
            return str(path.relative_to(self.cwd))
        except ValueError:
            return str(path)

    def _bash(self, args: dict, ctx: ToolContext) -> ToolResult:
        cmd = args.get("command") or args.get("input") or ""
        if not cmd:
            return ToolResult(False, "command is required", title="bash")
        timeout_ms = float(args.get("timeout") or 120_000)
        timeout_ms = min(max(timeout_ms, 1000), 600_000)
        try:
            proc = subprocess.run(
                cmd,
                shell=True,
                cwd=str(ctx.cwd),
                capture_output=True,
                text=True,
                timeout=timeout_ms / 1000.0,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            out = f"exit={proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
            ok = proc.returncode == 0
            if ok and any(
                x in cmd
                for x in ("python", "pytest", "node", "go test", "cargo test")
            ):
                ctx.last_test_ok = True
            return ToolResult(ok, out, title=f"bash: {cmd[:80]}")
        except subprocess.TimeoutExpired:
            return ToolResult(False, f"timeout after {timeout_ms}ms", title="bash")

    def _read(self, args: dict, ctx: ToolContext) -> ToolResult:
        path = self._safe(args.get("path") or args.get("filePath") or "")
        if not path.is_file():
            return ToolResult(False, f"not a file: {args.get('path')}", title="read")
        text = path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()
        offset = int(args.get("offset") or 1)
        limit = args.get("limit")
        start = max(0, offset - 1)
        end = start + int(limit) if limit is not None else len(lines)
        chunk = lines[start:end]
        # OpenCode uses "N: " style; we use "N|" which is also unambiguous
        numbered = "\n".join(f"{i + start + 1}|{ln}" for i, ln in enumerate(chunk))
        ctx.read_paths.add(self._relkey(path))
        return ToolResult(True, numbered or "(empty)", title=f"read {self._relkey(path)}")

    def _write(self, args: dict, ctx: ToolContext) -> ToolResult:
        path = self._safe(args.get("path") or args.get("filePath") or "")
        path.parent.mkdir(parents=True, exist_ok=True)
        content = args.get("content")
        if content is None:
            content = args.get("input") or ""
        content = str(content)
        existed = path.is_file()
        path.write_text(
            content if content.endswith("\n") else content + "\n", encoding="utf-8"
        )
        ctx.read_paths.add(self._relkey(path))  # written content is known
        verb = "Wrote" if existed else "Created"
        return ToolResult(
            True,
            f"{verb} file successfully: {self._relkey(path)} ({len(content)} bytes)",
            title="write",
        )

    def _edit(self, args: dict, ctx: ToolContext) -> ToolResult:
        path = self._safe(args.get("path") or args.get("filePath") or "")
        rel = self._relkey(path)
        if not path.is_file():
            return ToolResult(False, f"file not found: {rel}", title="edit")
        # OpenCode: require read first (soft on first write same path is ok)
        if rel not in ctx.read_paths:
            return ToolResult(
                False,
                f"You must use Read on '{rel}' at least once before editing.",
                title="edit",
            )
        old = args.get("oldString") if "oldString" in args else args.get("old_string")
        new = args.get("newString") if "newString" in args else args.get("new_string")
        if old is None:
            old = ""
        if new is None:
            new = ""
        old, new = str(old), str(new)
        if old == new:
            return ToolResult(False, "oldString and newString are identical", title="edit")
        text = path.read_text(encoding="utf-8", errors="replace")
        text_n = text.replace("\r\n", "\n")
        old_n = old.replace("\r\n", "\n")
        new_n = new.replace("\r\n", "\n")
        count = text_n.count(old_n)
        if count == 0:
            return ToolResult(
                False,
                "oldString not found in file (exact match required)",
                title="edit",
            )
        replace_all = bool(
            args.get("replaceAll")
            if "replaceAll" in args
            else args.get("replace_all")
        )
        if count > 1 and not replace_all:
            return ToolResult(
                False,
                f"oldString found {count} times; set replaceAll=true or provide more context",
                title="edit",
            )
        if replace_all:
            updated = text_n.replace(old_n, new_n)
            n = count
        else:
            updated = text_n.replace(old_n, new_n, 1)
            n = 1
        path.write_text(updated, encoding="utf-8")
        return ToolResult(True, f"Edited {rel}: {n} replacement(s)", title="edit")

    def _glob(self, args: dict, ctx: ToolContext) -> ToolResult:
        pattern = args.get("pattern") or "*"
        base = self._safe(args.get("path") or ".")
        if not base.exists():
            return ToolResult(False, f"missing path: {args.get('path')}", title="glob")
        matches: list[str] = []
        # Support ** patterns via rglob of the non-glob suffix
        if "**" in pattern or "*" in pattern or "?" in pattern:
            # pathlib: base.glob/rglob
            try:
                if pattern.startswith("**/"):
                    matches = sorted(
                        str(p.relative_to(ctx.cwd))
                        for p in base.rglob(pattern[3:])
                        if p.is_file()
                    )
                else:
                    matches = sorted(
                        str(p.relative_to(ctx.cwd))
                        for p in base.glob(pattern)
                        if p.is_file()
                    )
                    if not matches:
                        matches = sorted(
                            str(p.relative_to(ctx.cwd))
                            for p in base.rglob(pattern)
                            if p.is_file()
                        )
            except Exception:
                matches = []
        else:
            matches = sorted(
                str(p.relative_to(ctx.cwd))
                for p in base.rglob(pattern)
                if p.is_file()
            )
        return ToolResult(
            True, "\n".join(matches[:200]) or "(no matches)", title="glob"
        )

    def _grep(self, args: dict, ctx: ToolContext) -> ToolResult:
        pattern = args.get("pattern") or ""
        search_path = self._safe(args.get("path") or ".")
        flags = re.IGNORECASE if args.get("case_insensitive") else 0
        try:
            rx = re.compile(pattern, flags)
        except re.error as e:
            return ToolResult(False, f"invalid regex: {e}", title="grep")
        if shutil.which("rg"):
            cmd = ["rg", "-n", "--no-heading"]
            if args.get("case_insensitive"):
                cmd.append("-i")
            if args.get("glob"):
                cmd.extend(["--glob", str(args["glob"])])
            cmd.extend([pattern, str(search_path)])
            try:
                proc = subprocess.run(
                    cmd, capture_output=True, text=True, timeout=30, cwd=str(ctx.cwd)
                )
                out = proc.stdout or "(no matches)"
                return ToolResult(True, out[:8000], title="grep")
            except Exception:
                pass
        hits: list[str] = []
        files = [search_path] if search_path.is_file() else list(search_path.rglob("*"))
        for f in files:
            if not f.is_file():
                continue
            if args.get("glob"):
                try:
                    if not f.match(args["glob"]):
                        continue
                except Exception:
                    continue
            try:
                for i, line in enumerate(
                    f.read_text(encoding="utf-8", errors="replace").splitlines(), 1
                ):
                    if rx.search(line):
                        rel = f.relative_to(ctx.cwd)
                        hits.append(f"{rel}:{i}:{line}")
                        if len(hits) >= 100:
                            break
            except Exception:
                continue
            if len(hits) >= 100:
                break
        return ToolResult(
            True, "\n".join(hits) if hits else "(no matches)", title="grep"
        )

    def _apply_patch(self, args: dict, ctx: ToolContext) -> ToolResult:
        """Simplified apply_patch: *** Add/Update File + Aider SEARCH/REPLACE."""
        text = args.get("patchText") or args.get("patch") or args.get("input") or ""
        if not str(text).strip():
            return ToolResult(False, "patchText is required", title="apply_patch")
        text = str(text).replace("\r\n", "\n")
        applied: list[str] = []

        # Aider-style blocks with optional path header
        aider = re.compile(
            r"(?:(?:<<<<<<<\s*SEARCH|<<<<<<<)\s*\n)(.*?)(?:=======\s*\n)(.*?)(?:>>>>>>>[^\n]*\n?)",
            re.DOTALL,
        )
        # Path: file.py before SEARCH, or *** Update File: path
        update_hdr = re.compile(
            r"\*\*\*\s*(?:Add|Update)\s+File:\s*(\S+)\s*\n(.*?)(?=\*\*\*\s*(?:Add|Update|Delete|End)|\Z)",
            re.DOTALL | re.IGNORECASE,
        )

        # *** Add File / Update File blocks
        for m in update_hdr.finditer(text):
            rel = m.group(1).strip()
            body = m.group(2)
            # Strip trailing *** End markers from body
            body = re.sub(r"\*\*\*\s*End[^\n]*\n?", "", body, flags=re.I).rstrip("\n") + "\n"
            # If body contains SEARCH/REPLACE, treat as update hunks for that file
            if "<<<<<<<" in body or "=======" in body:
                path = self._safe(rel)
                if not path.is_file():
                    return ToolResult(
                        False,
                        f"Unable to apply patch at {rel}: file not found",
                        title="apply_patch",
                    )
                content = path.read_text(encoding="utf-8", errors="replace").replace(
                    "\r\n", "\n"
                )
                for sm in aider.finditer(body):
                    old, new = sm.group(1), sm.group(2)
                    old = old if old.endswith("\n") or old == "" else old
                    # normalize trailing
                    if old not in content:
                        # try strip trailing newline variance
                        old2 = old.rstrip("\n")
                        if old2 in content:
                            old = old2
                        else:
                            return ToolResult(
                                False,
                                f"Unable to apply patch at {rel}: SEARCH block not found",
                                title="apply_patch",
                            )
                    content = content.replace(old, new, 1)
                path.write_text(content, encoding="utf-8")
                ctx.read_paths.add(rel)
                applied.append(f"M {rel}")
            else:
                # pure add/overwrite
                path = self._safe(rel)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(body if body.endswith("\n") else body + "\n", encoding="utf-8")
                ctx.read_paths.add(rel)
                applied.append(f"A {rel}")

        # Standalone SEARCH/REPLACE without path header → require single file or fail
        if not applied and ("<<<<<<<" in text):
            return ToolResult(
                False,
                "SEARCH/REPLACE found but no file path. Prefix with "
                "'*** Update File: path' or use the edit tool.",
                title="apply_patch",
            )

        if not applied:
            return ToolResult(
                False,
                "patch rejected: no recognized hunks "
                "(use *** Add File: path / *** Update File: path or edit tool)",
                title="apply_patch",
            )
        return ToolResult(
            True,
            "Applied patch sequentially:\n" + "\n".join(applied),
            title="apply_patch",
        )

    def _todowrite(self, args: dict, ctx: ToolContext) -> ToolResult:
        todos = args.get("todos") or []
        if not isinstance(todos, list):
            return ToolResult(False, "todos must be an array", title="todowrite")
        ctx.todos = todos
        lines = []
        for t in todos:
            if not isinstance(t, dict):
                continue
            lines.append(
                f"- [{t.get('status', 'pending')}] {t.get('id', '?')}: {t.get('content', '')}"
            )
        return ToolResult(
            True, "\n".join(lines) or "(empty todos)", title="todowrite"
        )

    def _webfetch(self, args: dict, ctx: ToolContext) -> ToolResult:
        url = (args.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            return ToolResult(False, "url must start with http:// or https://", title="webfetch")
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "EdgeRunner/1.0 (OpenCode-style webfetch)"},
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read(500_000)
                ctype = resp.headers.get("Content-Type", "")
            text = raw.decode("utf-8", errors="replace")
            if "html" in ctype.lower() or text.lstrip().lower().startswith("<!doctype"):
                # light strip tags
                text = re.sub(r"(?is)<script[^>]*>.*?</script>", " ", text)
                text = re.sub(r"(?is)<style[^>]*>.*?</style>", " ", text)
                text = re.sub(r"(?s)<[^>]+>", " ", text)
                text = re.sub(r"\s+", " ", text).strip()
            if len(text) > 12000:
                text = text[:12000] + "\n…[truncated]"
            return ToolResult(True, text or "(empty)", title=f"webfetch {url[:60]}")
        except urllib.error.HTTPError as e:
            return ToolResult(False, f"HTTP {e.code}: {e.reason}", title="webfetch")
        except Exception as e:
            return ToolResult(False, f"{type(e).__name__}: {e}", title="webfetch")

    def _websearch(self, args: dict, ctx: ToolContext) -> ToolResult:
        """Python-only search (DuckDuckGo HTML) — no Node/MCP process required."""
        query = (args.get("query") or args.get("q") or args.get("input") or "").strip()
        if not query:
            return ToolResult(False, "query is required", title="websearch")
        n = int(args.get("num_results") or args.get("limit") or 5)
        n = max(1, min(n, 10))
        try:
            from urllib.parse import quote_plus, unquote

            # DuckDuckGo HTML endpoint (no API key)
            q = quote_plus(query)
            url = f"https://html.duckduckgo.com/html/?q={q}"
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (compatible; EdgeRunner/1.0; +https://github.com/deveshpat/EdgeRunner)"
                    ),
                    "Accept": "text/html",
                },
            )
            with urllib.request.urlopen(req, timeout=25) as resp:
                html = resp.read(800_000).decode("utf-8", errors="replace")

            # Parse result blocks: result__a + result__snippet
            hits: list[str] = []
            # Anchors with result__a class
            for m in re.finditer(
                r'class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
                html,
                re.I | re.DOTALL,
            ):
                href = m.group(1)
                title = re.sub(r"<[^>]+>", "", m.group(2))
                title = re.sub(r"\s+", " ", title).strip()
                # DDG redirect URLs: //duckduckgo.com/l/?uddg=<encoded>
                if "uddg=" in href:
                    um = re.search(r"uddg=([^&]+)", href)
                    if um:
                        href = unquote(um.group(1))
                if href.startswith("//"):
                    href = "https:" + href
                # Find nearby snippet
                snippet = ""
                tail = html[m.end() : m.end() + 800]
                sm = re.search(
                    r'class="[^"]*result__snippet[^"]*"[^>]*>(.*?)</(?:a|td|div)',
                    tail,
                    re.I | re.DOTALL,
                )
                if sm:
                    snippet = re.sub(r"<[^>]+>", "", sm.group(1))
                    snippet = re.sub(r"\s+", " ", snippet).strip()
                if not title and not href:
                    continue
                hits.append(f"{len(hits) + 1}. {title}\n   {href}\n   {snippet}")
                if len(hits) >= n:
                    break

            if not hits:
                # Fallback: bare links in page
                for m in re.finditer(
                    r'href="(https?://(?!duckduckgo\.com)[^"]+)"[^>]*>([^<]{4,120})</a>',
                    html,
                    re.I,
                ):
                    hits.append(f"{len(hits) + 1}. {m.group(2).strip()}\n   {m.group(1)}")
                    if len(hits) >= n:
                        break

            body = "\n\n".join(hits) if hits else "(no results — try a simpler query)"
            return ToolResult(True, f"Query: {query}\n\n{body}", title="websearch")
        except Exception as e:
            return ToolResult(False, f"{type(e).__name__}: {e}", title="websearch")

    def _run_python(self, args: dict, ctx: ToolContext) -> ToolResult:
        timeout = float(args.get("timeout") or 30)
        if args.get("path"):
            path = self._safe(args["path"])
            cmd = ["python", str(path)]
        elif args.get("code"):
            cmd = ["python", "-c", args["code"]]
        else:
            return ToolResult(False, "provide path or code", title="run_python")
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(ctx.cwd),
                capture_output=True,
                text=True,
                timeout=timeout,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            out = f"exit={proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
            ok = proc.returncode == 0
            if ok:
                ctx.last_test_ok = True
            return ToolResult(ok, out, title="run_python")
        except subprocess.TimeoutExpired:
            return ToolResult(False, f"timeout after {timeout}s", title="run_python")

    def _list_dir(self, args: dict, ctx: ToolContext) -> ToolResult:
        path = self._safe(args.get("path") or ".")
        if not path.exists():
            return ToolResult(False, f"missing: {args.get('path')}", title="list_dir")
        if path.is_file():
            return ToolResult(True, str(path.relative_to(ctx.cwd)), title="list_dir")
        names = sorted(os.listdir(path))[:200]
        return ToolResult(
            True, "\n".join(names) if names else "(empty)", title="list_dir"
        )

    def _done(self, args: dict, ctx: ToolContext) -> ToolResult:
        summary = args.get("summary") or args.get("input") or "done"
        path = args.get("path")
        extra = ""
        if path:
            try:
                p = self._safe(path)
                if p.is_file():
                    extra = (
                        f"\n\n# file: {path}\n"
                        + p.read_text(encoding="utf-8", errors="replace")[:6000]
                    )
            except Exception as e:
                extra = f"\n(could not read path: {e})"
        return ToolResult(True, str(summary) + extra, title="DONE")


def _normalize_args(args: dict) -> dict:
    """Accept both camelCase and snake_case keys used by different models."""
    if not isinstance(args, dict):
        return {}
    out = dict(args)
    pairs = (
        ("old_string", "oldString"),
        ("new_string", "newString"),
        ("replace_all", "replaceAll"),
        ("file_path", "path"),
        ("filePath", "path"),
        ("patch_text", "patchText"),
    )
    for a, b in pairs:
        if a in out and b not in out:
            out[b] = out[a]
        if b in out and a not in out:
            out[a] = out[b]
    return out


# --- parsing tool calls from model text (GGUF-friendly) ---

_TOOL_XML = re.compile(
    r'<tool\s+name=["\']([^"\']+)["\']\s*>(.*?)</tool>',
    re.DOTALL | re.IGNORECASE,
)
_TOOL_CALL_FENCE = re.compile(
    r"```(?:tool|json)?\s*\n\s*\{\s*\"(?:tool|name)\"\s*:\s*\"([^\"]+)\"\s*,\s*\"(?:arguments|args|input)\"\s*:\s*(\{.*?\})\s*\}\s*\n```",
    re.DOTALL,
)
_TOOL_INVOKE = re.compile(
    r"(?:tool_call|invoke|call_tool)\s*\(\s*[\"']([^\"']+)[\"']\s*,\s*(\{.*?\})\s*\)",
    re.DOTALL,
)


def parse_tool_calls(text: str) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    for m in _TOOL_XML.finditer(text or ""):
        name = m.group(1).strip()
        raw = m.group(2).strip()
        args: dict = {}
        if raw:
            try:
                parsed = json.loads(raw)
                args = parsed if isinstance(parsed, dict) else {"input": parsed}
            except json.JSONDecodeError:
                # try bare JSON object recovery
                brace = re.search(r"\{.*\}", raw, re.DOTALL)
                if brace:
                    try:
                        parsed = json.loads(brace.group(0))
                        args = parsed if isinstance(parsed, dict) else {"input": raw}
                    except json.JSONDecodeError:
                        pass
                if not args:
                    for line in raw.splitlines():
                        if ":" in line:
                            k, v = line.split(":", 1)
                            args[k.strip().strip('"')] = v.strip().strip('"')
                if not args:
                    args = {"input": raw}
        out.append((name, args))
    if out:
        return out
    for m in _TOOL_CALL_FENCE.finditer(text or ""):
        name = m.group(1).strip()
        try:
            args = json.loads(m.group(2))
        except json.JSONDecodeError:
            args = {}
        out.append((name, args if isinstance(args, dict) else {}))
    if out:
        return out
    for m in _TOOL_INVOKE.finditer(text or ""):
        name = m.group(1).strip()
        try:
            args = json.loads(m.group(2))
        except json.JSONDecodeError:
            args = {}
        out.append((name, args if isinstance(args, dict) else {}))
    return out
