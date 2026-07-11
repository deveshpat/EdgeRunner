import type { Accelerator, KernelBundle } from "./types";

const BASE =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_BASE_PATH) ||
  "";

let cached: KernelBundle | null = null;

export async function loadKernelBundle(): Promise<KernelBundle> {
  if (cached) return cached;
  const url = `${BASE}/kernel-bundle.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to load kernel bundle from ${url} (${res.status}). Rebuild the site so public/kernel-bundle.json is present.`
    );
  }
  cached = (await res.json()) as KernelBundle;
  return cached;
}

export function renderWorkerSource(opts: {
  bundle: KernelBundle;
  sessionId: string;
  accelerator: Accelerator;
  idleTimeout: number;
  maxLifetime: number;
  startupGrace?: number;
}): string {
  const {
    bundle,
    sessionId,
    accelerator,
    idleTimeout,
    maxLifetime,
    startupGrace = 600,
  } = opts;

  let bootstrap = bundle.bootstrap;

  // Quoted + bare placeholders (matches orchestrator/packer.py)
  const pairs: [string, string][] = [
    ["__SESSION_ID__", sessionId],
    // Worker only needs cpu vs gpu for wheel selection; map shapes → gpu
    [
      "__ACCELERATOR__",
      accelerator === "cpu" ? "cpu" : "gpu",
    ],
    ["__IDLE_TIMEOUT__", String(idleTimeout)],
    ["__MAX_LIFETIME__", String(maxLifetime)],
    ["__STARTUP_GRACE__", String(startupGrace)],
  ];
  for (const [token, value] of pairs) {
    bootstrap = bootstrap.split(`"${token}"`).join(JSON.stringify(value));
    bootstrap = bootstrap.split(token).join(value);
  }

  const filesLiteral = JSON.stringify(bundle.files, null, 2);
  const needles = [
    "FILES: dict[str, str] = {}",
    "FILES = {}",
    "FILES: dict = {}",
  ];
  let replaced = false;
  for (const needle of needles) {
    if (bootstrap.includes(needle)) {
      bootstrap = bootstrap.replace(
        needle,
        `FILES: dict[str, str] = ${filesLiteral}`
      );
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    throw new Error("Could not find FILES placeholder in bootstrap template");
  }
  return bootstrap;
}

export function newSessionId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join("");
}

/** Stable Kaggle notebook slug — one notebook per user, not a new one each launch. */
export const STABLE_KERNEL_SLUG = "edgerunner";

export function kernelSlug(_sessionId?: string): string {
  return STABLE_KERNEL_SLUG;
}

export const STABLE_KERNEL_TITLE = "EdgeRunner";

