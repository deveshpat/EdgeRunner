export type Message = {
  role: "user" | "assistant" | "system";
  content: string;
  thoughts?: string[];
  ts?: number;
};

/** cpu | generic gpu | dual T4 (maps to T4 API) | single T4 | P100 */
export type Accelerator = "cpu" | "gpu" | "t4x2" | "t4" | "p100";

/**
 * Official SaveKernel machineShape values (kagglesdk ApiSaveKernelRequest):
 *   NvidiaTeslaT4 | NvidiaTeslaP100 | Tpu1VmV38
 *
 * Undocumented dual-T4 names are ignored or rejected → Kaggle falls back to
 * enableGpu defaults (P100). Only send official enums.
 */
export const KAGGLE_SHAPE_T4 = "NvidiaTeslaT4";
export const KAGGLE_SHAPE_P100 = "NvidiaTeslaP100";

/** Primary official shape for an accelerator choice. */
export function kaggleMachineShape(acc: Accelerator): string | undefined {
  switch (acc) {
    case "t4x2":
    case "t4":
    case "gpu":
      return KAGGLE_SHAPE_T4;
    case "p100":
      return KAGGLE_SHAPE_P100;
    default:
      return undefined;
  }
}

/**
 * Shapes to try in order. T4 requests never include P100 and never omit shape
 * (omitting shape + enableGpu → P100 on most accounts).
 */
export function kaggleMachineShapesToTry(acc: Accelerator): string[] {
  switch (acc) {
    case "t4x2":
    case "t4":
    case "gpu":
      return [KAGGLE_SHAPE_T4];
    case "p100":
      return [KAGGLE_SHAPE_P100];
    default:
      return [];
  }
}

/** True when user asked for any T4-class GPU (not P100, not CPU). */
export function wantsT4(acc: Accelerator): boolean {
  return acc === "t4" || acc === "t4x2" || acc === "gpu";
}

export function acceleratorFromMachineShape(
  shape: string | undefined
): Accelerator | undefined {
  if (!shape) return undefined;
  const s = shape.toLowerCase();
  if (s.includes("t4") && (s.includes("x2") || s.includes("2"))) return "t4x2";
  if (s.includes("t4")) return "t4";
  if (s.includes("p100")) return "p100";
  return undefined;
}

/** Infer GPU type from worker logs (nvidia-smi / torch). */
export function acceleratorFromLogs(logs: string): Accelerator | undefined {
  const t = logs || "";
  if (/Tesla\s*T4\s*x\s*2|T4\s*x2|2\s*x\s*Tesla\s*T4|NVIDIA.*T4.*T4/i.test(t)) {
    return "t4x2";
  }
  if (/Tesla\s*T4|NVIDIA\s*T4|GPU.*T4|NvidiaTeslaT4/i.test(t)) return "t4";
  if (/Tesla\s*P100|NVIDIA\s*P100|GPU.*P100|NvidiaTeslaP100/i.test(t))
    return "p100";
  return undefined;
}

/** Whether an attached session's GPU matches what the user selected. */
export function acceleratorMatchesRequest(
  requested: Accelerator,
  actual: Accelerator | undefined
): boolean {
  if (requested === "cpu") return actual === "cpu" || actual === undefined;
  if (requested === "p100") return actual === "p100";
  // t4 / t4x2 / gpu → accept any T4-class, reject P100
  if (wantsT4(requested)) {
    if (!actual) return false; // unknown — don't assume OK when user wants T4
    return actual === "t4" || actual === "t4x2" || actual === "gpu";
  }
  return true;
}

export function isGpuAccelerator(acc: Accelerator): boolean {
  return acc !== "cpu";
}

export type ConnectionMode = "setup" | "local" | "kaggle";

export type SessionState =
  | "idle"
  | "packing"
  | "pushing"
  | "provisioning"
  | "online"
  | "failed"
  | "stopped";

export type SessionInfo = {
  id: string;
  username: string;
  kernel_ref: string;
  accelerator: Accelerator;
  state: SessionState;
  public_url: string | null;
  error: string | null;
  kernel_status: string | null;
  logs_tail: string;
  created_at: number;
  idle_timeout: number;
  max_lifetime: number;
};

export type KernelBundle = {
  version: number;
  bootstrap: string;
  files: Record<string, string>;
};

export type StoredPrefs = {
  username?: string;
  mode?: "local" | "kaggle";
  localBackendUrl?: string;
  accelerator?: Accelerator;
  idleTimeout?: number;
  maxLifetime?: number;
  lastBackendUrl?: string;
  lastKernelRef?: string;
  rememberCredentials?: boolean;
  vaultMode?: "device" | "passphrase";
  /** OpenCode-inspired UI prefs */
  uiView?: "cli" | "chat";
  agentMode?: "build" | "plan";
  showThinking?: boolean;
  showToolDetails?: boolean;
  showTimestamps?: boolean;
};

export type ModelOption = {
  repo_id: string;
  name: string;
  filename: string;
  file_size_gb: number;
  required_ram_gb: number;
  safe_ctx: number;
  sharded: boolean;
  fits: boolean;
  fit_status: string;
  recommended?: boolean;
};
