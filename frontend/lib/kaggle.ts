// Client for the local orchestrator's Kaggle control endpoints.
// These always target the orchestrator (local), never the tunnel.

import { ORCHESTRATOR_URL } from "./api";

export type KaggleState =
  | "idle"
  | "pushing"
  | "provisioning"
  | "online"
  | "stopped"
  | "failed";

export interface KaggleSession {
  state: KaggleState;
  kernel_ref: string | null;
  public_url: string | null;
  error: string | null;
  logs_tail: string;
  accelerator: string;
  started_at: number | null;
  updated_at: number | null;
}

export interface KaggleStatus {
  configured: boolean;
  session: KaggleSession;
}

async function call(path: string, body?: unknown): Promise<KaggleStatus> {
  const resp = await fetch(`${ORCHESTRATOR_URL}/api/kaggle/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail = `${resp.status}`;
    try {
      detail = (await resp.json()).detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return resp.json();
}

export const getKaggleStatus = () => call("status");
export const configureKaggle = (username: string, key: string) =>
  call("config", { username, key });
export const startKaggle = (opts: { accelerator: string }) =>
  call("start", opts);
export const stopKaggle = () => call("stop", {});
