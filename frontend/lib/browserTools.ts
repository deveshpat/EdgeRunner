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
      name: "read_active_session",
      description: "Read the messages in the current session (to summarise or title it).",
      parameters: { type: "object", properties: {} },
    },
  },
];

export async function executeBrowserTool(
  name: string,
  argsJson: string,
  ctx: BrowserToolContext,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return `error: invalid arguments for ${name}: ${argsJson}`;
  }
  switch (name) {
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
