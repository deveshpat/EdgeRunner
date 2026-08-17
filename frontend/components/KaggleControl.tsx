"use client";

import { useState } from "react";

import { LAUNCH_MODELS, modelById } from "@/lib/models";
import type { KaggleState, UseKaggle } from "@/lib/useKaggle";

export const STATE_LABEL: Record<KaggleState, string> = {
  idle: "off",
  packing: "packing…",
  pushing: "pushing…",
  provisioning: "starting…",
  online: "online",
  stopped: "off",
  failed: "failed",
};

export const STATE_COLOR: Record<KaggleState, string> = {
  idle: "text-term-dim",
  packing: "text-term-amber",
  pushing: "text-term-amber",
  provisioning: "text-term-amber",
  online: "text-term-green",
  stopped: "text-term-dim",
  failed: "text-term-red",
};

const BUSY_STATES: KaggleState[] = ["packing", "pushing", "provisioning", "online"];

export function KaggleControl({ kaggle }: { kaggle: UseKaggle }) {
  const [username, setUsername] = useState("");
  const [key, setKey] = useState("");
  const [hf, setHf] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [editing, setEditing] = useState(false);
  const { accelerator, setAccelerator } = kaggle;

  const { configured, state, publicUrl, logs, busy, error } = kaggle;
  const showForm = !configured || editing;
  const running = BUSY_STATES.includes(state);

  function beginEdit() {
    setUsername(kaggle.username ?? "");
    setKey("");
    setHf(kaggle.hfToken ?? "");
    setEditing(true);
  }

  async function connect() {
    const ok = await kaggle.saveCreds(username.trim(), key.trim(), hf.trim());
    if (ok) {
      setKey("");
      setEditing(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded border border-term-border bg-term-panel/40 p-3 text-xs font-mono">
      <div className="flex items-center justify-between">
        <span className="uppercase tracking-wider text-term-dim">// KAGGLE COMPUTE</span>
        <span className={STATE_COLOR[state]}>[{STATE_LABEL[state].toUpperCase()}]</span>
      </div>

      {showForm ? (
        <div className="space-y-2">
          <input
            className="w-full rounded border border-term-border bg-term-bg px-2 py-1
                       text-term-fg placeholder:text-term-dim focus:border-term-green
                       focus:outline-none"
            placeholder="kaggle username"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            className="w-full rounded border border-term-border bg-term-bg px-2 py-1
                       text-term-fg placeholder:text-term-dim focus:border-term-green
                       focus:outline-none"
            placeholder="kaggle api key"
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <p className="text-[10px] text-term-dim">
            API token (KGAT_…) or legacy key from kaggle.com :: Settings :: API ::
            Create New Token. Stored encrypted on-device.
          </p>
          <input
            className="w-full rounded border border-term-border bg-term-bg px-2 py-1
                       text-term-fg placeholder:text-term-dim focus:border-term-green
                       focus:outline-none"
            placeholder="hugging face token (hf_…)"
            type="password"
            autoComplete="off"
            value={hf}
            onChange={(e) => setHf(e.target.value)}
          />
          <p className="text-[10px] text-term-dim">
            HF read token from huggingface.co :: Settings :: Access Tokens. Enables fast unthrottled downloads.
          </p>
          <div className="flex gap-2">
            <button
              disabled={busy || !username || !key}
              onClick={connect}
              className="flex items-center gap-1 rounded border border-term-green/60 bg-term-green/10 px-3 py-1 text-term-green
                         hover:border-term-green hover:bg-term-green/20 disabled:opacity-30 transition-colors font-semibold"
            >
              {busy ? "Checking…" : configured ? "Save" : "Connect"}
            </button>
            {configured && (
              <button
                disabled={busy}
                onClick={() => setEditing(false)}
                className="flex items-center gap-1 rounded border border-term-border px-3 py-1 text-term-dim
                           hover:text-term-fg hover:border-term-dim transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-term-dim">
            <span>
              OPERATOR:{" "}
              <span className="text-term-green">@{kaggle.username}</span>
            </span>
            <button
              disabled={running}
              onClick={beginEdit}
              className="flex items-center gap-0.5 hover:text-term-green disabled:opacity-30 transition-colors"
            >
              [edit]
            </button>
            <button
              disabled={running}
              onClick={kaggle.forget}
              className="flex items-center gap-0.5 hover:text-term-red disabled:opacity-30 transition-colors"
            >
              [forget]
            </button>
          </div>

          <p className="text-[10px] text-term-dim">{modelById(kaggle.launchModel).note}</p>
          {modelById(kaggle.launchModel).gpu && accelerator !== "gpu" && (
            <p className="text-[10px] text-term-amber">
              GPU recommended for this payload — select GPU (T4) before deployment.
            </p>
          )}

          <div className="flex items-center gap-2">
            <label className="text-term-dim text-[11px] font-semibold">ACCELERATOR</label>
            <select
              value={accelerator}
              disabled={running || busy}
              onChange={(e) => setAccelerator(e.target.value)}
              className="rounded border border-term-border bg-term-bg px-2 py-1
                         text-term-fg focus:border-term-green focus:outline-none
                         disabled:opacity-50 text-xs"
            >
              <option value="cpu">CPU</option>
              <option value="gpu">NVIDIA GPU (T4)</option>
            </select>
            {running ? (
              <button
                disabled={busy}
                onClick={kaggle.stop}
                className="flex items-center gap-1 rounded border border-term-red/60 bg-term-red/10 px-2.5 py-1 text-term-red
                           hover:border-term-red hover:bg-term-red/20 disabled:opacity-30 transition-colors text-xs font-semibold"
              >
                STOP
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() => kaggle.start()}
                className="flex items-center gap-1 rounded border border-term-green/60 bg-term-green/10 px-2.5 py-1 text-term-green
                           hover:border-term-green hover:bg-term-green/20 disabled:opacity-30 transition-colors text-xs font-semibold shadow-[0_0_8px_rgba(62,207,92,0.15)]"
              >
                START
              </button>
            )}
          </div>

          {publicUrl && (
            <p className="break-all text-term-dim text-[11px]">
              TUNNEL: <span className="text-term-green font-mono">{publicUrl}</span>
            </p>
          )}

          {logs && (
            <div>
              <button
                onClick={() => setShowLogs((s) => !s)}
                className="text-term-dim hover:text-term-green text-[11px] transition-colors"
              >
                {showLogs ? "▾ Hide Telemetry Logs" : "▸ Show Telemetry Logs"}
              </button>
              {showLogs && (
                <pre className="mt-1 max-h-40 overflow-auto rounded border border-term-border
                                bg-term-bg p-2 text-[10px] leading-snug text-term-dim font-mono">
                  {logs}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {error && <p className="text-term-red text-xs">⚠ {error}</p>}
    </div>
  );
}
