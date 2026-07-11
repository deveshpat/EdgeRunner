/**
 * OpenCode-inspired UI preferences (view, agent, display toggles).
 * Stored inside edgerunner prefs (localStorage) — never secrets.
 */

import type { StoredPrefs } from "./vault";
import { loadPrefs, savePrefs } from "./vault";

export type UiView = "cli" | "chat";
export type AgentMode = "build" | "plan";

export type UiPrefs = {
  uiView: UiView;
  agentMode: AgentMode;
  showThinking: boolean;
  showToolDetails: boolean;
  showTimestamps: boolean;
};

const DEFAULTS: UiPrefs = {
  uiView: "cli", // OpenCode is CLI-first; EdgeRunner defaults to terminal view
  agentMode: "build",
  showThinking: true,
  showToolDetails: true,
  showTimestamps: false,
};

export function loadUiPrefs(): UiPrefs {
  const p = loadPrefs() as StoredPrefs & Partial<UiPrefs>;
  return {
    uiView: p.uiView === "chat" ? "chat" : "cli",
    agentMode: p.agentMode === "plan" ? "plan" : "build",
    showThinking: p.showThinking !== false,
    showToolDetails: p.showToolDetails !== false,
    showTimestamps: p.showTimestamps === true,
  };
}

export function saveUiPrefs(patch: Partial<UiPrefs>): UiPrefs {
  const next = { ...loadUiPrefs(), ...patch };
  savePrefs({
    uiView: next.uiView,
    agentMode: next.agentMode,
    showThinking: next.showThinking,
    showToolDetails: next.showToolDetails,
    showTimestamps: next.showTimestamps,
  } as StoredPrefs);
  return next;
}
