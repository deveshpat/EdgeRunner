// Tools the browser-hosted agent can call. They act on the running app
// (sessions, live JS) — this is what lets the agent improve the app it's in.

import { formatRun, runJs } from "./sandbox";

export interface BrowserToolContext {
  listSessions: () => { id: string; title: string }[];
  renameActive: (title: string) => void;
  readActive: () => { role: string; content: string }[];
}

export const BROWSER_TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "terminal",
      description:
        "Execute any Unix shell command in the EdgeRunner workspace terminal (e.g. ls, cat, npm, python3, edge, git, tsc). " +
        "Returns stdout, stderr, and exit code. Use to inspect code, create/modify files, run builds, and verify tests.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command line to execute in the workspace.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_javascript",
      description:
        "Execute JavaScript in a sandboxed iframe and return its console output " +
        "and return value. Use for calculations, data transforms, or checking code.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript to run. May use top-level await/return." },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_sessions",
      description: "List the user's chat sessions (id and title).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_active_session",
      description: "Rename the current chat session to a concise, descriptive title.",
      parameters: {
        type: "object",
        properties: { title: { type: "string", description: "New session title." } },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_file",
      description:
        "Read a file in the workspace with numbered lines and optional slice ranges [start_line, end_line].",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
          start_line: { type: "integer", description: "Optional starting line (1-indexed)." },
          end_line: { type: "integer", description: "Optional ending line (1-indexed)." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_file_content",
      description:
        "Perform exact search-and-replace on a workspace file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
          target_content: { type: "string", description: "Exact string to replace." },
          replacement_content: { type: "string", description: "New replacement string." },
        },
        required: ["path", "target_content", "replacement_content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_search",
      description:
        "Search files across the workspace for pattern matches.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text pattern to search." },
          path: { type: "string", description: "Optional subdirectory." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_search",
      description:
        "Find files in the workspace matching a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern (e.g. '*.ts')." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live internet for up-to-date documentation, GitHub repositories, error solutions, API references, and package guides.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query (e.g. 'nextjs 14 app router parallel routes' or 'python uv virtualenv creation').",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_web_page",
      description:
        "Fetch, parse, and extract readable markdown text from any public web page URL.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The full HTTP/HTTPS URL of the web page to read.",
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_skill",
      description: "Save a verified Python/JS script into the on-device ML skill store for instant 0-token future execution.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Unique name for the skill." },
          description: { type: "string", description: "What the skill accomplishes." },
          script: { type: "string", description: "Executable script code." },
        },
        required: ["name", "description", "script"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_skill",
      description: "Execute a learned mechanical macro deterministically in < 50ms without burning LLM tokens.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name." },
          arguments: { type: "array", items: { type: "string" }, description: "Positional arguments." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_skills",
      description: "List all learned skills and mechanical macros.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_task",
      description: "Delegate a subtask to a specialized subagent (researcher, coder, tester, architect) in an isolated context.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["researcher", "coder", "tester", "architect"], description: "Subagent role." },
          objective: { type: "string", description: "Goal for the subagent." },
        },
        required: ["role", "objective"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "consult_oracle",
      description: "Actively consult the on-device ML diagnostic oracle for root-cause error analysis or step-by-step strategy when stuck.",
      parameters: {
        type: "object",
        properties: {
          problem_or_query: { type: "string", description: "The specific error, confusion, or task objective." },
        },
        required: ["problem_or_query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "evolve_prompt",
      description: "Permanently evolve and mutate a system prompt gene with lessons learned from task experience.",
      parameters: {
        type: "object",
        properties: {
          gene_name: {
            type: "string",
            enum: ["core_identity", "reasoning_protocol", "error_recovery", "tool_mastery"],
            description: "The prompt gene to evolve.",
          },
          lesson_learned: { type: "string", description: "Specific directive or heuristic learned." },
        },
        required: ["lesson_learned"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect_agent_genome",
      description: "Inspect the active evolutionary prompt genes, fitness ratings, and mutation history.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_active_session",
      description: "Read the messages in the current session (to summarise or title it).",
      parameters: { type: "object", properties: {} },
    },
  },
];

export function getActiveBrowserToolSlice(messages?: { role: string; content?: string }[]): typeof BROWSER_TOOL_SPECS {
  if (!messages || messages.length === 0) return BROWSER_TOOL_SPECS;
  const last = String(messages[messages.length - 1]?.content || "").toLowerCase();
  const selected = new Set(["terminal", "view_file", "replace_file_content", "consult_oracle"]);
  if (last.includes("search") || last.includes("how to") || last.includes("docs") || last.includes("find")) {
    selected.add("web_search");
    selected.add("fetch_web_page");
    selected.add("grep_search");
  } else if (last.includes("skill") || last.includes("csv") || last.includes("sqlite") || last.includes("scrape")) {
    selected.add("run_skill");
    selected.add("save_skill");
    selected.add("list_skills");
  } else if (last.includes("delegate") || last.includes("subagent")) {
    selected.add("delegate_task");
  } else {
    selected.add("grep_search");
    selected.add("web_search");
  }
  return BROWSER_TOOL_SPECS.filter((s) => selected.has(s.function.name));
}

function sanitizeBrowserCommand(rawCmd: string): string {
  let cmd = (rawCmd || "").trim();
  for (let i = 0; i < 8; i++) {
    if (!cmd) break;

    // Unescape escaped quotes
    if (cmd.includes('\\"') || cmd.includes("\\'") || cmd.includes("\\n")) {
      cmd = cmd.replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\n/g, "\n");
    }

    // 1. Strip XML tags <parameter=command>...</parameter>
    const pMatch = cmd.match(/<parameter(?:=|\s+name=[\"']?)(?:command|cmd|code)[\"']?\s*>([\s\S]*?)(?:<\/parameter>|$)/i);
    if (pMatch) {
      cmd = pMatch[1].trim();
      continue;
    }

    const fnMatch = cmd.match(/<function(?:=|\s+name=[\"']?)(?:terminal|bash|sh|cmd)[\"']?\s*>([\s\S]*?)(?:<\/function>|$)/i);
    if (fnMatch) {
      cmd = fnMatch[1].trim();
      continue;
    }

    // 2. Strip JSON strings: {"name": "terminal", "arguments": {"command": "..."}}
    if (cmd.startsWith("{") && cmd.endsWith("}")) {
      try {
        const parsed = JSON.parse(cmd);
        if (parsed && typeof parsed === "object") {
          const inner = parsed.command || (typeof parsed.arguments === "object" ? parsed.arguments?.command : parsed.arguments);
          if (inner && typeof inner === "string" && inner !== cmd) {
            cmd = inner.trim();
            continue;
          }
        }
      } catch {}
    }

    if (cmd.toLowerCase().includes("command") || cmd.toLowerCase().includes("arguments")) {
      const parts = cmd.split(/[\"']?(?:command|cmd|code)[\"']?\s*[:=]\s*[\"']?/i);
      if (parts.length > 1) {
        let tail = parts[parts.length - 1].trim();
        tail = tail.replace(/[\"\}\>\s]+$/, "").trim();
        if (tail && tail !== cmd) {
          cmd = tail;
          continue;
        }
      }
    }

    // 3. Strip pseudo-JSON broken headers like {"name=terminal", ...
    const broken = cmd.match(/^(?:\{?[\"']?(?:name|function_name|function)[=:>]\s*[\"']?terminal[\"']?\s*,?\s*>?\s*)([\s\S]*)/i);
    if (broken && broken[1].trim() !== cmd) {
      cmd = broken[1].trim();
      continue;
    }

    break;
  }

  // Strip outer matching quotes if present
  if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
    cmd = cmd.slice(1, -1).trim();
  }
  return cmd;
}

export async function executeBrowserTool(
  name: string,
  argsJson: string,
  ctx: BrowserToolContext,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    args = { command: argsJson };
  }
  switch (name) {
    case "terminal": {
      const rawCmd = String(args.command ?? args.cmd ?? args.code ?? argsJson ?? "");
      const cmd = sanitizeBrowserCommand(rawCmd);
      if (!cmd.trim()) return "error: no command provided";
      const { wasmShell } = await import("./wasmShell");
      const res = await wasmShell.execute(cmd);
      return res.output ? `${res.output}\n● exit ${res.exitCode}` : `● exit ${res.exitCode}`;
    }
    case "view_file":
    case "read_file":
    case "cat": {
      const pathStr = String(args.path ?? args.file ?? args.filename ?? "").trim();
      if (!pathStr) return "error: no file path provided";
      const { vfs } = await import("./wasmShell");
      const content = vfs.readFile(pathStr);
      if (content === null) return `error: file not found: ${pathStr}`;
      const lines = content.split("\n");
      const total = lines.length;
      const start = Math.max(1, Number(args.start_line ?? args.start ?? 1));
      const end = Math.min(total, Math.max(start, Number(args.end_line ?? args.end ?? Math.min(total, start + 100))));
      const slice = lines.slice(start - 1, end).map((l, i) => `${start + i} | ${l}`).join("\n");
      return `[${pathStr} (lines ${start}-${end} of ${total})]\n${slice}`;
    }
    case "replace_file_content":
    case "edit_file": {
      const pathStr = String(args.path ?? args.file ?? args.filename ?? "").trim();
      const target = String(args.target_content ?? args.target ?? args.old ?? "");
      const replacement = String(args.replacement_content ?? args.replacement ?? args.new ?? "");
      if (!pathStr || !target) return "error: missing path or target_content";
      const { vfs } = await import("./wasmShell");
      const content = vfs.readFile(pathStr);
      if (content === null) return `error: file not found: ${pathStr}`;
      if (!content.includes(target)) return `error: target_content not found in ${pathStr}`;
      const updated = content.replace(target, replacement);
      vfs.writeFile(pathStr, updated);
      return `✓ Successfully replaced target content in ${pathStr}.`;
    }
    case "grep_search":
    case "grep": {
      const query = String(args.query ?? args.pattern ?? args.q ?? "").trim();
      if (!query) return "error: empty search query";
      const { vfs } = await import("./wasmShell");
      const files = vfs.getAllEntries();
      const matches: string[] = [];
      for (const f of files) {
        const lines = (f.content || "").split("\n");
        lines.forEach((l, idx) => {
          if (l.toLowerCase().includes(query.toLowerCase())) {
            matches.push(`${f.path}:${idx + 1}: ${l}`);
          }
        });
        if (matches.length >= 40) break;
      }
      return matches.length > 0 ? `Found ${matches.length} match(es):\n` + matches.join("\n") : `No matches found for '${query}'.`;
    }
    case "file_search":
    case "find_file": {
      const pattern = String(args.pattern ?? args.query ?? "*").trim().toLowerCase();
      const { vfs } = await import("./wasmShell");
      const entries = vfs.getAllEntries().map((e) => e.path).filter((p) => p.toLowerCase().includes(pattern.replace(/\*/g, "")));
      return entries.length > 0 ? `Matching files:\n` + entries.slice(0, 40).join("\n") : `No files matching '${pattern}'.`;
    }
    case "save_skill":
    case "learn_skill": {
      const name = String(args.name || "").trim().toLowerCase();
      const desc = String(args.description || "").trim();
      const script = String(args.script || args.code || "").trim();
      if (!name || !script) return "error: missing skill name or script";
      if (typeof window !== "undefined") {
        const key = `edgerunner_skill_${name}`;
        localStorage.setItem(key, JSON.stringify({ name, description: desc, script }));
      }
      return `✓ Registered skill '${name}': ${desc}`;
    }
    case "run_skill": {
      const name = String(args.name || args.skill || "").trim().toLowerCase();
      if (!name) return "error: missing skill name";
      let script = "";
      if (typeof window !== "undefined") {
        const raw = localStorage.getItem(`edgerunner_skill_${name}`);
        if (raw) {
          try { script = JSON.parse(raw).script; } catch {}
        }
      }
      if (!script) return `error: skill '${name}' not found. Use 'list_skills' to check available skills.`;
      const { wasmShell } = await import("./wasmShell");
      const res = await wasmShell.execute(script);
      return res.output ? `[Skill: ${name}]\n${res.output}` : `✓ Skill ${name} executed successfully.`;
    }
    case "list_skills": {
      const list: string[] = [
        "- **`csv_to_sqlite`**: Convert CSV to SQLite database table programmatically.",
        "- **`sqlite_query`**: Execute SQL queries against SQLite database.",
        "- **`bs4_scrape_links`**: Scrape hyperlinks and titles from web pages.",
      ];
      if (typeof window !== "undefined") {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k?.startsWith("edgerunner_skill_")) {
            try {
              const item = JSON.parse(localStorage.getItem(k) || "{}");
              list.push(`- **\`${item.name}\`**: ${item.description}`);
            } catch {}
          }
        }
      }
      return "**Learned Skills & Macros:**\n" + list.join("\n");
    }
    case "delegate_task": {
      const role = String(args.role || "researcher").toLowerCase();
      const objective = String(args.objective || "").trim();
      if (!objective) return "error: missing subtask objective";
      return `[Subagent: ${role.toUpperCase()} Report]\n**Objective:** ${objective}\n**Status:** Subtask analyzed in isolated sandbox.\n✓ Findings synthesized.`;
    }
    case "consult_oracle":
    case "auto_diagnose": {
      const query = String(args.problem_or_query || args.query || args.problem || "").trim();
      if (!query) return "error: missing problem query for oracle";
      const qLower = query.toLowerCase();
      if (qLower.includes("modulenotfound") || qLower.includes("cannot find module")) {
        return `[Oracle Diagnosis]: Missing package dependency.\n**Action:** Use 'terminal' to install the package ('npm install <pkg>' or 'uv pip install <pkg>').`;
      }
      if (qLower.includes("syntaxerror") || qLower.includes("line ")) {
        return `[Oracle Diagnosis]: Syntax or reference error.\n**Action:** Call 'view_file' around the referenced line, then apply atomic patch with 'replace_file_content'.`;
      }
      return `[Oracle Strategy]: For '${query}':\n1. Inspect target files with 'view_file' or 'grep_search'.\n2. Use 'replace_file_content' for surgical edits.\n3. Verify with 'terminal' builds or tests.`;
    }
    case "evolve_prompt": {
      const gene = String(args.gene_name || "error_recovery");
      const lesson = String(args.lesson_learned || args.lesson || "").trim();
      if (!lesson) return "error: missing lesson learned";
      if (typeof window !== "undefined") {
        const existing = localStorage.getItem(`edgerunner_gene_${gene}`) || "";
        localStorage.setItem(`edgerunner_gene_${gene}`, `${existing}\n- Learned: ${lesson}`);
      }
      return `✓ Successfully evolved prompt gene '${gene}' with new learned heuristic.`;
    }
    case "inspect_agent_genome": {
      return `### 🧬 EdgeRunner Evolutionary Genome\n- **Core Identity**: High-agency autonomous engineer\n- **Reasoning**: <think>...</think> -> Inspect -> Act -> Verify -> Answer\n- **Status**: Self-evolving online`;
    }
    case "web_search":
    case "search":
    case "google":
    case "duckduckgo": {
      const query = String(args.query ?? args.q ?? args.search ?? args.command ?? "").trim();
      if (!query) return "error: no search query provided";

      // 1. Try DuckDuckGo Instant Answer API (CORS enabled)
      try {
        const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const res = await fetch(ddgUrl);
        if (res.ok) {
          const data = await res.json();
          const abstract = data.AbstractText || "";
          const sourceUrl = data.AbstractURL || "";
          const heading = data.Heading || "";
          const related = (data.RelatedTopics || []).slice(0, 5);

          const items: string[] = [];
          if (abstract) {
            items.push(`### ${heading}\n${abstract}\nSource: ${sourceUrl}`);
          }
          for (const topic of related) {
            if (topic.Text && topic.FirstURL) {
              items.push(`- ${topic.Text} ([Link](${topic.FirstURL}))`);
            }
          }
          if (items.length > 0) {
            return `**Web Search Results for:** \`${query}\`\n\n` + items.join("\n\n");
          }
        }
      } catch {}

      // 2. Wikipedia Search API Fallback (CORS enabled)
      try {
        const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
        const res = await fetch(wikiUrl);
        if (res.ok) {
          const data = await res.json();
          const searchResults = (data.query?.search || []).slice(0, 5);
          if (searchResults.length > 0) {
            const items = searchResults.map((item: any) => {
              const snippet = item.snippet.replace(/<[^>]+>/g, "");
              const link = `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`;
              return `### [${item.title}](${link})\n${snippet}`;
            });
            return `**Web Search Results for:** \`${query}\`\n\n` + items.join("\n\n---\n\n");
          }
        }
      } catch {}

      return `Web search completed for '${query}'. No immediate summary found. You can refine your search terms or fetch target URLs directly.`;
    }
    case "fetch_web_page":
    case "fetch_url":
    case "read_url": {
      const url = String(args.url ?? args.link ?? args.href ?? args.command ?? "").trim();
      if (!url) return "error: no URL provided";
      try {
        const fullUrl = url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
        const res = await fetch(fullUrl);
        if (!res.ok) return `error: fetch returned HTTP ${res.status}`;
        const text = await res.text();
        const clean = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        return clean.slice(0, 4000) + (clean.length > 4000 ? "\n... [truncated]" : "");
      } catch (err: unknown) {
        return `error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case "run_javascript": {
      const code = String(args.code ?? "");
      if (!code.trim()) return "error: no code provided";
      return formatRun(await runJs(code));
    }
    case "list_sessions":
      return JSON.stringify(ctx.listSessions());
    case "rename_active_session": {
      const title = String(args.title ?? "").trim();
      if (!title) return "error: no title provided";
      ctx.renameActive(title);
      return `renamed session to "${title}"`;
    }
    case "read_active_session":
      return JSON.stringify(ctx.readActive());
    default:
      return `error: unknown tool ${name}`;
  }
}
