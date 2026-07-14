"use client";

import { useState } from "react";

import type { BackendStatus, UseBackend } from "@/lib/useBackend";

export const STATE_LABEL: Record<BackendStatus, string> = {
  off: "off",
  connecting: "connecting…",
  online: "online",
  error: "error",
};

export const STATE_COLOR: Record<BackendStatus, string> = {
  off: "text-term-dim",
  connecting: "text-term-yellow",
  online: "text-term-green",
  error: "text-term-red",
};

export function BackendControl({ backend }: { backend: UseBackend }) {
  const [draft, setDraft] = useState(backend.url);

  return (
    <div className="mt-3 space-y-2 border-t border-term-border pt-3 text-xs">
      <p className="text-term-dim">
        Run EdgeRunner on Kaggle (uvicorn + a cloudflared tunnel), then paste the
        tunnel URL below and hit connect.
      </p>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") backend.connect(draft);
          }}
          placeholder="https://something.trycloudflare.com"
          spellCheck={false}
          className="flex-1 rounded border border-term-border bg-term-panel px-2 py-1
                     text-term-fg placeholder:text-term-dim focus:border-term-green
                     focus:outline-none"
        />
        {backend.status === "online" ? (
          <button
            onClick={backend.disconnect}
            className="rounded border border-term-border px-3 py-1 text-term-red
                       hover:border-term-red"
          >
            disconnect
          </button>
        ) : (
          <button
            onClick={() => backend.connect(draft)}
            disabled={backend.status === "connecting"}
            className="rounded border border-term-border px-3 py-1 text-term-green
                       hover:border-term-green disabled:opacity-40"
          >
            connect
          </button>
        )}
      </div>
      <p className={STATE_COLOR[backend.status]}>
        {backend.status === "online"
          ? `● connected to ${backend.url}`
          : backend.status === "connecting"
            ? "connecting…"
            : backend.error
              ? `! ${backend.error}`
              : "not connected"}
      </p>
    </div>
  );
}
