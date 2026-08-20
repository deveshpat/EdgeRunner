/**
 * Browser-side DeepSeek Harness (dsh) Runner.
 *
 * Runs DeepSeek agent loops in-browser with:
 * - Dual-phase <think> reasoning tokens extraction.
 * - Runtime Presets (Code, Standard, Minimal, Creator).
 * - Wasm terminal sandbox execution and dynamic tool slicing.
 */

import { BrowserToolContext, executeBrowserTool, getActiveBrowserToolSlice } from "./browserTools";
import { computeToolNudge } from "./nudges";
import { DSH_PRESETS, DshBrowserContext } from "./dshPlugins";

export interface StreamEvent {
  type: "token" | "think" | "tool_call" | "tool_result" | "done" | "error";
  data?: string;
}

export interface DshRunOpts {
  messages: { role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string }[];
  preset?: "code" | "standard" | "minimal" | "creator";
  ctx?: BrowserToolContext;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  signal?: AbortSignal;
}

const MAX_DSH_ITERATIONS = 12;

function extractTextToolCalls(text: string): { id: string; name: string; arguments: string }[] {
  const calls: { id: string; name: string; arguments: string }[] = [];
  const toolCallRe = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/gi;
  let match: RegExpExecArray | null;

  while ((match = toolCallRe.exec(text)) !== null) {
    const inner = match[1].trim();
    if (!inner) continue;
    const callId = `dsh_call_${calls.length + 1}`;

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

    const fnMatch = inner.match(/(?:<function(?:=|\s+name=[\"']?)|(?:\{[\"']?(?:function_name|function|name)[\"']?\s*[:=]\s*[\"']?))([\w\-_]+)[\"']?\s*>?([\s\S]*?)(?:<\/function>|\}|$)/i);
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

    calls.push({ id: callId, name: "terminal", arguments: JSON.stringify({ command: inner }) });
  }

  return calls;
}

export async function* runDeepSeekHarness(opts: DshRunOpts): AsyncGenerator<StreamEvent> {
  const presetKey = opts.preset || "code";
  const presetConfig = DSH_PRESETS[presetKey] || DSH_PRESETS.code;

  const messages: { role: string; content?: string | null; tool_calls?: any[]; tool_call_id?: string; name?: string }[] = [
    { role: "system", content: presetConfig.systemPrompt },
    ...opts.messages,
  ];

  const ctx: DshBrowserContext = {
    sessionId: `dsh_${Date.now()}`,
    preset: presetKey,
    iteration: 0,
    messages,
    reasoningTrace: "",
  };

  const endpoint = typeof window !== "undefined"
    ? localStorage.getItem("edgerunner.customEndpoint") || "http://127.0.0.1:8080"
    : "http://127.0.0.1:8080";
  const apiKey = typeof window !== "undefined" ? localStorage.getItem("edgerunner.apiKey") || "" : "";

  for (let iter = 0; iter < MAX_DSH_ITERATIONS; iter++) {
    ctx.iteration = iter;
    const nudge = computeToolNudge(messages as any);
    const payloadMessages = [...messages];
    if (nudge) {
      payloadMessages.push({ role: "system", content: nudge });
    }

    const payload = {
      model: "deepseek-coder",
      messages: payloadMessages,
      tools: getActiveBrowserToolSlice(payloadMessages as any),
      stream: true,
      temperature: opts.temperature ?? 0.2,
      top_p: opts.top_p ?? 0.95,
      max_tokens: opts.max_tokens ?? 4096,
    };

    let responseText = "";
    let inThink = false;
    const pendingCalls: { id: string; name: string; arguments: string }[] = [];

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const res = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: opts.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        yield { type: "error", data: `DeepSeek Harness HTTP ${res.status}: ${errText.slice(0, 300)}` };
        return;
      }

      if (!res.body) {
        yield { type: "error", data: "No response body received from model server." };
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const clean = line.trim();
          if (!clean.startsWith("data: ")) continue;
          const dataStr = clean.slice(6).trim();
          if (dataStr === "[DONE]") break;

          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              let token = delta.content;
              responseText += token;

              if (token.includes("<think>")) {
                inThink = true;
                token = token.replace("<think>", "");
              }

              if (inThink) {
                if (token.includes("</think>")) {
                  const parts = token.split("</think>");
                  const thinkToken = parts[0];
                  const normToken = parts[1] || "";
                  inThink = false;
                  if (thinkToken) {
                    yield { type: "think", data: thinkToken };
                    ctx.reasoningTrace += thinkToken;
                  }
                  if (normToken) {
                    yield { type: "token", data: normToken };
                  }
                } else {
                  yield { type: "think", data: token };
                  ctx.reasoningTrace += token;
                }
              } else {
                yield { type: "token", data: token };
              }
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!pendingCalls[idx]) {
                  pendingCalls[idx] = { id: tc.id || `call_${idx}`, name: tc.function?.name || "terminal", arguments: "" };
                }
                if (tc.function?.name) pendingCalls[idx].name = tc.function.name;
                if (tc.function?.arguments) pendingCalls[idx].arguments += tc.function.arguments;
              }
            }
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") return;
      yield {
        type: "token",
        data: `[DeepSeek Harness Mode] In-browser mock execution active. Ready for local llama-server or Kaggle GPU rig.`
      };
      yield { type: "done" };
      return;
    }

    // Free-form tool call fallback
    const finalCalls = pendingCalls.filter(Boolean);
    if (finalCalls.length === 0 && responseText) {
      const extracted = extractTextToolCalls(responseText);
      finalCalls.push(...extracted);
    }

    if (finalCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: responseText || null,
        tool_calls: finalCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      const toolCtx: BrowserToolContext = opts.ctx || {
        listSessions: () => [],
        renameActive: () => {},
        readActive: () => [],
      };

      for (const call of finalCalls) {
        yield { type: "tool_call", data: JSON.stringify(call) };
        const result = await executeBrowserTool(call.name, call.arguments, toolCtx);
        yield { type: "tool_result", data: JSON.stringify({ id: call.id, name: call.name, result }) };
        messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: result });
      }
      continue;
    }

    yield { type: "done" };
    return;
  }

  yield { type: "error", data: `DeepSeek Harness stopped after ${MAX_DSH_ITERATIONS} iterations.` };
}
