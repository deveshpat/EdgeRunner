"""
Minimal MCP (Model Context Protocol) client + built-in high-leverage tools.

Design notes (literature / practice):
- MCP standardizes tools/resources so agents can use language-specific servers
  (filesystem, git, language servers) without bespoke integrations.
- Local GGUF models often lack reliable JSON tool-calling; the harness therefore
  (1) exposes tools to the pipeline deterministically, and
  (2) optionally lets the model request tools via a simple XML/markdown protocol.

Config (optional JSON file or env EDGERUNNER_MCP_CONFIG):
{
  "servers": [
    {"name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]},
    {"name": "git", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-git", "--repository", "."]}
  ]
}
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict  # JSON-schema-ish
    handler: Optional[Callable[..., Any]] = None
    server: str = "builtin"


@dataclass
class ToolResult:
    ok: bool
    content: str
    raw: Any = None


class BuiltinToolRegistry:
    """High-leverage tools always available inside the worker (no Node required)."""

    def __init__(self, cwd: Optional[Path] = None):
        self.cwd = Path(cwd or os.getcwd()).resolve()
        self._tools: dict[str, ToolSpec] = {}
        self._register_defaults()

    def _register_defaults(self) -> None:
        self.register(
            ToolSpec(
                name="shell_exec",
                description="Run a shell command in the workspace (timeout 30s). Prefer for builds/tests.",
                parameters={
                    "type": "object",
                    "properties": {
                        "command": {"type": "string"},
                        "timeout": {"type": "number"},
                    },
                    "required": ["command"],
                },
                handler=self._shell_exec,
            )
        )
        self.register(
            ToolSpec(
                name="read_file",
                description="Read a UTF-8 text file relative to workspace.",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "max_chars": {"type": "integer"},
                    },
                    "required": ["path"],
                },
                handler=self._read_file,
            )
        )
        self.register(
            ToolSpec(
                name="write_file",
                description="Write a UTF-8 text file relative to workspace.",
                parameters={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["path", "content"],
                },
                handler=self._write_file,
            )
        )
        self.register(
            ToolSpec(
                name="list_dir",
                description="List files under a relative directory.",
                parameters={
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                },
                handler=self._list_dir,
            )
        )
        self.register(
            ToolSpec(
                name="python_exec",
                description="Execute a Python snippet in a subprocess (high leverage for Python tasks).",
                parameters={
                    "type": "object",
                    "properties": {
                        "code": {"type": "string"},
                        "timeout": {"type": "number"},
                    },
                    "required": ["code"],
                },
                handler=self._python_exec,
            )
        )
        self.register(
            ToolSpec(
                name="node_exec",
                description="Execute a JavaScript snippet with node if available.",
                parameters={
                    "type": "object",
                    "properties": {
                        "code": {"type": "string"},
                        "timeout": {"type": "number"},
                    },
                    "required": ["code"],
                },
                handler=self._node_exec,
            )
        )
        self.register(
            ToolSpec(
                name="which",
                description="Locate an executable on PATH (python, node, go, rustc, git, …).",
                parameters={
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                },
                handler=self._which,
            )
        )

    def register(self, tool: ToolSpec) -> None:
        self._tools[tool.name] = tool

    def list_tools(self) -> list[dict]:
        return [
            {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
                "server": t.server,
            }
            for t in self._tools.values()
        ]

    def call(self, name: str, arguments: Optional[dict] = None) -> ToolResult:
        tool = self._tools.get(name)
        if not tool or not tool.handler:
            return ToolResult(False, f"Unknown tool: {name}")
        try:
            out = tool.handler(**(arguments or {}))
            if isinstance(out, ToolResult):
                return out
            return ToolResult(True, str(out))
        except Exception as e:
            return ToolResult(False, f"Tool error ({name}): {e}")

    def _safe_path(self, rel: str) -> Path:
        p = (self.cwd / rel).resolve()
        if not str(p).startswith(str(self.cwd)):
            raise ValueError("path escapes workspace")
        return p

    def _shell_exec(self, command: str, timeout: float = 30.0) -> ToolResult:
        try:
            proc = subprocess.run(
                command,
                shell=True,
                cwd=str(self.cwd),
                capture_output=True,
                text=True,
                timeout=float(timeout),
            )
            body = f"exit={proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
            return ToolResult(proc.returncode == 0, body[:6000])
        except subprocess.TimeoutExpired:
            return ToolResult(False, f"timeout after {timeout}s")

    def _read_file(self, path: str, max_chars: int = 8000) -> ToolResult:
        p = self._safe_path(path)
        if not p.is_file():
            return ToolResult(False, f"not a file: {path}")
        data = p.read_text(encoding="utf-8", errors="replace")
        if len(data) > int(max_chars):
            data = data[: int(max_chars)] + "\n…[truncated]"
        return ToolResult(True, data)

    def _write_file(self, path: str, content: str) -> ToolResult:
        p = self._safe_path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        return ToolResult(True, f"wrote {path} ({len(content)} bytes)")

    def _list_dir(self, path: str = ".") -> ToolResult:
        p = self._safe_path(path)
        if not p.exists():
            return ToolResult(False, f"missing: {path}")
        if p.is_file():
            return ToolResult(True, path)
        names = sorted(os.listdir(p))[:200]
        return ToolResult(True, "\n".join(names) if names else "(empty)")

    def _python_exec(self, code: str, timeout: float = 20.0) -> ToolResult:
        try:
            proc = subprocess.run(
                ["python", "-c", code],
                cwd=str(self.cwd),
                capture_output=True,
                text=True,
                timeout=float(timeout),
            )
            body = f"exit={proc.returncode}\n{proc.stdout}\n{proc.stderr}"
            return ToolResult(proc.returncode == 0, body[:6000])
        except Exception as e:
            return ToolResult(False, str(e))

    def _node_exec(self, code: str, timeout: float = 20.0) -> ToolResult:
        if not shutil.which("node"):
            return ToolResult(False, "node not installed on this worker")
        try:
            proc = subprocess.run(
                ["node", "-e", code],
                cwd=str(self.cwd),
                capture_output=True,
                text=True,
                timeout=float(timeout),
            )
            body = f"exit={proc.returncode}\n{proc.stdout}\n{proc.stderr}"
            return ToolResult(proc.returncode == 0, body[:6000])
        except Exception as e:
            return ToolResult(False, str(e))

    def _which(self, name: str) -> ToolResult:
        path = shutil.which(name)
        return ToolResult(bool(path), path or f"{name} not found")


class McpStdioSession:
    """
    Very small MCP client over stdio JSON-RPC 2.0.

    Only implements tools/list + tools/call — enough for agent use.
    Fails soft if the server binary is missing (common on Kaggle without Node).
    """

    def __init__(self, name: str, command: str, args: list[str], env: Optional[dict] = None):
        self.name = name
        self.command = command
        self.args = args
        self.env = env
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._id = 0

    def start(self) -> bool:
        if not shutil.which(self.command) and self.command not in ("./mcp",):
            # allow absolute paths
            if not Path(self.command).exists():
                return False
        try:
            env = os.environ.copy()
            if self.env:
                env.update(self.env)
            self._proc = subprocess.Popen(
                [self.command, *self.args],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                env=env,
            )
            # initialize
            self._rpc(
                "initialize",
                {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "edgerunner", "version": "0.2"},
                },
            )
            # notifications/initialized (no id)
            self._notify("notifications/initialized", {})
            return True
        except Exception:
            self.close()
            return False

    def close(self) -> None:
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.terminate()
            except Exception:
                pass
        self._proc = None

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def _notify(self, method: str, params: dict) -> None:
        if not self._proc or not self._proc.stdin:
            return
        msg = {"jsonrpc": "2.0", "method": method, "params": params}
        self._proc.stdin.write(json.dumps(msg) + "\n")
        self._proc.stdin.flush()

    def _rpc(self, method: str, params: Optional[dict] = None, timeout: float = 15.0) -> Any:
        if not self._proc or not self._proc.stdin or not self._proc.stdout:
            raise RuntimeError("MCP server not started")
        req_id = self._next_id()
        msg = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            msg["params"] = params
        with self._lock:
            self._proc.stdin.write(json.dumps(msg) + "\n")
            self._proc.stdin.flush()
            # Read lines until matching id (simple single-thread protocol)
            deadline_lines = 50
            for _ in range(deadline_lines):
                line = self._proc.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if data.get("id") == req_id:
                    if "error" in data:
                        raise RuntimeError(str(data["error"]))
                    return data.get("result")
        raise TimeoutError(f"MCP RPC timeout: {method}")

    def list_tools(self) -> list[dict]:
        result = self._rpc("tools/list", {})
        tools = (result or {}).get("tools") or []
        out = []
        for t in tools:
            out.append(
                {
                    "name": f"mcp.{self.name}.{t.get('name')}",
                    "description": t.get("description") or "",
                    "parameters": t.get("inputSchema") or {},
                    "server": self.name,
                    "_mcp_tool": t.get("name"),
                }
            )
        return out

    def call_tool(self, tool_name: str, arguments: dict) -> ToolResult:
        try:
            result = self._rpc(
                "tools/call",
                {"name": tool_name, "arguments": arguments or {}},
            )
            # MCP content is often [{type:text,text:...}]
            content_parts = []
            for block in (result or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "text":
                    content_parts.append(block.get("text") or "")
                else:
                    content_parts.append(str(block))
            text = "\n".join(content_parts) if content_parts else json.dumps(result)[:4000]
            is_err = bool((result or {}).get("isError"))
            return ToolResult(not is_err, text, raw=result)
        except Exception as e:
            return ToolResult(False, f"MCP call failed: {e}")


@dataclass
class ToolHub:
    """Builtin + optional external MCP servers."""

    builtin: BuiltinToolRegistry
    sessions: list[McpStdioSession] = field(default_factory=list)
    _mcp_index: dict[str, tuple[McpStdioSession, str]] = field(default_factory=dict)

    @classmethod
    def create(cls, cwd: Optional[str] = None) -> "ToolHub":
        hub = cls(builtin=BuiltinToolRegistry(cwd=Path(cwd) if cwd else None))
        hub._load_external()
        return hub

    def _load_external(self) -> None:
        cfg_path = os.environ.get("EDGERUNNER_MCP_CONFIG", "").strip()
        if not cfg_path:
            # optional default next to backend
            candidate = Path(__file__).resolve().parent.parent / "mcp_config.json"
            if candidate.is_file():
                cfg_path = str(candidate)
        if not cfg_path or not Path(cfg_path).is_file():
            return
        try:
            cfg = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
        except Exception:
            return
        for server in cfg.get("servers") or []:
            name = server.get("name") or f"srv_{uuid.uuid4().hex[:6]}"
            command = server.get("command")
            args = server.get("args") or []
            if not command:
                continue
            sess = McpStdioSession(name, command, args, env=server.get("env"))
            if sess.start():
                self.sessions.append(sess)
                try:
                    for t in sess.list_tools():
                        # map full name -> (session, raw tool name)
                        raw = t.get("_mcp_tool") or t["name"].split(".")[-1]
                        self._mcp_index[t["name"]] = (sess, raw)
                except Exception:
                    sess.close()

    def list_tools(self) -> list[dict]:
        tools = self.builtin.list_tools()
        for name, (sess, raw) in self._mcp_index.items():
            tools.append(
                {
                    "name": name,
                    "description": f"MCP/{sess.name}: {raw}",
                    "parameters": {},
                    "server": sess.name,
                }
            )
        return tools

    def call(self, name: str, arguments: Optional[dict] = None) -> ToolResult:
        if name in self._mcp_index:
            sess, raw = self._mcp_index[name]
            return sess.call_tool(raw, arguments or {})
        # allow mcp.server.tool without full index rebuild
        if name.startswith("mcp."):
            return ToolResult(False, f"MCP tool not connected: {name}")
        return self.builtin.call(name, arguments)

    def tools_prompt_block(self) -> str:
        lines = ["Available tools (call only when needed):"]
        for t in self.list_tools()[:40]:
            lines.append(f"- {t['name']}: {t.get('description', '')[:120]}")
        lines.append(
            "To use a tool, output exactly:\n"
            "<tool name=\"TOOL_NAME\">{\"arg\": \"value\"}</tool>\n"
            "Then wait for the observation."
        )
        return "\n".join(lines)

    def close(self) -> None:
        for s in self.sessions:
            s.close()
        self.sessions.clear()
        self._mcp_index.clear()


def parse_tool_calls(text: str) -> list[tuple[str, dict]]:
    """Parse simple <tool name=\"...\">{json}</tool> directives from model output."""
    import re

    out: list[tuple[str, dict]] = []
    for m in re.finditer(
        r'<tool\s+name=["\']([^"\']+)["\']\s*>(.*?)</tool>',
        text or "",
        re.DOTALL | re.IGNORECASE,
    ):
        name = m.group(1).strip()
        raw = m.group(2).strip()
        args: dict = {}
        if raw:
            try:
                args = json.loads(raw)
            except json.JSONDecodeError:
                args = {"input": raw}
        out.append((name, args if isinstance(args, dict) else {"input": args}))
    return out
