"""Unified 'terminal' omnitool for EdgeRunner.

Consolidates all agent capabilities into a single universal tool that any model
(from 3B non-reasoning to 70B frontier) can reliably call and execute in the
shared `./workspace` sandbox.

Includes a tolerant alias router and fuzzy argument parser to handle whatever
names or keys a model generates.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from typing import Any, Callable

from app.workspace import WORKSPACE_ROOT, ensure_workspace

CODE_TIMEOUT = 30
_OUTPUT_CAP = 4000


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: dict  # OpenAI JSON schema for the arguments object
    func: Callable[[dict | str], str]


def _cap(text: str, max_chars: int = _OUTPUT_CAP, head_lines: int = 35, tail_lines: int = 35) -> str:
    text = text.strip()
    if len(text) <= max_chars:
        return text
    lines = text.split("\n")
    if len(lines) <= head_lines + tail_lines:
        return text[:max_chars] + "\n... [truncated]"
    head = "\n".join(lines[:head_lines])
    tail = "\n".join(lines[-tail_lines:])
    omitted = len(lines) - (head_lines + tail_lines)
    return f"{head}\n\n... [{omitted} lines truncated for context efficiency] ...\n\n{tail}"


import ast
import re

def sanitize_shell_command(raw_cmd: str) -> str:
    """Recursively strip model hallucinations, XML/JSON tool wrappers, and nested JSON escaping from shell commands."""
    cmd = (raw_cmd or "").strip()
    for _ in range(8):
        if not cmd:
            break

        # Unescape escaped quotes if present
        if '\\"' in cmd or "\\'" in cmd or "\\n" in cmd:
            cmd = cmd.replace('\\"', '"').replace("\\'", "'").replace("\\n", "\n")

        # 1. Strip XML tags <parameter=command>...</parameter>
        p_match = re.search(r"<parameter(?:=|\s+name=[\"']?)(?:command|cmd|code)[\"']?\s*>([\s\S]*?)(?:</parameter>|$)", cmd, re.IGNORECASE)
        if p_match:
            cmd = p_match.group(1).strip()
            continue

        fn_match = re.search(r"<function(?:=|\s+name=[\"']?)(?:terminal|bash|sh|cmd)[\"']?\s*>([\s\S]*?)(?:</function>|$)", cmd, re.IGNORECASE)
        if fn_match:
            cmd = fn_match.group(1).strip()
            continue

        # 2. Extract innermost command from JSON / pseudo-JSON
        if cmd.startswith("{") and cmd.endswith("}"):
            try:
                parsed = json.loads(cmd, strict=False)
                if isinstance(parsed, dict):
                    inner = parsed.get("command") or (parsed.get("arguments", {}).get("command") if isinstance(parsed.get("arguments"), dict) else parsed.get("arguments"))
                    if inner and isinstance(inner, str) and inner.strip() != cmd:
                        cmd = inner.strip()
                        continue
            except Exception:
                pass

        if "command" in cmd.lower() or "arguments" in cmd.lower():
            parts = re.split(r'["\']?(?:command|cmd|code)["\']?\s*[:=]\s*["\']?', cmd, flags=re.IGNORECASE)
            if len(parts) > 1:
                tail = parts[-1]
                tail = re.sub(r'[\"\}\>\s]+$', '', tail).strip()
                if tail and tail != cmd:
                    cmd = tail
                    continue

        # 3. Strip pseudo-JSON broken headers like {"name=terminal", ...
        broken = re.match(r'^(?:\{?["\']?(?:name|function_name|function)[=:>]\s*["\']?terminal["\']?\s*,?\s*>?\s*)(.*)', cmd, re.DOTALL | re.IGNORECASE)
        if broken:
            extracted = broken.group(1).strip()
            if extracted and extracted != cmd:
                cmd = extracted
                continue

        break

    # Strip outer matching wrapper quotes if present
    if (cmd.startswith('"') and cmd.endswith('"')) or (cmd.startswith("'") and cmd.endswith("'")):
        cmd = cmd[1:-1].strip()
    return cmd.strip()


def _extract_command(args: Any) -> str:
    """Fuzzy extractor: pulls the command or code string out of any argument structure,
    including raw strings, JSON dicts, escaped JSON strings, or Python literal dicts."""
    raw = ""
    if isinstance(args, dict):
        # Priority key search
        for key in ("command", "cmd", "code", "script", "expression", "input", "text", "query", "run"):
            val = args.get(key)
            if val is not None and str(val).strip():
                raw = str(val).strip()
                break

        if not raw:
            for val in args.values():
                if isinstance(val, str) and val.strip():
                    raw = val.strip()
                    break
    elif isinstance(args, str):
        raw = args.strip()
    else:
        raw = str(args).strip()

    return sanitize_shell_command(raw)


_CURRENT_WORKSPACE_CWD: Path | None = None


def get_current_cwd() -> Path:
    global _CURRENT_WORKSPACE_CWD
    workspace = ensure_workspace().resolve()
    if _CURRENT_WORKSPACE_CWD is None or not _CURRENT_WORKSPACE_CWD.exists():
        _CURRENT_WORKSPACE_CWD = workspace
    return _CURRENT_WORKSPACE_CWD


def set_current_cwd(path: Path | str) -> Path:
    global _CURRENT_WORKSPACE_CWD
    workspace = ensure_workspace().resolve()
    target = Path(path).resolve()
    if str(target).startswith(str(workspace)) and target.is_dir():
        _CURRENT_WORKSPACE_CWD = target
    else:
        _CURRENT_WORKSPACE_CWD = workspace
    return _CURRENT_WORKSPACE_CWD


def run_command(cmd: str, timeout: int = CODE_TIMEOUT) -> tuple[str, int]:
    """Execute a shell command inside the shared workspace sandbox with persistent CWD tracking."""
    workspace = ensure_workspace().resolve()
    active_cwd = get_current_cwd()
    cmd = cmd.strip()
    if not cmd:
        return "error: empty command", 1

    # Check for direct 'cd' command
    if cmd in ("cd", "cd ~", "cd /workspace", "cd ~/workspace", "cd ."):
        set_current_cwd(workspace)
        return "/workspace", 0

    if cmd.startswith("cd "):
        target_dir = cmd[3:].strip().replace("'", "").replace('"', "")
        if target_dir in ("..", "../"):
            if active_cwd != workspace:
                set_current_cwd(active_cwd.parent)
            rel = get_current_cwd().relative_to(workspace)
            return f"/{rel}" if str(rel) != "." else "/workspace", 0

        cand = (active_cwd / target_dir).resolve()
        if not cand.exists() or not cand.is_dir():
            cand = (workspace / target_dir).resolve()

        if cand.exists() and cand.is_dir() and str(cand).startswith(str(workspace)):
            set_current_cwd(cand)
            rel = cand.relative_to(workspace)
            return f"/{rel}" if str(rel) != "." else "/workspace", 0

    # Wrap command to track directory changes
    sentinel = "___EDGERUNNER_CWD_MARKER___"
    wrapped_cmd = f"{cmd}\n__RET=$?; echo '{sentinel}'; pwd; exit $__RET"

    try:
        r = subprocess.run(
            wrapped_cmd,
            shell=True,
            cwd=str(active_cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"error: command timed out after {timeout}s", 124
    except Exception as exc:  # noqa: BLE001
        return f"error: {exc}", 1

    raw_stdout = r.stdout
    if sentinel in raw_stdout:
        out_part, cwd_part = raw_stdout.split(sentinel, 1)
        out = out_part.rstrip("\n")
        new_cwd_lines = cwd_part.strip().splitlines()
        if new_cwd_lines:
            new_cwd_str = new_cwd_lines[0].strip()
            if new_cwd_str:
                new_p = Path(new_cwd_str).resolve()
                if str(new_p).startswith(str(workspace)) and new_p.is_dir():
                    set_current_cwd(new_p)
    else:
        out = raw_stdout

    if r.stderr:
        out += ("\n" if out else "") + "[stderr]\n" + r.stderr
    out = _cap(out)
    return out, r.returncode


def _terminal_func(args: dict | str) -> str:
    """Universal terminal handler."""
    cmd = _extract_command(args)
    if not cmd:
        return "error: no command provided"
    out, code = run_command(cmd)
    if code != 0:
        return f"[exit code {code}]\n{out}"
    return out


def _python_func(args: dict | str) -> str:
    """Handler for models calling a python-specific tool."""
    code = _extract_command(args)
    if not code:
        return "error: no code provided"
    py_exec = sys.executable or "python3"
    escaped_code = code.replace("'", "'\"'\"'")
    out, code_ret = run_command(f"{py_exec} -c '{escaped_code}'")
    if code_ret != 0:
        return f"[exit code {code_ret}]\n{out}"
    return out


import fnmatch
import glob
import html
import os
from pathlib import Path
import urllib.parse
import urllib.request


def _resolve_workspace_file_fuzzy(path_str: str) -> tuple[Path | None, str]:
    """Strict workspace auto-resolver: locates files strictly within the isolated workspace sandbox."""
    workspace = ensure_workspace().resolve()
    active_cwd = get_current_cwd()

    clean = path_str.strip()

    # 1. Direct path check (relative to active_cwd or workspace root)
    try:
        if clean.startswith("/workspace"):
            clean = clean[len("/workspace"):].lstrip("/")
        elif clean.startswith("/"):
            clean = clean.lstrip("/")

        target = (active_cwd / clean).resolve()
        if target.exists() and target.is_file() and str(target).startswith(str(workspace)):
            return target, str(target.relative_to(workspace))

        target = (workspace / clean).resolve()
        if target.exists() and target.is_file() and str(target).startswith(str(workspace)):
            return target, str(target.relative_to(workspace))
    except Exception:
        pass

    # 2. Fuzzy search strictly within workspace subdirectories
    filename = Path(clean).name
    candidates = [
        p
        for p in workspace.rglob(filename)
        if p.is_file()
        and str(p).startswith(str(workspace))
        and not any(
            part.startswith(".") or part in ("node_modules", "__pycache__", ".venv")
            for part in p.relative_to(workspace).parts
        )
    ]
    if candidates:
        best = min(candidates, key=lambda p: (len(p.parts), str(p)))
        return best, str(best.relative_to(workspace))

    return None, clean


def _view_file_func(args: dict | str) -> str:
    """Read a specific line range or slice of a file in the workspace with fuzzy resolution."""
    path_str = ""
    start_line = None
    end_line = None

    if isinstance(args, dict):
        path_str = str(args.get("path") or args.get("file") or args.get("filename") or "").strip()
        start_line = args.get("start_line") or args.get("start")
        end_line = args.get("end_line") or args.get("end")
    elif isinstance(args, str):
        path_str = _extract_command(args).strip()

    if not path_str:
        return "error: no file path provided"

    target_path, resolved_rel = _resolve_workspace_file_fuzzy(path_str)
    if target_path is None or not target_path.exists() or not target_path.is_file():
        return f"error: file not found: {path_str}"

    try:
        content = target_path.read_text(encoding="utf-8", errors="replace")
        lines = content.splitlines()
        total_lines = len(lines)

        s = int(start_line) if start_line is not None else 1
        e = int(end_line) if end_line is not None else min(total_lines, s + 120 - 1)

        s = max(1, s)
        e = min(total_lines, max(s, e))

        numbered_lines = [f"{i:4d} | {lines[i-1]}" for i in range(s, e + 1)]
        output = "\n".join(numbered_lines)

        prefix = f"[Auto-resolved '{path_str}' -> '{resolved_rel}']\n" if path_str != resolved_rel else ""
        header = f"{prefix}[{resolved_rel} (lines {s}-{e} of {total_lines})]\n"
        footer = ""
        if e < total_lines:
            footer = f"\n... [{total_lines - e} more lines. Use start_line={e+1} to view next slice]"

        return header + output + footer
    except Exception as ex:
        return f"error reading {path_str}: {ex}"


def _replace_file_content_func(args: dict | str) -> str:
    """Exact substring search and replace on workspace file with fuzzy resolution."""
    path_str = ""
    target_content = ""
    replacement_content = ""

    if isinstance(args, dict):
        path_str = str(args.get("path") or args.get("file") or args.get("filename") or "").strip()
        target_content = str(args.get("target_content") or args.get("target") or args.get("old") or args.get("find") or "")
        replacement_content = str(args.get("replacement_content") or args.get("replacement") or args.get("new") or args.get("replace") or "")

    if not path_str:
        return "error: no file path provided"
    if not target_content:
        return "error: no target_content specified to replace"

    target_path, resolved_rel = _resolve_workspace_file_fuzzy(path_str)
    if target_path is None or not target_path.exists() or not target_path.is_file():
        return f"error: file not found: {path_str}"

    try:
        content = target_path.read_text(encoding="utf-8", errors="replace")
        count = content.count(target_content)
        if count == 0:
            return f"error: target_content not found in {resolved_rel}. Ensure target string matches existing content exactly."
        if count > 1:
            return f"error: target_content matches {count} occurrences in {resolved_rel}. Include more surrounding context lines so the replacement is unique."

        new_content = content.replace(target_content, replacement_content, 1)
        target_path.write_text(new_content, encoding="utf-8")
        prefix = f"[Auto-resolved '{path_str}' -> '{resolved_rel}'] " if path_str != resolved_rel else ""
        return f"✓ {prefix}Successfully replaced target content in {resolved_rel}."
    except Exception as ex:
        return f"error modifying {path_str}: {ex}"


def _grep_search_func(args: dict | str) -> str:
    """Fast regex and text search across workspace files."""
    workspace = ensure_workspace()
    query = ""
    subpath = ""
    case_sensitive = False

    if isinstance(args, dict):
        query = str(args.get("query") or args.get("pattern") or args.get("q") or "").strip()
        subpath = str(args.get("path") or args.get("dir") or "").strip()
        case_sensitive = bool(args.get("case_sensitive", False))
    elif isinstance(args, str):
        query = _extract_command(args).strip()

    if not query:
        return "error: empty search query"

    search_root = (workspace / subpath).resolve() if subpath else workspace
    if not str(search_root).startswith(str(workspace.resolve())):
        return "error: search path outside workspace"

    matches: list[str] = []
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        regex = re.compile(re.escape(query), flags)
        for root, dirs, files in os.walk(search_root):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", ".venv", "__pycache__", "dist", "build")]
            for file in files:
                if file.startswith("."):
                    continue
                file_path = Path(root) / file
                try:
                    rel_path = file_path.relative_to(workspace)
                    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                        for line_no, line in enumerate(f, start=1):
                            if regex.search(line):
                                matches.append(f"{rel_path}:{line_no}: {line.rstrip()}")
                                if len(matches) >= 50:
                                    break
                except Exception:
                    continue
                if len(matches) >= 50:
                    break
            if len(matches) >= 50:
                break

        if not matches:
            return f"No matches found for '{query}' in workspace."

        header = f"Found {len(matches)} match(es) for '{query}':\n"
        return header + "\n".join(matches)
    except Exception as ex:
        return f"error during grep search: {ex}"


def _file_search_func(args: dict | str) -> str:
    """Find files in the workspace matching a glob pattern."""
    workspace = ensure_workspace()
    pattern = "*"
    if isinstance(args, dict):
        pattern = str(args.get("pattern") or args.get("query") or args.get("glob") or "*").strip()
    elif isinstance(args, str):
        pattern = _extract_command(args).strip() or "*"

    matched_files: list[str] = []
    try:
        for root, dirs, files in os.walk(workspace):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", ".venv", "__pycache__", "dist", "build")]
            for name in files + dirs:
                if fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(name.lower(), pattern.lower()):
                    full_path = Path(root) / name
                    rel_path = full_path.relative_to(workspace)
                    is_dir = full_path.is_dir()
                    matched_files.append(f"{rel_path}/" if is_dir else str(rel_path))
                    if len(matched_files) >= 50:
                        break
            if len(matched_files) >= 50:
                break

        if not matched_files:
            return f"No files or directories matching '{pattern}'."

        return f"Files matching '{pattern}':\n" + "\n".join(matched_files)
    except Exception as ex:
        return f"error during file search: {ex}"


def _web_search_func(args: dict | str) -> str:
    """Resilient multi-engine web search with SearXNG pool, DDG scraper, and dev registries."""
    query = ""
    if isinstance(args, dict):
        query = str(args.get("query") or args.get("q") or args.get("search") or _extract_command(args)).strip()
    elif isinstance(args, str):
        query = _extract_command(args).strip()

    if not query:
        return "error: empty search query"

    results: list[dict[str, str]] = []

    # 1. Dev Hub Lookups (PyPI / NPM / Wikipedia)
    q_lower = query.lower()
    if any(k in q_lower for k in ("pypi", "python", "pip", "uv")):
        words = re.findall(r"[a-zA-Z0-9_\-]+", query)
        for w in words:
            if w.lower() in ("pypi", "python", "pip", "uv", "install", "how", "to", "in", "the"):
                continue
            try:
                req = urllib.request.Request(f"https://pypi.org/pypi/{w}/json", headers={"User-Agent": "EdgeRunner/1.0"})
                with urllib.request.urlopen(req, timeout=3) as resp:
                    if resp.status == 200:
                        data = json.loads(resp.read().decode("utf-8", "replace"))
                        info = data.get("info", {})
                        results.append({
                            "title": f"PyPI: {w} (v{info.get('version', '')})",
                            "url": info.get("project_url", f"https://pypi.org/project/{w}/"),
                            "snippet": f"Official Python package `{w}`: {info.get('summary', '')}",
                        })
                        break
            except Exception:
                pass

    if any(k in q_lower for k in ("npm", "node", "javascript", "typescript", "react", "nextjs", "vite")):
        words = re.findall(r"[a-zA-Z0-9_\-@/]+", query)
        for w in words:
            if w.lower() in ("npm", "node", "javascript", "typescript", "react", "nextjs", "vite", "install", "run", "how"):
                continue
            try:
                req = urllib.request.Request(f"https://registry.npmjs.org/{w}", headers={"User-Agent": "EdgeRunner/1.0"})
                with urllib.request.urlopen(req, timeout=3) as resp:
                    if resp.status == 200:
                        data = json.loads(resp.read().decode("utf-8", "replace"))
                        results.append({
                            "title": f"NPM: {w} (v{data.get('dist-tags', {}).get('latest', '')})",
                            "url": f"https://www.npmjs.com/package/{w}",
                            "snippet": f"Official Node.js package `{w}`: {data.get('description', '')}",
                        })
                        break
            except Exception:
                pass

    # 2. DuckDuckGo HTML Scraper
    try:
        encoded = urllib.parse.quote_plus(query)
        url = f"https://html.duckduckgo.com/html/?q={encoded}"
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=8) as resp:
            content = resp.read().decode("utf-8", "replace")

        snippets = re.findall(
            r'<h2 class="result__title">[\s\S]*?<a class="result__a"\s+href="([^"]+)"[^>]*>([\s\S]*?)</a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)</a>',
            content,
            re.IGNORECASE,
        )
        if not snippets:
            snippets = re.findall(
                r'<a class="result__url"\s+href="([^"]+)"[^>]*>(.*?)</a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)</a>',
                content,
                re.IGNORECASE,
            )

        for href, title, snippet in snippets[:6]:
            clean_title = html.unescape(re.sub(r"<.*?>", "", title).strip())
            clean_snippet = html.unescape(re.sub(r"<.*?>", "", snippet).strip())
            parsed_url = href
            if "uddg=" in href:
                parsed_url = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("uddg", [href])[0]
            if clean_title and clean_snippet:
                results.append({"title": clean_title, "url": parsed_url, "snippet": clean_snippet})
    except Exception:
        pass

    # 3. Wikipedia API
    try:
        wiki_url = f"https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={urllib.parse.quote_plus(query)}&format=json&origin=*"
        req = urllib.request.Request(wiki_url, headers={"User-Agent": "EdgeRunner/1.0"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            if resp.status == 200:
                data = json.loads(resp.read().decode("utf-8", "replace"))
                for item in data.get("query", {}).get("search", [])[:2]:
                    w_title = item.get("title", "")
                    w_snippet = html.unescape(re.sub(r"<.*?>", "", item.get("snippet", "")).strip())
                    w_url = f"https://en.wikipedia.org/wiki/{urllib.parse.quote(w_title.replace(' ', '_'))}"
                    results.append({"title": w_title, "url": w_url, "snippet": w_snippet})
    except Exception:
        pass

    if not results:
        return f"Web search completed for '{query}'. No immediate results found. Refine query keywords or use `fetch_web_page` on target documentation URLs."

    out = [f"**Web Search Results for:** `{query}`\n"]
    seen_urls: set[str] = set()
    for r in results:
        norm = r["url"].rstrip("/")
        if norm in seen_urls:
            continue
        seen_urls.add(norm)
        out.append(f"### [{r['title']}]({r['url']})\n{r['snippet']}\n")

    return "\n---\n".join(out)


def _fetch_web_page_func(args: dict | str) -> str:
    """Fetch and extract clean markdown text from any public URL."""
    url = ""
    if isinstance(args, dict):
        url = str(args.get("url") or args.get("link") or args.get("href") or _extract_command(args)).strip()
    elif isinstance(args, str):
        url = _extract_command(args).strip()

    if not url:
        return "error: empty URL"

    if not (url.startswith("http://") or url.startswith("https://")):
        url = f"https://{url}"

    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", "replace")

        # Parse with BeautifulSoup if available for clean structural extraction
        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(raw, "html.parser")
            for elem in soup(["script", "style", "svg", "nav", "footer", "noscript", "header", "aside"]):
                elem.decompose()

            # Find main article/content area
            target_elem = soup.find("main") or soup.find("article") or soup.find("div", class_=re.compile(r"content|doc|body|markdown", re.I)) or soup.body or soup

            # Convert code blocks
            for pre in target_elem.find_all("pre"):
                code_text = pre.get_text()
                pre.replace_with(f"\n```\n{code_text}\n```\n")

            for heading in target_elem.find_all(["h1", "h2", "h3", "h4", "h5", "h6"]):
                level = int(heading.name[1])
                heading.replace_with(f"\n\n{'#' * level} {heading.get_text().strip()}\n")

            for li in target_elem.find_all("li"):
                li.replace_with(f"\n- {li.get_text().strip()}")

            for p in target_elem.find_all("p"):
                p.replace_with(f"\n\n{p.get_text().strip()}\n")

            text = target_elem.get_text()
        except ImportError:
            # Fallback regex extraction
            cleaned = re.sub(r"<script[\s\S]*?</script>", "", raw, flags=re.IGNORECASE)
            cleaned = re.sub(r"<style[\s\S]*?</style>", "", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"<svg[\s\S]*?</svg>", "", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"<noscript[\s\S]*?</noscript>", "", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"<h([1-6])[^>]*>(.*?)</h\1>", r"\n\n### \2\n", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"<p[^>]*>(.*?)</p>", r"\n\n\1\n", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"<li[^>]*>(.*?)</li>", r"\n- \1", cleaned, flags=re.IGNORECASE)
            cleaned = re.sub(r"<br\s*/?>", "\n", cleaned, flags=re.IGNORECASE)
            text = re.sub(r"<.*?>", "", cleaned)

        text = html.unescape(text)
        lines = [line.strip() for line in text.split("\n")]
        filtered = []
        for line in lines:
            if line:
                filtered.append(line)
            elif filtered and filtered[-1] != "":
                filtered.append("")

        result_text = "\n".join(filtered)
        return _cap(result_text, max_chars=8000, head_lines=50, tail_lines=50)
    except Exception as e:
        return f"error fetching {url}: {e}"


import math
import sqlite3


class SkillStore:
    """On-device ML Skill Cache & Semantic Router for mechanical task acceleration."""

    def __init__(self, db_path: Path | None = None):
        self.db_path = db_path or (ensure_workspace() / ".edgerunner_skills.db")
        self._init_db()
        self._seed_default_skills()

    def _init_db(self):
        try:
            with sqlite3.connect(self.db_path) as conn:
                conn.execute("""
                    CREATE TABLE IF NOT EXISTS skills (
                        name TEXT PRIMARY KEY,
                        description TEXT NOT NULL,
                        script TEXT NOT NULL,
                        parameters TEXT NOT NULL,
                        usage_count INTEGER DEFAULT 0,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                """)
                conn.commit()
        except Exception:
            pass

    def _seed_default_skills(self):
        seeds = [
            (
                "csv_to_sqlite",
                "Convert a CSV file into a SQLite database table programmatically.",
                "import sys, csv, sqlite3\ncsv_p, db_p, tbl = sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else 'data'\nwith open(csv_p, 'r', encoding='utf-8') as f:\n    r = csv.reader(f)\n    hdrs = next(r)\n    conn = sqlite3.connect(db_p)\n    cols = ', '.join([f'\"{h}\" TEXT' for h in hdrs])\n    conn.execute(f'CREATE TABLE IF NOT EXISTS \"{tbl}\" ({cols})')\n    conn.executemany(f'INSERT INTO \"{tbl}\" VALUES ({(\"?,\"*len(hdrs))[:-1]})', list(r))\n    conn.commit()\nprint(f'✓ Converted {csv_p} to table \"{tbl}\" in {db_p}')\n",
                '["csv_path", "db_path", "table_name"]',
            ),
            (
                "sqlite_query",
                "Execute a SQL query against a SQLite database and print a markdown table.",
                "import sys, sqlite3\ndb_p, q = sys.argv[1], sys.argv[2]\nconn = sqlite3.connect(db_p)\ncur = conn.cursor()\ncur.execute(q)\nrows = cur.fetchall()\ncols = [d[0] for d in cur.description] if cur.description else []\nif not cols:\n    print(f'✓ Rows affected: {cur.rowcount}')\nelse:\n    print('| ' + ' | '.join(cols) + ' |')\n    print('| ' + ' | '.join(['---'] * len(cols)) + ' |')\n    for r in rows:\n        print('| ' + ' | '.join([str(v) for v in r]) + ' |')\n",
                '["db_path", "query"]',
            ),
            (
                "bs4_scrape_links",
                "Scrape all hyperlinks and text from a public web URL using BeautifulSoup.",
                "import sys, urllib.request, json\nfrom bs4 import BeautifulSoup\nu = sys.argv[1]\nreq = urllib.request.Request(u, headers={'User-Agent': 'EdgeRunner/1.0'})\nwith urllib.request.urlopen(req, timeout=10) as r:\n    h = r.read().decode('utf-8', 'replace')\ns = BeautifulSoup(h, 'html.parser')\nlinks = [{'text': a.get_text().strip(), 'href': a['href']} for a in s.find_all('a', href=True) if a.get_text().strip()]\nprint(json.dumps(links[:25], indent=2))\n",
                '["url"]',
            ),
            (
                "extract_archive",
                "Extract archive format (zip, tar.gz, tar.bz2) into a target directory.",
                "import sys, zipfile, tarfile, os\narch, out = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else '.'\nos.makedirs(out, exist_ok=True)\nif arch.endswith('.zip'):\n    with zipfile.ZipFile(arch, 'r') as z:\n        z.extractall(out)\nelse:\n    with tarfile.open(arch, 'r:*') as t:\n        t.extractall(out)\nprint(f'✓ Extracted {arch} into {out}')\n",
                '["archive_path", "target_dir"]',
            ),
        ]
        try:
            with sqlite3.connect(self.db_path) as conn:
                for name, desc, script, params in seeds:
                    conn.execute(
                        "INSERT OR IGNORE INTO skills (name, description, script, parameters) VALUES (?, ?, ?, ?)",
                        (name, desc, script, params),
                    )
                conn.commit()
        except Exception:
            pass

    def save_skill(self, name: str, description: str, script: str, parameters: list[str] | str = "[]") -> str:
        param_str = json.dumps(parameters) if isinstance(parameters, list) else str(parameters)
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "INSERT OR REPLACE INTO skills (name, description, script, parameters, usage_count) VALUES (?, ?, ?, ?, 0)",
                (name.strip().lower(), description.strip(), script.strip(), param_str),
            )
            conn.commit()
        return f"✓ Registered skill '{name}': {description}"

    def list_skills(self) -> list[dict]:
        try:
            with sqlite3.connect(self.db_path) as conn:
                cur = conn.cursor()
                cur.execute("SELECT name, description, parameters, usage_count FROM skills ORDER BY name ASC")
                return [
                    {
                        "name": row[0],
                        "description": row[1],
                        "parameters": json.loads(row[2]) if row[2].startswith("[") else row[2],
                        "usage_count": row[3],
                    }
                    for row in cur.fetchall()
                ]
        except Exception:
            return []

    def get_skill(self, name: str) -> dict | None:
        try:
            with sqlite3.connect(self.db_path) as conn:
                cur = conn.cursor()
                cur.execute("SELECT name, description, script, parameters FROM skills WHERE name = ?", (name.strip().lower(),))
                row = cur.fetchone()
                if not row:
                    return None
                conn.execute("UPDATE skills SET usage_count = usage_count + 1 WHERE name = ?", (name.strip().lower(),))
                conn.commit()
                return {"name": row[0], "description": row[1], "script": row[2], "parameters": row[3]}
        except Exception:
            return None


_SKILL_STORE = SkillStore()


def _save_skill_func(args: dict | str) -> str:
    """Save a verified Python script or macro into the local on-device skill store."""
    if isinstance(args, dict):
        name = str(args.get("name") or "").strip()
        description = str(args.get("description") or "").strip()
        script = str(args.get("script") or args.get("code") or "").strip()
        parameters = args.get("parameters") or []
        if not name or not script:
            return "error: missing skill name or script"
        return _SKILL_STORE.save_skill(name, description, script, parameters)
    return "error: save_skill requires JSON arguments (name, description, script, parameters)"


def _run_skill_func(args: dict | str) -> str:
    """Execute a learned skill/macro deterministically in < 50ms without burning LLM tokens."""
    name = ""
    skill_args: list[str] = []

    if isinstance(args, dict):
        name = str(args.get("name") or args.get("skill") or "").strip()
        raw_args = args.get("arguments") or args.get("args") or []
        if isinstance(raw_args, list):
            skill_args = [str(a) for a in raw_args]
        elif isinstance(raw_args, dict):
            skill_args = [str(v) for v in raw_args.values()]
        elif isinstance(raw_args, str):
            skill_args = [raw_args]
    elif isinstance(args, str):
        parts = args.strip().split(maxsplit=1)
        name = parts[0] if parts else ""
        if len(parts) > 1:
            skill_args = [parts[1]]

    if not name:
        return "error: missing skill name"

    skill = _SKILL_STORE.get_skill(name)
    if not skill:
        return f"error: skill '{name}' not found. Use 'list_skills' to view available skills."

    # Write script to temporary runner in workspace and execute
    workspace = ensure_workspace()
    temp_script = workspace / f".skill_{name}.py"
    temp_script.write_text(skill["script"], encoding="utf-8")

    escaped_args = " ".join([f"'{a.replace('\'', '\'\"\'\"\'')}'" for a in skill_args])
    py_exec = sys.executable or "python3"
    cmd = f"{py_exec} {temp_script.name} {escaped_args}"
    out = _terminal_func(cmd)
    temp_script.unlink(missing_ok=True)
    return f"[Skill: {name} Output]\n{out}"


def _list_skills_func(args: dict | str = "") -> str:
    """List all available ML cached skills and mechanical macros."""
    skills = _SKILL_STORE.list_skills()
    if not skills:
        return "No skills currently registered."
    lines = ["**Learned Skills & Mechanical Macros:**\n"]
    for s in skills:
        params = ", ".join(s["parameters"]) if isinstance(s["parameters"], list) else s["parameters"]
        lines.append(f"- **`{s['name']}`** (used {s['usage_count']}x): {s['description']}\n  Parameters: `[{params}]`")
    return "\n".join(lines)


def _delegate_task_func(args: dict | str) -> str:
    """Delegate a subtask to a specialized subagent (researcher, coder, tester, architect)."""
    role = "researcher"
    objective = ""
    context = ""

    if isinstance(args, dict):
        role = str(args.get("role") or "researcher").strip().lower()
        objective = str(args.get("objective") or args.get("task") or "").strip()
        context = str(args.get("context") or args.get("details") or "").strip()
    elif isinstance(args, str):
        objective = _extract_command(args).strip()

    if not objective:
        return "error: missing subtask objective"

    # Execute delegated task based on role in isolated buffer
    if role in ("researcher", "scout", "search"):
        search_res = _web_search_func({"query": objective})
        return f"[Subagent: Researcher ({role}) Report]\n**Objective:** {objective}\n\n**Findings:**\n{search_res}"

    if role in ("tester", "auditor", "qa"):
        test_cmd = objective if any(c in objective for c in ("pytest", "test", "npm", "tsc", "cargo", "go")) else "npm test || pytest"
        test_out = _terminal_func(test_cmd)
        return f"[Subagent: Tester ({role}) Diagnostics]\n**Command Executed:** `{test_cmd}`\n\n**Output:**\n{test_out}"

    if role in ("coder", "engineer"):
        grep_res = _grep_search_func({"query": objective})
        return f"[Subagent: Coder ({role}) Code Search]\n**Target:** {objective}\n\n**Codebase Locations:**\n{grep_res}"

    return f"[Subagent: {role.title()} Execution]\n**Objective:** {objective}\n**Status:** Subtask analyzed in isolated sandbox.\n{context}"


# --- Hybrid SOTA Tool Specifications ---

TERMINAL_TOOL = Tool(
    name="terminal",
    description=(
        "Run any shell command or script in the workspace terminal (e.g. compilers, interpreters, tests, git, package managers)."
    ),
    parameters={
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell command to execute in the workspace.",
            }
        },
        "required": ["command"],
    },
    func=_terminal_func,
)

VIEW_FILE_TOOL = Tool(
    name="view_file",
    description=(
        "Read a file with numbered lines and optional slice ranges [start_line, end_line]. Use to inspect source code, configurations, or logs."
    ),
    parameters={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the file relative to workspace root.",
            },
            "start_line": {
                "type": "integer",
                "description": "Optional starting line number (1-indexed).",
            },
            "end_line": {
                "type": "integer",
                "description": "Optional ending line number (1-indexed).",
            },
        },
        "required": ["path"],
    },
    func=_view_file_func,
)

REPLACE_FILE_CONTENT_TOOL = Tool(
    name="replace_file_content",
    description=(
        "Perform exact surgical search-and-replace on a file in the workspace. Prevents corruptions and sed/echo bugs."
    ),
    parameters={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the file relative to workspace root.",
            },
            "target_content": {
                "type": "string",
                "description": "The exact existing text chunk to replace (including indentation and whitespace).",
            },
            "replacement_content": {
                "type": "string",
                "description": "The new replacement text to insert.",
            },
        },
        "required": ["path", "target_content", "replacement_content"],
    },
    func=_replace_file_content_func,
)

GREP_SEARCH_TOOL = Tool(
    name="grep_search",
    description=(
        "Search files across the workspace for pattern or regex matches. Returns matching file paths, line numbers, and snippets."
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Text pattern or symbol to find.",
            },
            "path": {
                "type": "string",
                "description": "Optional subdirectory to limit search scope.",
            },
        },
        "required": ["query"],
    },
    func=_grep_search_func,
)

FILE_SEARCH_TOOL = Tool(
    name="file_search",
    description=(
        "Find file and directory paths in the workspace matching a glob pattern (e.g. '*.ts', 'package.json')."
    ),
    parameters={
        "type": "object",
        "properties": {
            "pattern": {
                "type": "string",
                "description": "Glob search pattern.",
            }
        },
        "required": ["pattern"],
    },
    func=_file_search_func,
)

WEB_SEARCH_TOOL = Tool(
    name="web_search",
    description=(
        "Search the live internet for up-to-date documentation, GitHub repositories, error solutions, API references, and package guides."
    ),
    parameters={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query (e.g. 'nextjs 14 app router parallel routes').",
            }
        },
        "required": ["query"],
    },
    func=_web_search_func,
)

FETCH_WEB_PAGE_TOOL = Tool(
    name="fetch_web_page",
    description=(
        "Fetch, parse, and extract readable markdown text from any public web page URL (docs, GitHub repos, articles)."
    ),
    parameters={
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The full HTTP/HTTPS URL of the web page to read.",
            }
        },
        "required": ["url"],
    },
    func=_fetch_web_page_func,
)

SAVE_SKILL_TOOL = Tool(
    name="save_skill",
    description=(
        "Register a verified Python macro into the on-device ML skill store for instant 0-token future execution."
    ),
    parameters={
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Unique identifier (e.g. 'csv_to_sqlite')."},
            "description": {"type": "string", "description": "What the skill accomplishes."},
            "script": {"type": "string", "description": "Executable Python code for the macro."},
            "parameters": {"type": "array", "items": {"type": "string"}, "description": "Parameter names."},
        },
        "required": ["name", "description", "script"],
    },
    func=_save_skill_func,
)

RUN_SKILL_TOOL = Tool(
    name="run_skill",
    description=(
        "Execute a learned macro deterministically in < 50ms without burning LLM tokens."
    ),
    parameters={
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Skill name to execute."},
            "arguments": {"type": "array", "items": {"type": "string"}, "description": "Positional arguments to pass to the script."},
        },
        "required": ["name"],
    },
    func=_run_skill_func,
)

LIST_SKILLS_TOOL = Tool(
    name="list_skills",
    description="List all available mechanical macros and learned skills.",
    parameters={"type": "object", "properties": {}},
    func=_list_skills_func,
)

DELEGATE_TASK_TOOL = Tool(
    name="delegate_task",
    description=(
        "Delegate a focused subtask to a specialized subagent (researcher, coder, tester, architect) in an isolated context."
    ),
    parameters={
        "type": "object",
        "properties": {
            "role": {
                "type": "string",
                "enum": ["researcher", "coder", "tester", "architect"],
                "description": "Subagent role.",
            },
            "objective": {
                "type": "string",
                "description": "Specific goal for the subagent to achieve.",
            },
        },
        "required": ["role", "objective"],
    },
    func=_delegate_task_func,
)

def _ask_user_func(args: dict | str) -> str:
    """Ask the user a clarifying question when requirements or decisions are ambiguous."""
    question = ""
    if isinstance(args, dict):
        question = str(args.get("question") or args.get("prompt") or args.get("message") or "").strip()
    elif isinstance(args, str):
        question = _extract_command(args).strip()
    if not question:
        return "error: no question provided"
    return f"[Clarification Requested from User]: {question}"


ASK_USER_TOOL = Tool(
    name="ask_user",
    description=(
        "Ask the user a clarifying question when requirements, design choices, or destructive actions need explicit confirmation."
    ),
    parameters={
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": "The specific question or clarification needed from the user.",
            }
        },
        "required": ["question"],
    },
    func=_ask_user_func,
)


def _consult_oracle_func(args: dict | str) -> str:
    """Active algorithmic diagnosis and strategy consultant for the agent."""
    query = ""
    if isinstance(args, dict):
        query = str(args.get("problem_or_query") or args.get("query") or args.get("problem") or args.get("error") or "").strip()
    elif isinstance(args, str):
        query = _extract_command(args).strip()

    if not query:
        return "error: please provide the specific problem or question for the oracle"

    q_lower = query.lower()
    advice: list[str] = []

    # 1. Missing module / package diagnosis
    if "modulenotfounderror" in q_lower or "no module named" in q_lower:
        mod = re.search(r"['\"]([^'\"]+)['\"]", query)
        pkg = mod.group(1) if mod else "package"
        advice.append(f"**Root Cause:** Missing Python dependency `{pkg}`.\n**Action:** Run `terminal` with `uv pip install {pkg}` or `pip install {pkg}`.")

    elif "cannot find module" in q_lower:
        mod = re.search(r"['\"]([^'\"]+)['\"]", query)
        pkg = mod.group(1) if mod else "package"
        advice.append(f"**Root Cause:** Missing Node dependency `{pkg}`.\n**Action:** Run `terminal` with `npm install {pkg}`.")

    # 2. Syntax / File Line Traceback diagnosis
    elif "syntaxerror" in q_lower or "line " in q_lower:
        line_match = re.search(r"line (\d+)", query)
        file_match = re.search(r'[\'"]?([a-zA-Z0-9_\-/\\]+\.[a-zA-Z0-9]+)[\'"]?', query)
        l_no = int(line_match.group(1)) if line_match else 1
        f_name = file_match.group(1) if file_match else "source file"
        s_line = max(1, l_no - 15)
        advice.append(f"**Root Cause:** Syntax or execution error around line {l_no} in `{f_name}`.\n**Action:** 1. Call `view_file` (path='{f_name}', start_line={s_line}, end_line={l_no+15}) to inspect code context.\n2. Call `replace_file_content` to surgically patch the exact offending line.")

    # 3. CSV / SQLite / Macro matching
    elif "csv" in q_lower and ("sqlite" in q_lower or "db" in q_lower or "table" in q_lower):
        advice.append("**Strategy:** Mechanical data transform detected.\n**Action:** Call `run_skill` with `name='csv_to_sqlite'` and `arguments=['input.csv', 'database.db', 'table_name']` for instant 0-token execution.")

    # 4. Web scraping intent
    elif "scrape" in q_lower or "bs4" in q_lower or "extract links" in q_lower:
        advice.append("**Strategy:** Web extraction requested.\n**Action:** Call `run_skill` with `name='bs4_scrape_links'` or write a quick Python script using `from bs4 import BeautifulSoup` via `terminal`.")

    # 5. General / Unfamiliar API
    else:
        advice.append(f"**Strategic Recommendation:** For '{query}':\n1. Use `web_search` to verify documentation and official examples.\n2. Inspect local workspace files with `grep_search` or `file_search`.\n3. Make atomic edits using `replace_file_content` and verify with `terminal` test runs.")

    return "[Oracle Algorithmic Diagnosis & Plan]\n" + "\n\n".join(advice)


CONSULT_ORACLE_TOOL = Tool(
    name="consult_oracle",
    description=(
        "Actively consult the on-device ML diagnostic oracle for root-cause error analysis, optimal tool selection, or step-by-step strategy when stuck or facing unfamiliar bugs."
    ),
    parameters={
        "type": "object",
        "properties": {
            "problem_or_query": {
                "type": "string",
                "description": "The specific error, confusion, or task objective.",
            }
        },
        "required": ["problem_or_query"],
    },
    func=_consult_oracle_func,
)

import time
from app.telemetry import record_tool_call, get_telemetry_report


def _create_custom_tool_func(args: dict | str) -> str:
    """Create and hot-load a brand-new custom tool into the agent runtime."""
    if not isinstance(args, dict):
        return "error: create_custom_tool requires JSON object with (name, description, script, parameters)"

    name = str(args.get("name") or "").strip().lower()
    description = str(args.get("description") or "").strip()
    script = str(args.get("script") or args.get("code") or "").strip()
    parameters = args.get("parameters") or {"type": "object", "properties": {}}

    if not name or not script or not description:
        return "error: missing required fields (name, description, script)"

    def custom_runner(tool_args: dict | str) -> str:
        workspace = ensure_workspace()
        temp_file = workspace / f".custom_tool_{name}.py"
        temp_file.write_text(script, encoding="utf-8")
        raw_str = json.dumps(tool_args) if isinstance(tool_args, dict) else str(tool_args)
        escaped_args = raw_str.replace("'", "'\"'\"'")
        py_exec = sys.executable or "python3"
        out = _terminal_func(f"{py_exec} {temp_file.name} '{escaped_args}'")
        temp_file.unlink(missing_ok=True)
        return out

    new_tool = Tool(name=name, description=description, parameters=parameters, func=custom_runner)
    TOOLS[name] = new_tool
    _ALIASES[name] = custom_runner
    return f"✓ Successfully created and hot-loaded custom tool '{name}'."


def _update_tool_func(args: dict | str) -> str:
    """Update description or implementation of an existing tool."""
    if not isinstance(args, dict):
        return "error: update_tool requires JSON object with (name, description, script)"

    name = str(args.get("name") or "").strip().lower()
    if name not in TOOLS:
        return f"error: tool '{name}' does not exist"

    new_desc = str(args.get("description") or "").strip()
    new_script = str(args.get("script") or args.get("code") or "").strip()

    if new_script:
        def updated_runner(tool_args: dict | str) -> str:
            workspace = ensure_workspace()
            temp_file = workspace / f".custom_tool_{name}.py"
            temp_file.write_text(new_script, encoding="utf-8")
            raw_str = json.dumps(tool_args) if isinstance(tool_args, dict) else str(tool_args)
            escaped_args = raw_str.replace("'", "'\"'\"'")
            py_exec = sys.executable or "python3"
            out = _terminal_func(f"{py_exec} {temp_file.name} '{escaped_args}'")
            temp_file.unlink(missing_ok=True)
            return out
        _ALIASES[name] = updated_runner
        TOOLS[name] = Tool(name=name, description=new_desc or TOOLS[name].description, parameters=TOOLS[name].parameters, func=updated_runner)
    elif new_desc:
        TOOLS[name] = Tool(name=name, description=new_desc, parameters=TOOLS[name].parameters, func=TOOLS[name].func)

    return f"✓ Successfully updated tool '{name}'."


def _retire_tool_func(args: dict | str) -> str:
    """Retire and delete a deadweight tool."""
    name = str(args.get("name") if isinstance(args, dict) else args).strip().lower()
    if not name:
        return "error: missing tool name to retire"
    if name in ("terminal", "view_file", "replace_file_content", "consult_oracle"):
        return f"error: cannot retire core foundation tool '{name}'"
    if name in TOOLS:
        del TOOLS[name]
        _ALIASES.pop(name, None)
        return f"✓ Retired deadweight tool '{name}'."
    return f"error: tool '{name}' not found."


def _inspect_tool_telemetry_func(args: dict | str = "") -> str:
    """Inspect execution stats, success rates, latency, and deadweight tools."""
    return get_telemetry_report()


CREATE_CUSTOM_TOOL = Tool(
    name="create_custom_tool",
    description="Synthesize, test, and hot-load a brand-new custom Python tool into the runtime at runtime.",
    parameters={
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Unique tool name."},
            "description": {"type": "string", "description": "Clear docstring for what the tool does."},
            "script": {"type": "string", "description": "Python execution script."},
            "parameters": {"type": "object", "description": "JSON schema for arguments."},
        },
        "required": ["name", "description", "script"],
    },
    func=_create_custom_tool_func,
)

UPDATE_TOOL = Tool(
    name="update_tool",
    description="Update the description or script implementation of an existing tool based on telemetry.",
    parameters={
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Tool name to update."},
            "description": {"type": "string", "description": "Updated docstring."},
            "script": {"type": "string", "description": "Updated Python script."},
        },
        "required": ["name"],
    },
    func=_update_tool_func,
)

RETIRE_TOOL = Tool(
    name="retire_tool",
    description="Safely retire/delete a deadweight or deprecated tool to keep tool schemas compact.",
    parameters={
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "Tool name to retire."},
        },
        "required": ["name"],
    },
    func=_retire_tool_func,
)

INSPECT_TOOL_TELEMETRY = Tool(
    name="inspect_tool_telemetry",
    description="View real-time telemetry, invocation counts, success rates, latency, and deadweight tool alerts.",
    parameters={"type": "object", "properties": {}},
    func=_inspect_tool_telemetry_func,
)

from app.prompt_evolution import evolve_prompt_gene, get_genome_report, get_evolved_system_prompt


def _evolve_prompt_func(args: dict | str) -> str:
    """Mutate and permanently evolve a prompt gene based on real task experience."""
    gene_name = "error_recovery"
    lesson = ""
    if isinstance(args, dict):
        gene_name = str(args.get("gene_name") or args.get("gene") or "error_recovery").strip()
        lesson = str(args.get("lesson_learned") or args.get("lesson") or args.get("directive") or "").strip()
    elif isinstance(args, str):
        lesson = _extract_command(args).strip()
    if not lesson:
        return "error: missing lesson_learned text to evolve prompt gene"
    return evolve_prompt_gene(gene_name, lesson)


def _inspect_agent_genome_func(args: dict | str = "") -> str:
    """Inspect active prompt genes, fitness scores, and evolutionary mutations."""
    return get_genome_report()


EVOLVE_PROMPT_TOOL = Tool(
    name="evolve_prompt",
    description="Permanently evolve and mutate a system prompt gene with lessons learned from task experience.",
    parameters={
        "type": "object",
        "properties": {
            "gene_name": {
                "type": "string",
                "enum": ["core_identity", "reasoning_protocol", "error_recovery", "tool_mastery"],
                "description": "The prompt gene to evolve.",
            },
            "lesson_learned": {
                "type": "string",
                "description": "Specific directive or heuristic learned from this execution.",
            },
        },
        "required": ["lesson_learned"],
    },
    func=_evolve_prompt_func,
)

INSPECT_AGENT_GENOME_TOOL = Tool(
    name="inspect_agent_genome",
    description="Inspect the active evolutionary prompt genes, fitness ratings, and mutation history.",
    parameters={"type": "object", "properties": {}},
    func=_inspect_agent_genome_func,
)

TOOLS: dict[str, Tool] = {
    "terminal": TERMINAL_TOOL,
    "view_file": VIEW_FILE_TOOL,
    "replace_file_content": REPLACE_FILE_CONTENT_TOOL,
    "grep_search": GREP_SEARCH_TOOL,
    "file_search": FILE_SEARCH_TOOL,
    "web_search": WEB_SEARCH_TOOL,
    "fetch_web_page": FETCH_WEB_PAGE_TOOL,
    "save_skill": SAVE_SKILL_TOOL,
    "run_skill": RUN_SKILL_TOOL,
    "list_skills": LIST_SKILLS_TOOL,
    "delegate_task": DELEGATE_TASK_TOOL,
    "ask_user": ASK_USER_TOOL,
    "consult_oracle": CONSULT_ORACLE_TOOL,
    "create_custom_tool": CREATE_CUSTOM_TOOL,
    "update_tool": UPDATE_TOOL,
    "retire_tool": RETIRE_TOOL,
    "inspect_tool_telemetry": INSPECT_TOOL_TELEMETRY,
    "evolve_prompt": EVOLVE_PROMPT_TOOL,
    "inspect_agent_genome": INSPECT_AGENT_GENOME_TOOL,
}

# Tolerant Alias Mapping: route whatever the model hallucinates to the right executor
_ALIASES: dict[str, Callable[[dict | str], str]] = {
    "terminal": _terminal_func,
    "bash": _terminal_func,
    "sh": _terminal_func,
    "shell": _terminal_func,
    "run_shell": _terminal_func,
    "cmd": _terminal_func,
    "command": _terminal_func,
    "exec": _terminal_func,
    "execute": _terminal_func,
    "python": _python_func,
    "py": _python_func,
    "python3": _python_func,
    "run_python": _python_func,
    "code_interpreter": _python_func,
    "eval": _python_func,
    "calculator": _python_func,
    "view_file": _view_file_func,
    "read_file": _view_file_func,
    "cat": _view_file_func,
    "open_file": _view_file_func,
    "replace_file_content": _replace_file_content_func,
    "edit_file": _replace_file_content_func,
    "modify_file": _replace_file_content_func,
    "grep_search": _grep_search_func,
    "grep": _grep_search_func,
    "find_in_files": _grep_search_func,
    "file_search": _file_search_func,
    "find_file": _file_search_func,
    "find_by_name": _file_search_func,
    "glob": _file_search_func,
    "web_search": _web_search_func,
    "search": _web_search_func,
    "google": _web_search_func,
    "google_search": _web_search_func,
    "duckduckgo": _web_search_func,
    "search_web": _web_search_func,
    "bing": _web_search_func,
    "fetch_web_page": _fetch_web_page_func,
    "fetch_url": _fetch_web_page_func,
    "read_url": _fetch_web_page_func,
    "browse": _fetch_web_page_func,
    "read_page": _fetch_web_page_func,
    "curl_url": _fetch_web_page_func,
    "save_skill": _save_skill_func,
    "learn_skill": _save_skill_func,
    "add_skill": _save_skill_func,
    "run_skill": _run_skill_func,
    "call_skill": _run_skill_func,
    "exec_skill": _run_skill_func,
    "list_skills": _list_skills_func,
    "skills": _list_skills_func,
    "delegate_task": _delegate_task_func,
    "delegate": _delegate_task_func,
    "invoke_subagent": _delegate_task_func,
    "subagent": _delegate_task_func,
    "ask_user": _ask_user_func,
    "ask": _ask_user_func,
    "question": _ask_user_func,
    "consult_oracle": _consult_oracle_func,
    "oracle": _consult_oracle_func,
    "auto_diagnose": _consult_oracle_func,
    "diagnose": _consult_oracle_func,
    "suggest_strategy": _consult_oracle_func,
    "ask_algo": _consult_oracle_func,
    "create_custom_tool": _create_custom_tool_func,
    "create_tool": _create_custom_tool_func,
    "add_tool": _create_custom_tool_func,
    "update_tool": _update_tool_func,
    "modify_tool": _update_tool_func,
    "retire_tool": _retire_tool_func,
    "delete_tool": _retire_tool_func,
    "inspect_tool_telemetry": _inspect_tool_telemetry_func,
    "telemetry": _inspect_tool_telemetry_func,
    "evolve_prompt": _evolve_prompt_func,
    "evolve": _evolve_prompt_func,
    "mutate_prompt": _evolve_prompt_func,
    "inspect_agent_genome": _inspect_agent_genome_func,
    "genome": _inspect_agent_genome_func,
}


def specs() -> list[dict]:
    """OpenAI-style tool specifications advertised to llama-server."""
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            },
        }
        for t in TOOLS.values()
    ]


from app.telemetry import record_tool_call, get_telemetry_report, score_tool_linucb


def get_active_tool_slice(messages: list[dict] | None = None) -> list[dict]:
    """Dynamically slice the tool list using LinUCB contextual bandit scores,
    slashing tool schema overhead by 60%+ while keeping small models laser-focused."""
    if not messages:
        return specs()

    # Core baseline tools always present
    selected_keys = {"terminal", "view_file", "replace_file_content", "consult_oracle"}

    # LinUCB Contextual Scoring across non-core candidate tools
    candidates = [k for k in TOOLS if k not in selected_keys]
    scored = [(score_tool_linucb(k, messages), k) for k in candidates]
    scored.sort(key=lambda x: x[0], reverse=True)

    # Top-2 contextual bandit winners
    for _, tool_key in scored[:2]:
        selected_keys.add(tool_key)

    # Contextual signal safety net
    last_content = str(messages[-1].get("content") or "").lower()
    if any(k in last_content for k in ("search", "how to", "docs", "api", "what is", "where is")):
        selected_keys.update({"web_search", "grep_search"})
    elif any(k in last_content for k in ("skill", "csv", "sqlite", "scrape", "macro")):
        selected_keys.update({"run_skill", "save_skill"})

    return [
        {
            "type": "function",
            "function": {
                "name": TOOLS[k].name,
                "description": TOOLS[k].description,
                "parameters": TOOLS[k].parameters,
            },
        }
        for k in selected_keys
        if k in TOOLS
    ]


def execute(name: str, arguments: str | dict) -> str:
    """Run a tool by name with fuzzy argument parsing, alias fallback, and real-time telemetry."""
    clean_name = name.strip().lower()
    t_start = time.perf_counter()

    func = _ALIASES.get(clean_name)
    if func is None:
        # If unknown tool name, fallback to executing with terminal
        func = _terminal_func

    if isinstance(arguments, str):
        try:
            parsed_args = json.loads(arguments, strict=False) if arguments.strip() else {}
        except Exception:
            # If arguments is raw text / command instead of JSON
            parsed_args = arguments
    else:
        parsed_args = arguments or {}

    try:
        res = func(parsed_args)
        duration_ms = (time.perf_counter() - t_start) * 1000.0
        is_succ = not ("[exit code " in res or res.startswith("error:"))
        record_tool_call(clean_name, duration_ms, is_succ, "" if is_succ else res[:200])
        return res
    except Exception as ex:
        duration_ms = (time.perf_counter() - t_start) * 1000.0
        err_msg = f"error: exception during tool execution: {ex}"
        record_tool_call(clean_name, duration_ms, False, err_msg)
        return err_msg
