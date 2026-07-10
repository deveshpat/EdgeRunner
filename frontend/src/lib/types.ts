export type Message = {
  role: "user" | "assistant" | "system";
  content: string;
  thoughts?: string[];
  ts?: number;
};

export type Accelerator = "cpu" | "gpu";

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
