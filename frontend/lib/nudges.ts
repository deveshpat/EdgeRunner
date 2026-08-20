// Intelligent Dynamic Tool Nudge & Intent Pre-Router for Browser Agent
// Steers smaller models (1B-8B) towards the optimal tool in < 1ms.

export function computeToolNudge(messages: { role: string; content?: string }[]): string | null {
  if (!messages || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  const content = String(last.content || "");
  const role = last.role;

  // 1. Error Signal: Traceback with file and line number
  const tbMatch = content.match(/File ["']([^"']+\.(?:py|js|ts|tsx|jsx|json))["'], line (\d+)/i);
  if (tbMatch) {
    const file = tbMatch[1].split("/").pop() || tbMatch[1];
    const line = parseInt(tbMatch[2], 10);
    const start = Math.max(1, line - 15);
    const end = line + 15;
    return `[🎯 Model Nudge: Error traceback detected at line ${line} of '${file}'. Use 'view_file' (path='${file}', start_line=${start}, end_line=${end}) to inspect context.]`;
  }

  // 2. Error Signal: Missing package / command
  const missingMod = content.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/i);
  if (missingMod) {
    return `[🎯 Model Nudge: Missing Python package '${missingMod[1]}'. Use 'terminal' with 'uv pip install ${missingMod[1]}' or 'pip install ${missingMod[1]}'.]`;
  }

  const missingNode = content.match(/Cannot find module ['"]([^'"]+)['"]/i);
  if (missingNode) {
    return `[🎯 Model Nudge: Missing Node package '${missingNode[1]}'. Use 'terminal' with 'npm install ${missingNode[1]}'.]`;
  }

  // 2b. Loop Interrupter: Shell syntax or JSON escaping recursion
  if (content.includes("Unterminated quoted string") || content.includes("syntax error") || content.includes('{"name=') || content.includes('{"function=')) {
    return "[🎯 Model Nudge: Loop Interrupter: Do NOT wrap commands in JSON or XML tags. Output only the pure raw command string, e.g. terminal(command='ls -la').]";
  }

  // 3. User intent signals
  if (role === "user") {
    const lower = content.toLowerCase();
    if (lower.includes("how to") || lower.includes("api for") || lower.includes("docs for") || lower.includes("search for")) {
      return "[🎯 Model Nudge: Documentation lookup requested. Consider using 'web_search' or 'fetch_web_page'.]";
    }
    if (lower.includes("where is") || lower.includes("find all references") || lower.includes("search symbol")) {
      return "[🎯 Model Nudge: Symbol discovery requested. Consider using 'grep_search' or 'file_search'.]";
    }
    if ((lower.includes("edit") || lower.includes("replace") || lower.includes("fix") || lower.includes("patch")) &&
        (lower.includes(".ts") || lower.includes(".tsx") || lower.includes(".js") || lower.includes(".py") || lower.includes(".json"))) {
      return "[🎯 Model Nudge: File modification requested. Inspect with 'view_file' first, then use 'replace_file_content' for atomic edits.]";
    }
    if (lower.includes("csv") && (lower.includes("sqlite") || lower.includes("database") || lower.includes("db"))) {
      return "[🎯 Model Nudge: Mechanical CSV->SQLite task detected. Use 'run_skill' (name='csv_to_sqlite', arguments=['file.csv', 'data.db', 'table']) for instant 0-token execution.]";
    }
  }

  return null;
}
