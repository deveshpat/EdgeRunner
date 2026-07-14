// Loads the prebuilt Kaggle worker template (public/kernel-bundle.json, generated
// from the backend at build time) and renders it for a launch by substituting
// the per-session CONFIG.

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

let cache: string | null = null;

export async function loadWorkerTemplate(): Promise<string> {
  if (cache) return cache;
  const res = await fetch(`${BASE}/kernel-bundle.json`);
  if (!res.ok) {
    throw new Error(
      `Could not load kernel bundle (${res.status}). Rebuild the site so ` +
        `public/kernel-bundle.json exists.`,
    );
  }
  const data = (await res.json()) as { worker?: string };
  if (!data.worker) throw new Error("kernel bundle missing 'worker'");
  cache = data.worker;
  return cache;
}

export interface WorkerConfig {
  gpu: boolean;
  cuda: string;
  model_repo: string;
  model_file: string;
  idle_timeout: number;
  max_lifetime: number;
  startup_grace: number;
  /** HF read token — anon GGUF downloads from Kaggle IPs are 403'd. */
  hf_token: string;
}

export function renderWorker(template: string, config: WorkerConfig): string {
  // Function replacement avoids `$` in JSON being treated as a special token.
  return template.replace("__CONFIG__", () => JSON.stringify(config));
}
