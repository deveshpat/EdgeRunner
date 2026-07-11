export type Message = {
  role: "user" | "assistant" | "system";
  content: string;
  thoughts?: string[];
  ts?: number;
};

/** cpu | generic gpu | dual T4 (preferred) | single T4 | P100 */
export type Accelerator = "cpu" | "gpu" | "t4x2" | "t4" | "p100";

/**
 * Official SaveKernel `machineShape` values (kagglesdk ApiSaveKernelRequest):
 *   NvidiaTeslaT4 | NvidiaTeslaP100 | Tpu1VmV38
 *
 * Dual T4 is NOT in the public enum. Bare enableGpu without machineShape
 * defaults to P100 on many accounts — never use that as a silent fallback
 * when the user asked for T4.
 */
export function kaggleMachineShape(acc: Accelerator): string | undefined {
  switch (acc) {
    case "t4x2":
    case "t4":
    case "gpu":
      return "NvidiaTeslaT4";
    case "p100":
      return "NvidiaTeslaP100";
    default:
      return undefined;
  }
}

/**
 * Shapes to try in order for SaveKernel.
 * Do NOT append a "no shape" attempt for T4 selections — that becomes P100.
 */
export function kaggleMachineShapesToTry(acc: Accelerator): string[] {
  switch (acc) {
    case "t4x2":
      // Prefer dual if Kaggle accepts undocumented names; else official single T4
      return ["NvidiaTeslaT4x2", "NvidiaTeslaT4X2", "NvidiaTeslaT4"];
    case "t4":
      return ["NvidiaTeslaT4"];
    case "p100":
      return ["NvidiaTeslaP100"];
    case "gpu":
      // Generic "gpu": T4 first (not P100)
      return ["NvidiaTeslaT4x2", "NvidiaTeslaT4", "NvidiaTeslaP100"];
    default:
      return [];
  }
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
  if (/Tesla\s*T4|NVIDIA.*T4|GPU.*T4/i.test(t)) return "t4";
  if (/Tesla\s*P100|NVIDIA.*P100|GPU.*P100/i.test(t)) return "p100";
  return undefined;
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
