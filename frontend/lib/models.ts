// Curated models the user can launch on Kaggle. Each is a single-file GGUF
// (verified on the HF Hub). Reasoning models (R1 distills) pair with the
// <think> rendering; big ones want a GPU.

export interface LaunchModel {
  id: string;
  label: string;
  repo: string;
  file: string;
  /** Recommend/needs a GPU (too big or slow for CPU). */
  gpu?: boolean;
  note: string;
}

export const LAUNCH_MODELS: LaunchModel[] = [
  {
    id: "deepseek-v4-pro-4b",
    label: "DeepSeek-V4 Pro 4B [SOTA REASONING EDGE CORE]",
    repo: "mradermacher/DeepSeek-V4-Pro-Qwen3.5-4B-GGUF",
    file: "DeepSeek-V4-Pro-Qwen3.5-4B.Q4_K_M.gguf",
    note: "Distilled from DeepSeek-V4-Pro; ultra-fast 2026 frontier reasoning on CPU or GPU edge nodes.",
  },
  {
    id: "deepseek-v4-pro-9b",
    label: "DeepSeek-V4 Pro 9B [SOTA REASONING PAYLOAD]",
    repo: "mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-GGUF",
    file: "DeepSeek-V4-Pro-Qwen3.5-9B.Q4_K_M.gguf",
    gpu: true,
    note: "High-precision DeepSeek-V4-Pro reasoning engine (~5.5 GB) fitting 100% in 16GB VRAM.",
  },
  {
    id: "qwen3.5-4b",
    label: "Qwen3.5 4B [FAST DEFAULT EDGE CORE]",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    file: "Qwen3.5-4B-Q4_K_M.gguf",
    note: "Ultra-responsive 2026 default core (~2.6 GB) for rapid prompt synthesis on CPU or GPU edge nodes.",
  },
  {
    id: "qwen3.8-27b",
    label: "Qwen3.8 27B [ALIBABA SOTA OPEN-WEIGHTS]",
    repo: "unsloth/Qwen3.8-27B-GGUF",
    file: "Qwen3.8-27B-Q4_K_M.gguf",
    gpu: true,
    note: "Released August 14, 2026; Alibaba's flagship open-weights payload for local & edge nodes.",
  },
  {
    id: "qwen3-coder-30b",
    label: "Qwen3 Coder 30B [SOTA CODE & AGENT]",
    repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
    file: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
    gpu: true,
    note: "Alibaba's 2026 flagship coding engine with 10M+ downloads for autonomous coding and tools.",
  },
  {
    id: "qwen3.5-9b",
    label: "Qwen3.5 9B [ALL-ROUNDER PAYLOAD]",
    repo: "unsloth/Qwen3.5-9B-GGUF",
    file: "Qwen3.5-9B-Q4_K_M.gguf",
    gpu: true,
    note: "High-capability 9B model that fits 100% in 16GB VRAM at peak token generation speed.",
  },
  {
    id: "gemma-4-26b",
    label: "Gemma 4 26B [GOOGLE OPEN SOTA]",
    repo: "unsloth/gemma-4-26B-A4B-it-GGUF",
    file: "gemma-4-26B-A4B-it-MXFP4_MOE.gguf",
    gpu: true,
    note: "Google's 2026 flagship Gemma 4 MoE architecture; high speed and multimodal reasoning.",
  },
  {
    id: "bonsai-27b",
    label: "Bonsai 27B [PRISM ML REASONING]",
    repo: "prism-ml/Bonsai-27B-gguf",
    file: "Bonsai-27B-dspark-Q4_1.gguf",
    gpu: true,
    note: "DSpark-quantized 27B model for high throughput and agentic memory tasks.",
  },
  {
    id: "laguna-xs-2.1",
    label: "Laguna XS 2.1 [APEX COMPACT]",
    repo: "mudler/Laguna-XS-2.1-APEX-GGUF",
    file: "Laguna-XS-2.1-APEX-Compact.gguf",
    gpu: true,
    note: "High-performance compact apex architecture for low-latency edge deployment.",
  },
  {
    id: "qwen3.5-4b-q8",
    label: "Qwen3.5 4B Q8 [HIGH-PRECISION 4B]",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    file: "Qwen3.5-4B-Q8_0.gguf",
    note: "Full 8-bit uncompressed precision 4B model for highest accuracy outputs.",
  },
];

export const DEFAULT_MODEL_ID = "qwen3.5-4b";

export function modelById(id: string): LaunchModel {
  const found = LAUNCH_MODELS.find(
    (m) =>
      m.id === id ||
      m.file === id ||
      m.file.replace(/\.gguf$/i, "") === id ||
      m.label === id,
  );
  if (found) return found;

  const cleanFile = id.endsWith(".gguf") ? id : `${id}.gguf`;
  return {
    id,
    label: id,
    repo: id.includes("/") ? id.split(":")[0] : "unsloth/Qwen3.5-4B-GGUF",
    file: cleanFile,
    note: "Custom selected neural payload",
  };
}
