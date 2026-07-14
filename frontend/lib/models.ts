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
    id: "qwen2.5-1.5b",
    label: "Qwen2.5 1.5B — fast",
    repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
    file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    note: "Snappiest cold start; good for quick tasks and tool use.",
  },
  {
    id: "qwen2.5-3b",
    label: "Qwen2.5 3B — balanced",
    repo: "Qwen/Qwen2.5-3B-Instruct-GGUF",
    file: "qwen2.5-3b-instruct-q4_k_m.gguf",
    note: "Solid all-rounder on CPU or GPU. Default.",
  },
  {
    id: "r1-qwen-1.5b",
    label: "DeepSeek-R1 Distill 1.5B — reasoning",
    repo: "bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF",
    file: "DeepSeek-R1-Distill-Qwen-1.5B-Q4_K_M.gguf",
    note: "Thinks before answering (shows reasoning). Best with the chat harness.",
  },
  {
    id: "r1-qwen-7b",
    label: "DeepSeek-R1 Distill 7B — reasoning (GPU)",
    repo: "bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF",
    file: "DeepSeek-R1-Distill-Qwen-7B-Q4_K_M.gguf",
    gpu: true,
    note: "Strongest reasoning here; needs the T4 GPU.",
  },
];

export const DEFAULT_MODEL_ID = "qwen2.5-3b";

export function modelById(id: string): LaunchModel {
  return LAUNCH_MODELS.find((m) => m.id === id) ?? LAUNCH_MODELS[1];
}
