// Browser-hosted agentic loop: talks to the model's OpenAI endpoint directly
// (through the active backend / tunnel via /v1) and runs its tools in the
// browser. This is what lets the agent act on the running app.

import { getApiBase, type StreamEvent } from "./api";
import {
  BROWSER_TOOL_SPECS,
  executeBrowserTool,
  getActiveBrowserToolSlice,
  type BrowserToolContext,
} from "./browserTools";
import { computeToolNudge } from "./nudges";

export const BROWSER_AGENT_ID = "browser-agent";

const SYSTEM_PROMPT =
  "You are EdgeRunner, an elite autonomous software engineering and coding agent with access to the live workspace.\n" +
  "You have access to the full tool suite: `terminal`, `view_file`, `replace_file_content`, `grep_search`, `file_search`, `web_search`, `fetch_web_page`, `run_skill`, `save_skill`, `list_skills`, `delegate_task`, `consult_oracle`.\n" +
  "Always follow the protocol: Think in <think>...</think> -> Inspect -> Act -> Verify -> Answer.\n" +
  "Never invent tool outputs. Run commands to verify code and provide a clean Markdown response once complete.";

const MAX_ITERATIONS = 30;

interface RunOpts {
  model: string;
  messages: { role: string; content: string }[];
  ctx: BrowserToolContext;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  signal?: AbortSignal;
}

function extractTextToolCalls(text: string): { id: string; name: string; arguments: string }[] {
  const calls: { id: string; name: string; arguments: string }[] = [];
  
  // 1. Check for <tool_call> tags (both closed and unclosed)
  const toolCallRe = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/gi;
  let match: RegExpExecArray | null;

  while ((match = toolCallRe.exec(text)) !== null) {
    const inner = match[1].trim();
    if (!inner) continue;
    const callId = `browser_call_${calls.length + 1}`;

    // 1a. Strict or tolerant JSON parse
    try {
      const parsed = JSON.parse(inner);
      if (parsed && typeof parsed === "object") {
        const name = parsed.name || parsed.function?.name || parsed.function_name || "terminal";
        const args = parsed.arguments || parsed.parameters || parsed;
        calls.push({
          id: callId,
          name: String(name),
          arguments: typeof args === "string" ? args : JSON.stringify(args),
        });
        continue;
      }
    } catch {}

    // 1b. XML / Tag-style function extraction (e.g. <function=view_file>, {"function_name="terminal">, {"name=terminal>)
    const fnMatch = inner.match(/(?:<function(?:=|\s+name=[\"']?)|(?:\{[\"']?(?:function_name|name)[\"']?\s*[:=]\s*[\"']?))([\w\-_]+)[\"']?\s*>?([\s\S]*?)(?:<\/function>|\}|$)/i);
    if (fnMatch) {
      const name = fnMatch[1].trim();
      const fnBody = fnMatch[2].trim();
      const paramMatches = [...fnBody.matchAll(/<parameter(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)(?:<\/parameter>|$)/gi)];
      const argObj: Record<string, string> = {};
      if (paramMatches.length > 0) {
        for (const pm of paramMatches) {
          argObj[pm[1].trim()] = pm[2].trim().replace(/^[\"']|[\"']$/g, "");
        }
      } else if (fnBody) {
        if (name === "view_file" || name === "read_file" || name === "cat") {
          argObj["path"] = fnBody.replace(/^[\"']|[\"']$/g, "").trim();
        } else {
          argObj["command"] = fnBody;
        }
      }
      calls.push({ id: callId, name, arguments: JSON.stringify(argObj) });
      continue;
    }

    // 1c. Raw text inside <tool_call> fallback
    calls.push({ id: callId, name: "terminal", arguments: JSON.stringify({ command: inner }) });
  }

  // 2. Fallback: if no <tool_call> tags were used, search for standalone <function=...> in text
  if (calls.length === 0) {
    const standaloneFnRe = /<function(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)(?:<\/function>|$)/gi;
    let sMatch: RegExpExecArray | null;
    while ((sMatch = standaloneFnRe.exec(text)) !== null) {
      const name = sMatch[1].trim();
      const fnBody = sMatch[2].trim();
      const paramMatches = [...fnBody.matchAll(/<parameter(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)(?:<\/parameter>|$)/gi)];
      const argObj: Record<string, string> = {};
      if (paramMatches.length > 0) {
        for (const pm of paramMatches) {
          argObj[pm[1].trim()] = pm[2].trim().replace(/^[\"']|[\"']$/g, "");
        }
      } else if (fnBody) {
        if (name === "view_file" || name === "read_file" || name === "cat") {
          argObj["path"] = fnBody.replace(/^[\"']|[\"']$/g, "").trim();
        } else {
          argObj["command"] = fnBody;
        }
      }
      calls.push({ id: `browser_call_${calls.length + 1}`, name, arguments: JSON.stringify(argObj) });
    }
  }

  return calls;
}

import { runDeepSeekHarness } from "./deepseekHarness";

export async function* runBrowserAgent(opts: RunOpts): AsyncGenerator<StreamEvent> {
  for await (const ev of runDeepSeekHarness({
    messages: opts.messages,
    preset: "code",
    ctx: opts.ctx,
    temperature: opts.temperature,
    top_p: opts.top_p,
    max_tokens: opts.max_tokens,
    signal: opts.signal,
  })) {
    yield {
      type: ev.type,
      data: ev.data || "",
    };
  }
}
