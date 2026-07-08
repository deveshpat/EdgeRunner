type ChatMessage = { role: string; content: string };

type GenerateOptions = {
  messages: ChatMessage[];
  tools?: unknown[];
  max_new_tokens?: number;
  onToken?: (token: string) => void;
  onProgress?: (progress: Record<string, unknown>) => void;
};

type WorkerMessage = {
  type: string;
  id: string;
  payload?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onToken?: (token: string) => void;
  onProgress?: (progress: Record<string, unknown>) => void;
};

class GemmaManager {
  private worker: Worker | null = null;
  private loadPromise: Promise<void> | null = null;
  private pending = new Map<string, PendingRequest>();

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("../workers/llm.worker.ts", import.meta.url), {
        type: "module",
      });

      this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const { type, id, payload } = event.data;
        const request = this.pending.get(id);
        if (!request) {
          return;
        }

        if (type === "token") {
          request.onToken?.(String(payload ?? ""));
          return;
        }

        if (type === "progress") {
          if (payload && typeof payload === "object") {
            request.onProgress?.(payload as Record<string, unknown>);
          }
          return;
        }

        if (type === "loaded" || type === "result") {
          this.pending.delete(id);
          request.resolve(payload ?? null);
          return;
        }

        if (type === "done") {
          return;
        }

        if (type === "error") {
          this.pending.delete(id);
          request.reject(new Error(String(payload ?? "Gemma worker error")));
        }
      };
    }

    return this.worker;
  }

  private call(
    type: "load" | "generate",
    payload: unknown,
    onToken?: (token: string) => void,
    onProgress?: (progress: Record<string, unknown>) => void,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.pending.set(id, { resolve, reject, onToken, onProgress });
      this.getWorker().postMessage({ type, id, payload });
    });
  }

  async load(onProgress?: (progress: Record<string, unknown>) => void): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.call("load", null, undefined, onProgress)
        .then(() => undefined)
        .catch((error) => {
          this.loadPromise = null;
          throw error;
        });
    }

    return this.loadPromise;
  }

  async generate(options: GenerateOptions): Promise<unknown> {
    await this.load(options.onProgress);
    let sawToken = false;
    const result = await this.call(
      "generate",
      {
        messages: options.messages,
        tools: options.tools,
        max_new_tokens: options.max_new_tokens,
      },
      (token) => {
        sawToken = true;
        options.onToken?.(token);
      },
      options.onProgress,
    );

    if (!sawToken && typeof result === "string") {
      options.onToken?.(result);
    }

    return result;
  }
}

export const gemma = new GemmaManager();

export async function agentLoop(
  userMessage: string,
  options: {
    onToken: (t: string) => void;
    onToolCall: (name: string, args: unknown) => void;
    onToolResult: (name: string, result: unknown) => void;
    memoryContext: string;
    history: ChatMessage[];
  },
): Promise<string> {
  const { runTool, TOOL_REGISTRY } = await import("@/lib/tools/registry");

  const messages: ChatMessage[] = [
    { role: "system", content: options.memoryContext || "You are stuni, a browser-local agent." },
    ...options.history,
    { role: "user", content: userMessage },
  ];

  const maxIterations = 5;
  let finalText = "";

  for (let i = 0; i < maxIterations; i += 1) {
    let chunk = "";

    await gemma.generate({
      messages,
      tools: TOOL_REGISTRY,
      max_new_tokens: 800,
      onToken: (token) => {
        chunk += token;
        options.onToken(token);
      },
    });

    const trimmed = chunk.trim();
    if (!trimmed) {
      break;
    }

    finalText = trimmed;

    const toolCall = extractToolCall(trimmed);
    if (!toolCall) {
      break;
    }

    options.onToolCall(toolCall.name, toolCall.args);

    try {
      const result = await runTool(toolCall.name, toolCall.args);
      options.onToolResult(toolCall.name, result);
      messages.push({ role: "assistant", content: trimmed });
      messages.push({
        role: "user",
        content: `Tool result for ${toolCall.name}: ${safeStringify(result)}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onToolResult(toolCall.name, { error: message });
      messages.push({ role: "assistant", content: trimmed });
      messages.push({
        role: "user",
        content: `Tool error for ${toolCall.name}: ${message}`,
      });
    }
  }

  return finalText.trim();
}

function extractToolCall(
  text: string,
): {
  name: string;
  args: Record<string, unknown>;
} | null {
  const jsonCandidate = findJsonObject(text);
  if (!jsonCandidate) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonCandidate) as {
      tool?: string;
      name?: string;
      args?: Record<string, unknown>;
      arguments?: Record<string, unknown>;
    };
    const name = parsed.tool || parsed.name;
    if (!name) {
      return null;
    }
    const args = parsed.args || parsed.arguments || {};
    return { name, args };
  } catch {
    return null;
  }
}

function findJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
