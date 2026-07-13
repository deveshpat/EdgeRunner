"use client";

import { useState } from "react";

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
  const [showLogs, setShowLogs] = useState(false);
  const [editing, setEditing] = useState(false);
  const { accelerator, setAccelerator } = kaggle;

  const { configured, state, publicUrl, logs, busy, error } = kaggle;
  const showForm = !configured || editing;
  const running = BUSY_STATES.includes(state);

  function beginEdit() {
    setUsername(kaggle.username ?? "");
    setKey("");
    setEditing(true);
  }

  async function connect() {
    const ok = await kaggle.saveCreds(username.trim(), key.trim());
    if (ok) {
      setKey("");
      setEditing(false);
    }
  }

  return (
    <div className="mt-3 space-y-2 rounded border border-term-border bg-term-panel/40 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="uppercase tracking-wider text-term-dim">kaggle backend</span>
        <span className={STATE_COLOR[state]}>● {STATE_LABEL[state]}</span>
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
            API token (KGAT_…) or legacy key from kaggle.com → Settings → API →
            Create New Token. Stored encrypted in this browser (IndexedDB) and
            sent only to Kaggle over HTTPS — it never touches our servers or
            leaves your device.
          </p>
          <div className="flex gap-2">
            <button
              disabled={busy || !username || !key}
              onClick={connect}
              className="rounded border border-term-border px-2 py-1 text-term-green
                         hover:border-term-green disabled:opacity-30"
            >
              {busy ? "checking…" : configured ? "save" : "connect"}
            </button>
            {configured && (
              <button
                disabled={busy}
                onClick={() => setEditing(false)}
                className="rounded border border-term-border px-2 py-1 text-term-dim
                           hover:text-term-fg"
              >
                cancel
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-term-dim">
            <span>
              connected as{" "}
              <span className="text-term-green">{kaggle.username}</span>
            </span>
            <button
              disabled={running}
              onClick={beginEdit}
              className="underline hover:text-term-green disabled:opacity-30
                         disabled:no-underline"
            >
              change
            </button>
            <button
              disabled={running}
              onClick={kaggle.forget}
              className="hover:text-term-red disabled:opacity-30"
            >
              forget
            </button>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-term-dim">accelerator</label>
            <select
              value={accelerator}
              disabled={running || busy}
              onChange={(e) => setAccelerator(e.target.value)}
              className="rounded border border-term-border bg-term-bg px-2 py-1
                         text-term-fg focus:border-term-green focus:outline-none
                         disabled:opacity-50"
            >
              <option value="cpu">CPU</option>
              <option value="gpu">GPU (T4)</option>
            </select>
            {running ? (
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
                onClick={() => kaggle.start()}
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

          {logs && (
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
                  {logs}
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
