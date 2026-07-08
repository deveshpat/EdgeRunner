import { pipeline } from "@huggingface/transformers";

let ttsPipeline: unknown = null;
let loadedModel = "";
let speakerEmbeddings: Float32Array | null = null;

const DEFAULT_MODEL = "Xenova/mms-tts-eng";
const SPEAKER_EMBEDDINGS_URL =
  "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin";

function float32ToWav(floatData: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + floatData.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + floatData.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, floatData.length * 2, true);

  let offset = 44;
  for (let i = 0; i < floatData.length; i += 1) {
    const value = Math.max(-1, Math.min(1, floatData[i]));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    offset += 2;
  }

  return buffer;
}

async function ensureSpeakerEmbeddings() {
  if (speakerEmbeddings) return;
  const res = await fetch(SPEAKER_EMBEDDINGS_URL);
  if (!res.ok) {
    throw new Error("Failed to fetch SpeechT5 speaker embeddings.");
  }
  const buffer = await res.arrayBuffer();
  const alignedByteLength = buffer.byteLength - (buffer.byteLength % 4);
  speakerEmbeddings = new Float32Array(buffer.slice(0, alignedByteLength));
}

self.onmessage = async (e: MessageEvent) => {
  const { type, id, model, text } = e.data as {
    type: string;
    id: string;
    model?: string;
    text?: string;
  };

  try {
    if (type === "init") {
      const selectedModel = model || DEFAULT_MODEL;
      if (!ttsPipeline || selectedModel !== loadedModel) {
        ttsPipeline = await pipeline("text-to-speech", selectedModel, {
          progress_callback: (progress: Record<string, unknown>) => {
            self.postMessage({ type: "progress", id, payload: progress });
          },
        });
        loadedModel = selectedModel;
      }
      self.postMessage({ type: "ready", id, payload: { model: loadedModel } });
      return;
    }

    if (type === "synthesize") {
      if (!ttsPipeline) {
        self.postMessage({ type: "error", id, payload: "TTS not initialized" });
        return;
      }
      if (!text?.trim()) {
        self.postMessage({ type: "error", id, payload: "Text is required" });
        return;
      }

      const needsSpeakerEmbeddings = /speecht5/i.test(loadedModel);
      if (needsSpeakerEmbeddings) {
        await ensureSpeakerEmbeddings();
      }

      const output = await (
        ttsPipeline as (
          input: string,
          options?: { speaker_embeddings: Float32Array },
        ) => Promise<{ audio: Float32Array; sampling_rate: number }>
      )(
        text,
        speakerEmbeddings ? { speaker_embeddings: speakerEmbeddings } : undefined,
      );

      const wav = float32ToWav(output.audio, output.sampling_rate);
      (self as unknown as { postMessage: (message: unknown, transfer?: Transferable[]) => void }).postMessage(
        { type: "audio", id, wav },
        [wav],
      );
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    self.postMessage({ type: "error", id, payload: msg });
  }
};
