"use client";

import type { ReactNode } from "react";

export type HubAction = {
  id: string;
  title: string;
  description: string;
  icon: ReactNode;
  onClick: () => void;
  primary?: boolean;
  danger?: boolean;
};

/**
 * Grok / agent-style continue · new workspace gate.
 * Shown after auth, before the terminal session.
 */
export function SessionHub({
  actions,
  footnote,
}: {
  actions: HubAction[];
  footnote?: ReactNode;
}) {
  return (
    <div className="er-hub">
      <div className="er-hub-card">
        <div className="er-hub-head">
          <div className="er-logo" style={{ fontSize: "0.75rem" }}>
            WORKSPACE
          </div>
          <p className="text-[var(--muted)] text-xs mt-1 leading-relaxed">
            Continue where you left off, or open a clean terminal session.
          </p>
        </div>
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={a.onClick}
            className={`er-hub-action ${a.primary ? "primary" : ""} ${
              a.danger ? "danger" : ""
            }`}
          >
            <span className="icon" aria-hidden>
              {a.icon}
            </span>
            <span>
              <span className="title block">{a.title}</span>
              <span className="desc block">{a.description}</span>
            </span>
          </button>
        ))}
      </div>
      {footnote ? (
        <div className="mt-3 text-center text-[11px] text-[var(--dim)]">
          {footnote}
        </div>
      ) : null}
    </div>
  );
}
