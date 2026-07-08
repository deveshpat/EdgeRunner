const DEFAULT_MODEL =
  process.env.NEXT_PUBLIC_LOCAL_TTS_MODEL || "cstr/qwen3-tts-1.7b-customvoice-GGUF";
const CALL_TIMEOUT_MS = 120_000;

class TTSManager {
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL("../workers/tts.worker.ts", import.meta.url), {
        type: "module",
      });

      this.worker.onmessage = (e: MessageEvent) => {
        const data = e.data as {
          type: string;
          id: string;
          payload?: unknown;
          wav?: ArrayBuffer;
        };
        const pending = this.pending.get(data.id);
        if (!pending) return;

        if (data.type === "ready") {
          this.pending.delete(data.id);
          pending.resolve(null);
        }
        if (data.type === "audio") {
          this.pending.delete(data.id);
          pending.resolve(data.wav ?? null);
        }
        if (data.type === "error") {
          this.pending.delete(data.id);
          pending.reject(new Error(String(data.payload ?? "TTS error")));
        }
      };
    }

    return this.worker;
  }

  private call(type: string, payload: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TTS call timed out (${type})`));
      }, CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.getWorker().postMessage({ type, id, ...payload });
    });
  }

  async init(model: string = DEFAULT_MODEL): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.call("init", { model }) as Promise<void>;
    return this.initPromise;
  }

  async synthesize(text: string): Promise<Blob> {
    await this.init();
    const wav = (await this.call("synthesize", { text })) as ArrayBuffer;
    return new Blob([wav], { type: "audio/wav" });
  }
}

const manager = new TTSManager();

export const tts = {
  async synthesize(text: string): Promise<Blob> {
    return manager.synthesize(text);
  },
};
