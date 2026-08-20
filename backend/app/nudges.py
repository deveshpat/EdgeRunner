"""Intelligent Dynamic Tool Nudge & Intent Pre-Router for EdgeRunner.

Supercharges small local models (1B-8B) by analyzing recent turn errors,
user intent, and workspace diffs to suggest the exact high-leverage tool.
"""

from __future__ import annotations

import re
from pathlib import Path


def compute_tool_nudge(messages: list[dict], workspace_root: Path | None = None) -> str | None:
    """Compute a single-line dynamic hint to steer the agent towards the best tool."""
    if not messages:
        return None

    # Inspect the most recent message (tool result or user prompt)
    last_msg = messages[-1]
    role = last_msg.get("role", "")
    content = str(last_msg.get("content") or "")

    # 1. Error Signal: Python Traceback / SyntaxError with File and Line Number
    tb_match = re.search(r'File ["\']([^"\']+\.(?:py|js|ts|tsx|jsx|json))["\'], line (\d+)', content)
    if tb_match:
        file_path, line_no = tb_match.group(1), int(tb_match.group(2))
        # Keep relative path
        if "/" in file_path:
            file_path = file_path.split("/")[-1]
        start_line = max(1, line_no - 15)
        end_line = line_no + 15
        return (
            f"[🎯 Model Nudge: Traceback detected at line {line_no} of '{file_path}'. "
            f"Consider using 'view_file' (path='{file_path}', start_line={start_line}, end_line={end_line}) to inspect the code context.]"
        )

    # 2. Error Signal: Missing Python or Node dependency
    missing_mod = re.search(r"ModuleNotFoundError: No module named ['\"]([^'\"]+)['\"]", content)
    if missing_mod:
        pkg = missing_mod.group(1)
        return f"[🎯 Model Nudge: Missing module '{pkg}'. Consider running 'terminal' with 'uv pip install {pkg}' or 'pip install {pkg}'.]"

    missing_node = re.search(r"Cannot find module ['\"]([^'\"]+)['\"]", content)
    if missing_node:
        pkg = missing_node.group(1)
        return f"[🎯 Model Nudge: Missing Node package '{pkg}'. Consider running 'terminal' with 'npm install {pkg}'.]"

    # 2b. Loop Interrupter: Shell syntax or JSON escaping recursion
    if "Unterminated quoted string" in content or "syntax error" in content or '{"name=' in content or '{"function=' in content:
        return "[🎯 Model Nudge: Loop Interrupter: Do NOT wrap commands in JSON or XML tags. Output only the pure raw command string, e.g. terminal(command='ls -la').]"

    # 3. User Intent Signal (from user turn)
    if role == "user":
        lower = content.lower()

        # Web search / documentation intent
        if any(k in lower for k in ("how to", "api for", "docs for", "what is the latest", "search for", "lookup")):
            return "[🎯 Model Nudge: User is asking for documentation or technical knowledge. Consider using 'web_search' or 'fetch_web_page'.]"

        # Symbol search / grep intent
        if any(k in lower for k in ("find all references", "where is", "search symbol", "find function", "grep")):
            return "[🎯 Model Nudge: User wants to locate code. Consider using 'grep_search' or 'file_search'.]"

        # Surgical edit intent
        if any(k in lower for k in ("edit", "replace", "fix", "patch", "modify", "update")) and any(ext in lower for ext in (".py", ".ts", ".tsx", ".js", ".json", ".html", ".css")):
            return "[🎯 Model Nudge: File modification requested. Inspect with 'view_file' first, then use 'replace_file_content' for clean atomic edits.]"

        # Mechanical CSV to SQLite / Scraping macro intent
        if "csv" in lower and ("sqlite" in lower or "database" in lower or "db" in lower):
            return "[🎯 Model Nudge: Mechanical CSV->SQLite task detected. You can use 'run_skill' (name='csv_to_sqlite', arguments=['file.csv', 'data.db', 'table']) for instant execution.]"

    return None
