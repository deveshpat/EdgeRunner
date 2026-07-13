"use client";

import { useState } from "react";

import type { KaggleState } from "@/lib/kaggle";
import type { UseKaggle } from "@/lib/useKaggle";

export const STATE_LABEL: Record<KaggleState, string> = {
  idle: "off",
  pushing: "pushing…",
  provisioning: "starting…",
  online: "online",
  stopped: "off",
  failed: "failed",
};

export const STATE_COLOR: Record<KaggleState, string> = {
  idle: "text-term-dim",
  pushing: "text-term-amber",
  provisioning: "text-term-amber",
  online: "text-term-green",
  stopped: "text-term-dim",
  failed: "text-term-red",
};

export function KaggleControl({ kaggle }: { kaggle: UseKaggle }) {
  const [username, setUsername] = useState("");
  const [key, setKey] = useState("");
  const [accelerator, setAccelerator] = useState("cpu");
  const [showLogs, setShowLogs] = useState(false);

  const { status, reachable, state, publicUrl, busy, error } = kaggle;
  const configured = status?.configured ?? false;

  return (
    <div className="mt-3 space-y-2 rounded border border-term-border bg-term-panel/40 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="uppercase tracking-wider text-term-dim">
          kaggle backend
        </span>
        <span className={STATE_COLOR[state]}>● {STATE_LABEL[state]}</span>
      </div>

      {!reachable && (
        <p className="text-term-red">
          ! orchestrator offline — run the backend locally (uvicorn app.main:app).
        </p>
      )}

      {!configured ? (
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
            Sent only to your local orchestrator and held in memory — never
            written to disk or sent anywhere external.
          </p>
          <button
            disabled={busy || !username || !key || !reachable}
            onClick={() => kaggle.configure(username.trim(), key.trim())}
            className="rounded border border-term-border px-2 py-1 text-term-green
                       hover:border-term-green disabled:opacity-30"
          >
            connect
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label className="text-term-dim">accelerator</label>
            <select
              value={accelerator}
              disabled={state === "online" || busy}
              onChange={(e) => setAccelerator(e.target.value)}
              className="rounded border border-term-border bg-term-bg px-2 py-1
                         text-term-fg focus:border-term-green focus:outline-none
                         disabled:opacity-50"
            >
              <option value="cpu">CPU</option>
              <option value="gpu">GPU (T4/P100)</option>
            </select>
            {state === "online" || state === "pushing" || state === "provisioning" ? (
              <button
                disabled={busy}
                onClick={kaggle.stop}
                className="rounded border border-term-border px-2 py-1 text-term-red
                           hover:border-term-red disabled:opacity-30"
              >
                ⏻ stop
              </button>
            ) : (
              <button
                disabled={busy}
                onClick={() => kaggle.start(accelerator)}
                className="rounded border border-term-border px-2 py-1 text-term-green
                           hover:border-term-green disabled:opacity-30"
              >
                ⏻ start
              </button>
            )}
          </div>

          {publicUrl && (
            <p className="break-all text-term-dim">
              tunnel: <span className="text-term-green">{publicUrl}</span>
            </p>
          )}

          {status?.session.logs_tail && (
            <div>
              <button
                onClick={() => setShowLogs((s) => !s)}
                className="text-term-dim hover:text-term-green"
              >
                {showLogs ? "▾ hide logs" : "▸ show logs"}
              </button>
              {showLogs && (
                <pre className="mt-1 max-h-40 overflow-auto rounded border border-term-border
                                bg-term-bg p-2 text-[10px] leading-snug text-term-dim">
                  {status.session.logs_tail}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

      {error && <p className="text-term-red">! {error}</p>}
    </div>
  );
}
