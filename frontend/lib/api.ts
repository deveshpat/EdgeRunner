// API client for the EdgeRunner backend.

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface Model {
  id: string;
  name: string;
  description: string;
  context_length: number;
}

export interface Harness {
  id: string;
  name: string;
  description: string;
}

export interface Catalog {
  models: Model[];
  harnesses: Harness[];
}

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export type StreamEventType =
  | "token"
  | "tool_call"
  | "tool_result"
  | "done"
  | "error";

export interface StreamEvent {
  type: StreamEventType;
  // For "token"/"error": plain text. For "tool_call"/"tool_result": a JSON
  // string describing the tool interaction (see ToolEvent).
  data: string;
}

export interface ToolEvent {
  id: string;
  name: string;
  // present on tool_call
  arguments?: string;
  // present on tool_result
  result?: string;
}

export async function fetchCatalog(): Promise<Catalog> {
  const resp = await fetch(`${API_URL}/api/catalog`);
  if (!resp.ok) throw new Error(`catalog: ${resp.status}`);
  return resp.json();
}

/**
 * POST a chat request and yield parsed SSE events as they arrive.
 */
export interface SamplingParams {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

export async function* streamChat(
  body: {
    model: string;
    harness: string;
    messages: ChatMessage[];
  } & SamplingParams,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const resp = await fetch(`${API_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`chat: ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        yield JSON.parse(line.slice("data: ".length)) as StreamEvent;
      } catch {
        // ignore malformed frame
      }
    }
  }
}
