// localStorage-backed conversation store.
//
// The backend (on Kaggle, behind a tunnel) is ephemeral, so conversation
// history lives client-side. All access is guarded for SSR — on the server
// `window` is undefined and these become no-ops returning empty state.

import type { ChatMessage, ToolEvent } from "./api";

const KEY = "edgerunner.conversations";
const ACTIVE_KEY = "edgerunner.activeId";
const SETTINGS_KEY = "edgerunner.settings";
const HARNESS_KEY = "edgerunner.selectedHarness";
const MODEL_KEY = "edgerunner.selectedModel";

export interface Settings {
  temperature: number;
  maxTokens: number;
  topP: number;
}

export const DEFAULT_SETTINGS: Settings = {
  temperature: 0.7,
  maxTokens: 1024,
  topP: 0.95,
};

// Timing/throughput telemetry for one assistant response.
export interface MessageStats {
  tokens: number;
  ms: number;
}

// A transcript entry: a chat message plus any tool interactions the agentic
// harness emitted while producing it, and (for assistant turns) telemetry.
export interface DisplayMessage extends ChatMessage {
  tools?: ToolEvent[];
  stats?: MessageStats;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  harness: string;
  preset?: "code" | "standard" | "minimal" | "creator";
  parentId?: string;
  forkIndex?: number;
  messages: DisplayMessage[];
  createdAt: number;
  updatedAt: number;
  cwd?: string;
}

function hasStorage(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

export function loadConversations(): Conversation[] {
  if (!hasStorage()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Conversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveConversations(convos: Conversation[]): void {
  if (!hasStorage()) return;
  window.localStorage.setItem(KEY, JSON.stringify(convos));
}

export function loadActiveId(): string | null {
  if (!hasStorage()) return null;
  return window.localStorage.getItem(ACTIVE_KEY);
}

export function saveActiveId(id: string | null): void {
  if (!hasStorage()) return;
  if (id) window.localStorage.setItem(ACTIVE_KEY, id);
  else window.localStorage.removeItem(ACTIVE_KEY);
}

export function loadSettings(): Settings {
  if (!hasStorage()) return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings): void {
  if (!hasStorage()) return;
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function loadSelectedHarness(): string | null {
  if (!hasStorage()) return null;
  return window.localStorage.getItem(HARNESS_KEY);
}

export function saveSelectedHarness(harness: string): void {
  if (!hasStorage()) return;
  window.localStorage.setItem(HARNESS_KEY, harness);
}

export function loadSelectedModel(): string | null {
  if (!hasStorage()) return null;
  return window.localStorage.getItem(MODEL_KEY);
}

export function saveSelectedModel(model: string): void {
  if (!hasStorage()) return;
  window.localStorage.setItem(MODEL_KEY, model);
}

// crypto.randomUUID needs a secure context + iOS 15.4+; fall back otherwise.
function uuid(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newConversation(model: string, harness: string): Conversation {
  const now = Date.now();
  return {
    id: uuid(),
    title: "new session",
    model,
    harness,
    messages: [],
    createdAt: now,
    updatedAt: now,
    cwd: "/workspace",
  };
}

// Derive an intelligent, clean semantic title from the first user message.
export function titleFrom(messages: DisplayMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "new session";

  let clean = first.content.trim();

  // Strip code blocks and inline code
  clean = clean.replace(/```[\s\S]*?```/g, "").replace(/`[^`]+`/g, "");
  // Strip XML/HTML tags
  clean = clean.replace(/<[^>]+>/g, "");
  // Strip conversational noise prefixes
  clean = clean.replace(
    /^(can you|could you|please|help me with|help me|i want to|how do i|hey|hi|let's|lets)\s+/i,
    "",
  );
  clean = clean.replace(/\s+/g, " ").trim();

  if (!clean) {
    return "Session " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Capitalize first letter
  clean = clean.charAt(0).toUpperCase() + clean.slice(1);
  return clean.length > 45 ? clean.slice(0, 45) + "…" : clean;
}
