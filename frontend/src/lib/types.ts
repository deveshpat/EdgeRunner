export type Message = {
  role: "user" | "assistant";
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
  /** Remember last attached backend URL (not secrets). */
  lastBackendUrl?: string;
};
