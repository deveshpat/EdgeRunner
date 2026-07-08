import { pipeline, TextStreamer, env } from "@huggingface/transformers";

env.allowRemoteModels = true;
env.useBrowserCache = true;

// Text-only ONNX variant — E4B (~1.5 GB q4f16) is the default.
// To switch to E2B (~500 MB), change the model ID here only.
const MODEL_E4B = "onnx-community/gemma-4-E4B-it-ONNX";
const MODEL_E2B = "onnx-community/gemma-4-E2B-it-ONNX";
const MODEL_J3B = "bartowski/ai21labs_AI21-Jamba-Reasoning-3B-GGUF";
const MODEL_ID = MODEL_J3B;
const DTYPE = "q4f16";

type GeneratorPipeline = any;

let generator: GeneratorPipeline | null = null;

// Detect whether a real WebGPU adapter is available in this worker context.
async function resolveDevice(): Promise<"webgpu" | "wasm"> {
  try {
    const nav = self.navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown> };
    };
    if (!nav.gpu) return "wasm";
    const adapter = await nav.gpu.requestAdapter();
    return adapter ? "webgpu" : "wasm";
  } catch {
    return "wasm";
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { type, id, payload } = e.data as {
    type: string;
    id: string;
    payload: Record<string, unknown>;
  };

  // ── LOAD ────────────────────────────────────────────────────────────────────
  if (type === "load") {
    try {
      const device = await resolveDevice();

      generator = await pipeline("text-generation", MODEL_ID, {
        device,
        dtype: DTYPE,
        progress_callback: (progress: Record<string, unknown>) => {
          self.postMessage({ type: "progress", id, payload: progress });
        },
      });

      self.postMessage({
        type: "loaded",
        id,
        payload: { model: MODEL_ID, device, dtype: DTYPE },
      });
    } catch (err) {
      self.postMessage({
        type: "error",
        id,
        payload: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // ── GENERATE ─────────────────────────────────────────────────────────────────
  if (type === "generate") {
    if (!generator) {
      self.postMessage({ type: "error", id, payload: "Model not loaded" });
      return;
    }

    try {
      const { messages, max_new_tokens = 512 } = payload as {
        messages: Array<{ role: string; content: string }>;
        max_new_tokens?: number;
        tools?: unknown[];
      };

      // TextStreamer streams decoded tokens back to the main thread as they
      // are generated. skip_prompt suppresses echoing the input messages.
      const streamer = new TextStreamer(
        (generator as unknown as { tokenizer: any }).tokenizer,
        {
          skip_prompt: true,
          skip_special_tokens: true,
          callback_function: (token: string) => {
            self.postMessage({ type: "token", id, payload: token });
          },
        },
      );

      const output = (await generator(messages, {
        max_new_tokens,
        do_sample: false,
        streamer,
      })) as Array<{ generated_text: unknown[] }>;

      // Send the final structured result (last message in the conversation).
      const last = output?.[0]?.generated_text?.at(-1) ?? null;
      self.postMessage({ type: "result", id, payload: last });
    } catch (err) {
      self.postMessage({
        type: "error",
        id,
        payload: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
};
