import { CreateWebWorkerMLCEngine } from "@mlc-ai/web-llm";

// We use Qwen 1.5B or Llama-3-8B specifically compiled for WebGPU
const MODEL_ID = "Qwen2-1.5B-Instruct-q4f16_1-MLC"; 

export async function initializeBrowserEngine(setLoadingText: (text: string) => void) {
  const engine = await CreateWebWorkerMLCEngine(
    new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
    MODEL_ID,
    {
      initProgressCallback: (progress) => {
        setLoadingText(progress.text); // e.g., "Downloading model... 45%"
      }
    }
  );
  return engine;
}