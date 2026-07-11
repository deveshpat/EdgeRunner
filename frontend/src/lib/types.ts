export type Message = {
  role: "user" | "assistant" | "system";
  content: string;
  thoughts?: string[];
  ts?: number;
};

/** cpu | generic gpu | dual T4 (preferred) | single T4 | P100 */
export type Accelerator = "cpu" | "gpu" | "t4x2" | "t4" | "p100";

/** Kaggle machine_shape values (kernel-metadata / SaveKernel). */
export function kaggleMachineShape(acc: Accelerator): string | undefined {
  switch (acc) {
    case "t4x2":
      // Dual T4 ≈ 2× VRAM/compute vs P100 on free tier when available
      return "NvidiaTeslaT4x2";
    case "t4":
      return "NvidiaTeslaT4";
    case "p100":
      return "NvidiaTeslaP100";
    case "gpu":
      // Prefer dual T4 when only "gpu" is selected
      return "NvidiaTeslaT4x2";
    default:
      return undefined;
  }
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
