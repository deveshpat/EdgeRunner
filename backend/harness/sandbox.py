"""Workspace sandbox — SWE-agent style file+shell execution with timeouts."""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from harness.language import LangSpec


@dataclass
class ExecResult:
    ok: bool
    stdout: str
    stderr: str
    exit_code: int
    command: str

    def observation(self) -> str:
        """Compact ACI-style observation for the model (SWE-agent inspired)."""
        status = "SUCCESS" if self.ok else "FAILED"
        out = (self.stdout or "").strip()
        err = (self.stderr or "").strip()
        # Cap observation size for small-context GGUF models
        def clip(s: str, n: int = 2500) -> str:
            return s if len(s) <= n else s[:n] + "\n…[truncated]"

        parts = [f"status: {status}", f"exit_code: {self.exit_code}", f"command: {self.command}"]
        if out:
            parts.append(f"stdout:\n{clip(out)}")
        if err:
            parts.append(f"stderr:\n{clip(err)}")
        return "\n".join(parts)


@dataclass
class Workspace:
    """Ephemeral project dir for one harness run."""

    root: Path
    lang: LangSpec
    _tmp: tempfile.TemporaryDirectory = field(repr=False)

    @classmethod
    def create(cls, lang: LangSpec, prefix: str = "edgerunner_") -> "Workspace":
        tmp = tempfile.TemporaryDirectory(prefix=prefix)
        root = Path(tmp.name)
        return cls(root=root, lang=lang, _tmp=tmp)

    def cleanup(self) -> None:
        try:
            self._tmp.cleanup()
        except Exception:
            pass

    def write(self, rel: str, content: str) -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content if content.endswith("\n") else content + "\n", encoding="utf-8")
        return path

    def read(self, rel: str, max_chars: int = 8000) -> str:
        path = self.root / rel
        if not path.is_file():
            return f"[missing file: {rel}]"
        data = path.read_text(encoding="utf-8", errors="replace")
        if len(data) > max_chars:
            return data[:max_chars] + "\n…[truncated]"
        return data

    def list_files(self, rel: str = ".") -> str:
        base = (self.root / rel).resolve()
        if not str(base).startswith(str(self.root.resolve())):
            return "[path escape blocked]"
        if not base.exists():
            return f"[missing: {rel}]"
        lines = []
        for p in sorted(base.rglob("*")):
            if p.is_file():
                lines.append(str(p.relative_to(self.root)))
        return "\n".join(lines) if lines else "(empty)"

    def run_shell(
        self,
        argv: list[str],
        *,
        timeout: float = 20.0,
        env: Optional[dict] = None,
    ) -> ExecResult:
        full_env = os.environ.copy()
        full_env["PYTHONDONTWRITEBYTECODE"] = "1"
        if env:
            full_env.update(env)
        cmd_str = " ".join(argv)
        try:
            proc = subprocess.run(
                argv,
                cwd=str(self.root),
                capture_output=True,
                text=True,
                timeout=timeout,
                env=full_env,
            )
            return ExecResult(
                ok=proc.returncode == 0,
                stdout=proc.stdout or "",
                stderr=proc.stderr or "",
                exit_code=proc.returncode,
                command=cmd_str,
            )
        except subprocess.TimeoutExpired:
            return ExecResult(
                ok=False,
                stdout="",
                stderr=f"TIMEOUT after {timeout}s (possible infinite loop)",
                exit_code=-1,
                command=cmd_str,
            )
        except FileNotFoundError as e:
            return ExecResult(
                ok=False,
                stdout="",
                stderr=f"Runtime not found: {e}",
                exit_code=127,
                command=cmd_str,
            )
        except Exception as e:
            return ExecResult(
                ok=False,
                stdout="",
                stderr=f"SYSTEM ERROR: {e}",
                exit_code=-2,
                command=cmd_str,
            )


def run_solution_and_tests(
    lang: LangSpec,
    code: str,
    tests: str,
    *,
    timeout: float = 20.0,
) -> tuple[ExecResult, Workspace]:
    """
    Write solution + tests into a workspace and execute.

    Python: concatenate solution + tests in one file (assert style) OR
            solution.py + tests that import * when tests look like pytest.
    """
    ws = Workspace.create(lang)
    try:
        if lang.id == "python":
            return _run_python(ws, code, tests, timeout=timeout), ws
        if lang.id in ("javascript", "typescript"):
            return _run_node(ws, code, tests, timeout=timeout), ws
        if lang.id == "bash":
            sol = ws.write("solution.sh", code)
            os.chmod(sol, 0o755)
            if tests.strip():
                tpath = ws.write("tests.sh", tests)
                os.chmod(tpath, 0o755)
                res = ws.run_shell(["bash", str(tpath)], timeout=timeout)
            else:
                res = ws.run_shell(["bash", str(sol)], timeout=timeout)
            return res, ws
        # Generic: write solution only and run
        path = ws.write(f"solution{lang.ext}", code)
        argv = [a.replace("{path}", str(path)).replace("{bin}", str(ws.root / "out")) for a in lang.run]
        if "&&" in argv:
            # simple rust-style chain via shell
            res = ws.run_shell(["bash", "-lc", " ".join(argv)], timeout=timeout)
        else:
            res = ws.run_shell(argv, timeout=timeout)
        return res, ws
    except Exception as e:
        return (
            ExecResult(False, "", str(e), -2, "workspace"),
            ws,
        )


def _run_python(ws: Workspace, code: str, tests: str, *, timeout: float) -> ExecResult:
    sol = ws.write("solution.py", code)
    if not tests.strip():
        return ws.run_shell(["python", str(sol)], timeout=timeout)

    # If tests import solution / use pytest style
    if re_import_solution(tests) or "pytest" in tests or "unittest" in tests:
        ws.write("tests_main.py", tests)
        # Prefer pytest if available
        if shutil.which("pytest"):
            return ws.run_shell(
                ["python", "-m", "pytest", "-q", "tests_main.py"],
                timeout=timeout,
            )
        return ws.run_shell(["python", "tests_main.py"], timeout=timeout)

    # Classic harness: solution + asserts in one process (no dedent — preserves code indent)
    combined = (
        "# --- solution ---\n"
        + code.rstrip()
        + "\n\n# --- tests ---\n"
        + tests.rstrip()
        + '\nprint("__EDGERUNNER_TESTS_OK__")\n'
    )
    ws.write("run_all.py", combined)
    res = ws.run_shell(["python", "run_all.py"], timeout=timeout)
    if res.ok and "__EDGERUNNER_TESTS_OK__" not in (res.stdout or ""):
        # asserts may have passed without print if tests didn't finish cleanly
        pass
    return res


def re_import_solution(tests: str) -> bool:
    return "import solution" in tests or "from solution" in tests


def _run_node(ws: Workspace, code: str, tests: str, *, timeout: float) -> ExecResult:
    ws.write("solution.js", code)
    if tests.strip():
        ws.write(
            "run_all.js",
            f"{code}\n\n// --- tests ---\n{tests}\nconsole.log('__EDGERUNNER_TESTS_OK__');\n",
        )
        return ws.run_shell(["node", "run_all.js"], timeout=timeout)
    return ws.run_shell(["node", "solution.js"], timeout=timeout)
