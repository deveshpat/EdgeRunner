// Browser-hosted agentic loop: talks to the model's OpenAI endpoint directly
// (through the active backend / tunnel via /v1) and runs its tools in the
// browser. This is what lets the agent act on the running app.

import { getApiBase, type StreamEvent } from "./api";
import {
  BROWSER_TOOL_SPECS,
  executeBrowserTool,
  type BrowserToolContext,
} from "./browserTools";

export const BROWSER_AGENT_ID = "browser-agent";

const SYSTEM_PROMPT =
  "You are EdgeRunner, an agent running inside a terminal-themed web app. " +
  "You can run sandboxed JavaScript and manage the user's chat sessions via " +
  "tools. Call a tool when it helps (compute with run_javascript, or read/rename " +
  "the session); otherwise answer directly. Think step by step, then give a " +
  "clear Markdown answer. Never invent tool output.";

const MAX_ITERATIONS = 5;

interface RunOpts {
  model: string;
  messages: { role: string; content: string }[];
  ctx: BrowserToolContext;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  signal?: AbortSignal;
}

export async function* runBrowserAgent(opts: RunOpts): AsyncGenerator<StreamEvent> {
  const url = `${getApiBase()}/v1/chat/completions`;
  const messages: Record<string, unknown>[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...opts.messages,
  ];

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages,
          tools: BROWSER_TOOL_SPECS,
          stream: true,
          temperature: opts.temperature ?? 0.7,
          top_p: opts.top_p ?? 0.95,
          min_p: 0.05,
          repeat_penalty: 1.1,
          max_tokens: opts.max_tokens ?? 1024,
        }),
        signal: opts.signal,
      });
    } catch (e) {
      yield { type: "error", data: `model unreachable: ${(e as Error).message}` };
      return;
    }
    if (!resp.ok || !resp.body) {
      yield { type: "error", data: `model ${resp.status}` };
      return;
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let finish = "";
    outer: while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n");
      buf = frames.pop() ?? "";
      for (const line of frames) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") break outer;
        let chunk: {
          choices?: {
            delta?: {
              content?: string;
              tool_calls?: {
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
            finish_reason?: string;
          }[];
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (delta.content) yield { type: "token", data: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const slot = calls.get(idx) ?? { id: "", name: "", arguments: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.arguments += tc.function.arguments;
          calls.set(idx, slot);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }

    if (calls.size > 0) {
      const ordered = [...calls.keys()].sort((a, b) => a - b).map((k) => calls.get(k)!);
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: ordered.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      });
      for (const c of ordered) {
        yield {
          type: "tool_call",
          data: JSON.stringify({ id: c.id, name: c.name, arguments: c.arguments }),
        };
        const result = await executeBrowserTool(c.name, c.arguments, opts.ctx);
        yield {
          type: "tool_result",
          data: JSON.stringify({ id: c.id, name: c.name, result }),
        };
        messages.push({ role: "tool", tool_call_id: c.id, name: c.name, content: result });
      }
      continue;
    }

    void finish;
    yield { type: "done", data: "" };
    return;
  }
  yield { type: "error", data: `agent stopped after ${MAX_ITERATIONS} tool iterations` };
}
