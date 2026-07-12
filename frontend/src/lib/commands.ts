/**
 * OpenCode-inspired slash commands for EdgeRunner.
 *
 * Built-ins mirror OpenCode TUI (https://opencode.ai/docs/tui#commands):
 *   /help /new /clear /compact /models /sessions /undo /redo
 *   /export /thinking /details /themes /settings
 * Plus coding agents:
 *   /code /build /plan /agent /init /review
 *
 * Custom templates can be added later via prefs.customCommands.
 */

export type AgentMode = "build" | "plan";

export type CommandKind =
  | "local" // handled entirely in the UI
  | "prompt" // expand to a prompt and send to the agent
  | "force_harness"; // send remaining text with harness forced

export type SlashCommand = {
  name: string;
  aliases?: string[];
  description: string;
  kind: CommandKind;
  /** For kind=prompt: template. $ARGUMENTS = rest of line after command. */
  template?: string;
  /** Preferred agent when this command is used */
  agent?: AgentMode;
  /** Hide from default help (internal) */
  hidden?: boolean;
};

export const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "help",
    aliases: ["?"],
    description: "Show available slash commands",
    kind: "local",
  },
  {
    name: "new",
    aliases: ["clear"],
    description: "Start a new session (clear chat)",
    kind: "local",
  },
  {
    name: "compact",
    aliases: ["summarize"],
    description: "Compact chat context (keep last turns + summary note)",
    kind: "local",
  },
  {
    name: "models",
    aliases: ["model"],
    description: "Open model picker",
    kind: "local",
  },
  {
    name: "settings",
    aliases: ["config", "connect"],
    description: "Open settings drawer",
    kind: "local",
  },
  {
    name: "sessions",
    aliases: ["resume", "continue"],
    description: "Show session / connection status",
    kind: "local",
  },
  {
    name: "export",
    description: "Export conversation as Markdown (download)",
    kind: "local",
  },
  {
    name: "undo",
    description: "Remove last user+assistant turn",
    kind: "local",
  },
  {
    name: "redo",
    description: "Restore last undone turn",
    kind: "local",
  },
  {
    name: "thinking",
    description: "Toggle visibility of agent traces / thoughts",
    kind: "local",
  },
  {
    name: "details",
    description: "Toggle tool-detail density in CLI view",
    kind: "local",
  },
  {
    name: "cli",
    description: "Switch to CLI (terminal) view",
    kind: "local",
  },
  {
    name: "chat",
    description: "Switch to chat (markdown) view",
    kind: "local",
  },
  {
    name: "view",
    description: "Toggle CLI ↔ chat view",
    kind: "local",
  },
  {
    name: "agent",
    description: "Show or set agent: /agent build | /agent plan",
    kind: "local",
  },
  {
    name: "engine",
    description: "Switch agent engine: /engine hermes | native",
    kind: "local",
  },
  {
    name: "loop",
    description: "Run a task until done: /loop [n] <task> (default 3 rounds)",
    kind: "local",
  },
  {
    name: "retry",
    description: "Resend the last user message",
    kind: "local",
  },
  {
    name: "stop",
    aliases: ["abort", "cancel"],
    description: "Cancel the in-flight run (server-side too)",
    kind: "local",
  },
  {
    name: "memory",
    description: "Persistent notes: /memory add <text> | list | clear",
    kind: "local",
  },
  {
    name: "system",
    description: "Custom system prompt: /system <text> | show | clear",
    kind: "local",
  },
  {
    name: "build",
    description: "Switch to Build agent (full tools) and optional task",
    kind: "force_harness",
    agent: "build",
  },
  {
    name: "plan",
    description: "Switch to Plan agent (readonly) and optional task",
    kind: "force_harness",
    agent: "plan",
  },
  {
    name: "code",
    description: "Force coding harness for the rest of the message",
    kind: "force_harness",
    agent: "build",
  },
  {
    name: "init",
    description: "Guided AGENTS.md / project setup (OpenCode /init)",
    kind: "prompt",
    agent: "plan",
    template: `Create or update a compact AGENTS.md (or project guidance) for the current coding environment.

User focus (if any): $ARGUMENTS

Include only high-signal, repo-specific guidance an agent would miss:
- exact run/test/lint commands
- architecture entrypoints
- constraints and gotchas
Omit generic advice. Prefer short bullets.`,
  },
  {
    name: "review",
    description: "Review recent changes [commit|branch|pr] (OpenCode /review)",
    kind: "prompt",
    agent: "plan",
    template: `You are a code reviewer. Review the requested scope and provide actionable feedback.

Input: $ARGUMENTS
(If empty, review the most recent solution / conversation code.)

Focus on:
1. Bugs and logic errors
2. Edge cases and error handling
3. Security issues
4. Fit with stated requirements

Be certain before flagging. Diffs alone are not enough — reason about intended behavior.
Do not invent hypothetical problems.`,
  },
  {
    name: "test",
    description: "Ask agent to write/run thorough tests for the task",
    kind: "prompt",
    agent: "build",
    template: `Write thorough tests for: $ARGUMENTS

Then implement or fix the solution until tests pass. Use the coding harness tools.
Prefer assert-style unit tests. Report final code and test results.`,
  },
  {
    name: "fix",
    description: "Debug and fix based on error context",
    kind: "prompt",
    agent: "build",
    template: `Debug and fix the following issue. Reproduce with tests if possible, then patch.

$ARGUMENTS

Use tools, verify with execution, call done when fixed.`,
  },
];

const byName = new Map<string, SlashCommand>();
for (const c of BUILTIN_COMMANDS) {
  byName.set(c.name, c);
  for (const a of c.aliases || []) byName.set(a, c);
}

export function listCommands(): SlashCommand[] {
  return BUILTIN_COMMANDS.filter((c) => !c.hidden);
}

export function findCommand(name: string): SlashCommand | undefined {
  return byName.get((name || "").toLowerCase().replace(/^\//, ""));
}

export type ParsedSlash =
  | { kind: "none"; text: string }
  | {
      kind: "unknown";
      name: string;
      raw: string;
      suggestions: SlashCommand[];
    }
  | {
      kind: "command";
      command: SlashCommand;
      args: string;
      raw: string;
    };

/** Parse a leading /command from the input line. */
export function parseSlash(input: string): ParsedSlash {
  const text = (input || "").trim();
  if (!text.startsWith("/")) return { kind: "none", text: input };

  // /command rest…
  const m = text.match(/^\/([a-zA-Z0-9_?-]+)(?:\s+([\s\S]*))?$/);
  if (!m) {
    // "/", "/ …" — malformed command, never send to the model
    return { kind: "unknown", name: text.slice(1), raw: text, suggestions: [] };
  }
  const name = m[1].toLowerCase();
  const args = (m[2] || "").trim();
  const command = findCommand(name);
  if (!command) {
    // Typo / partial like "/sett" — hint locally instead of sending to the model
    return {
      kind: "unknown",
      name,
      raw: text,
      suggestions: filterCommands(name).slice(0, 3),
    };
  }
  return { kind: "command", command, args, raw: text };
}

export function expandTemplate(template: string, args: string): string {
  return template
    .replace(/\$ARGUMENTS/g, args || "(none)")
    .replace(/\$0/g, args || "")
    .trim();
}

export function helpText(): string {
  const lines = [
    "EdgeRunner slash commands (OpenCode-inspired)",
    "",
    "Usage: /command [arguments]",
    "",
  ];
  const seen = new Set<string>();
  for (const c of listCommands()) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    const alias =
      c.aliases && c.aliases.length
        ? ` (aliases: ${c.aliases.map((a) => "/" + a).join(", ")})`
        : "";
    lines.push(`  /${c.name.padEnd(12)} ${c.description}${alias}`);
  }
  lines.push("");
  lines.push("Also:");
  lines.push("  Tab in composer is unused — use /agent build|plan");
  lines.push("  Prefix ! is reserved for future local shell (OpenCode-style)");
  lines.push("  Coding tasks auto-route to the OpenCode-style tool harness");
  return lines.join("\n");
}

/** Fuzzy filter for command palette while typing `/…` */
export function filterCommands(query: string): SlashCommand[] {
  const q = (query || "").toLowerCase().replace(/^\//, "");
  if (!q) return listCommands();
  return listCommands().filter(
    (c) =>
      c.name.startsWith(q) ||
      c.aliases?.some((a) => a.startsWith(q)) ||
      c.description.toLowerCase().includes(q)
  );
}
