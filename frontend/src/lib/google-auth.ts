/**
 * Google Sign-In via full-page OAuth redirect (the normal Google login page).
 *
 * Vault encryption / Drive sync stay automatic in the background — the user
 * only clicks "Sign in with Google".
 */

import { loadConfig } from "./config";

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.appdata",
].join(" ");

const TOKEN_KEY = "edgerunner_google_token";
const USER_KEY = "edgerunner_google_user";
const STATE_KEY = "edgerunner_oauth_state";

export type GoogleUser = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
};

let accessToken: string | null = null;
let tokenExpiresAt = 0;
let currentUser: GoogleUser | null = null;

const listeners = new Set<() => void>();

export function onGoogleAuthChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit() {
  listeners.forEach((cb) => {
    try {
      cb();
    } catch {
      /* ignore */
    }
  });
}

function redirectUri(): string {
  // Must match Authorized redirect URIs in Google Cloud Console exactly
  const base = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
  return `${window.location.origin}${base}/`;
}

function persistSession(token: string, expiresIn: number, user: GoogleUser) {
  accessToken = token;
  tokenExpiresAt = Date.now() + Math.max(60, expiresIn) * 1000;
  currentUser = user;
  try {
    sessionStorage.setItem(
      TOKEN_KEY,
      JSON.stringify({ token, exp: tokenExpiresAt })
    );
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
  emit();
}

function restoreFromStorage(): void {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (raw) {
      const j = JSON.parse(raw) as { token?: string; exp?: number };
      if (j.token && j.exp && Date.now() < j.exp - 30_000) {
        accessToken = j.token;
        tokenExpiresAt = j.exp;
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const u = localStorage.getItem(USER_KEY);
    if (u) currentUser = JSON.parse(u) as GoogleUser;
  } catch {
    /* ignore */
  }
}

async function fetchUserInfo(token: string): Promise<GoogleUser> {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Google userinfo failed (${res.status})`);
  const j = (await res.json()) as {
    sub: string;
    email?: string;
    name?: string;
    picture?: string;
  };
  if (!j.sub) throw new Error("Google userinfo missing sub");
  return {
    sub: j.sub,
    email: j.email || "",
    name: j.name || j.email || "Google user",
    picture: j.picture,
  };
}

/**
 * Parse #access_token=… from Google OAuth implicit redirect and clean the URL.
 */
export async function consumeOAuthRedirect(): Promise<{
  handled: boolean;
  user?: GoogleUser;
  error?: string;
}> {
  if (typeof window === "undefined") return { handled: false };

  const hash = window.location.hash.replace(/^#/, "");
  if (!hash.includes("access_token") && !hash.includes("error")) {
    restoreFromStorage();
    return { handled: false };
  }

  const params = new URLSearchParams(hash);
  // Clean hash immediately so refresh doesn't re-process
  const clean =
    window.location.pathname + window.location.search;
  window.history.replaceState({}, document.title, clean);

  if (params.get("error")) {
    return {
      handled: true,
      error: params.get("error_description") || params.get("error") || "denied",
    };
  }

  const token = params.get("access_token");
  const expiresIn = Number(params.get("expires_in") || "3600");
  const state = params.get("state");
  if (!token) return { handled: true, error: "No access token from Google" };

  try {
    const expected = sessionStorage.getItem(STATE_KEY);
    if (expected && state && expected !== state) {
      return { handled: true, error: "OAuth state mismatch — try again" };
    }
    sessionStorage.removeItem(STATE_KEY);
  } catch {
    /* ignore */
  }

  try {
    const user = await fetchUserInfo(token);
    persistSession(token, expiresIn, user);
    return { handled: true, user };
  } catch (e) {
    return {
      handled: true,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function isGoogleConfigured(): Promise<boolean> {
  const cfg = await loadConfig();
  return (
    !!cfg.googleClientId &&
    cfg.googleClientId.includes(".apps.googleusercontent.com")
  );
}

export function getGoogleUser(): GoogleUser | null {
  return currentUser;
}

export function isGoogleSignedIn(): boolean {
  restoreFromStorage();
  return !!(
    accessToken &&
    currentUser &&
    Date.now() < tokenExpiresAt - 30_000
  );
}

export async function getAccessToken(): Promise<string | null> {
  restoreFromStorage();
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) return accessToken;
  return null;
}

export async function initGoogleAuth(): Promise<{ configured: boolean }> {
  const cfg = await loadConfig();
  restoreFromStorage();
  // If we have a token, refresh profile lightly
  if (accessToken && !currentUser) {
    try {
      currentUser = await fetchUserInfo(accessToken);
      try {
        localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
      } catch {
        /* ignore */
      }
    } catch {
      accessToken = null;
    }
  }
  return { configured: !!cfg.googleClientId };
}

/**
 * Full-page redirect to Google's sign-in page (what people expect).
 * Does not return — browser leaves the app.
 */
export async function signInWithGoogleRedirect(): Promise<void> {
  const cfg = await loadConfig();
  if (!cfg.googleClientId) {
    throw new Error(
      "Google sign-in is not set up yet. The site owner must add a Google Client ID."
    );
  }
  const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    sessionStorage.setItem(STATE_KEY, state);
  } catch {
    /* ignore */
  }

  const params = new URLSearchParams({
    client_id: cfg.googleClientId,
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: SCOPES,
    include_granted_scopes: "true",
    state,
    prompt: "select_account",
  });

  window.location.assign(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  );
}

/** @deprecated use signInWithGoogleRedirect — kept for call sites that await */
export async function signInWithGoogle(): Promise<{
  user: GoogleUser;
  accessToken: string;
}> {
  // If already signed in, return session
  restoreFromStorage();
  if (accessToken && currentUser && Date.now() < tokenExpiresAt - 30_000) {
    return { user: currentUser, accessToken };
  }
  await signInWithGoogleRedirect();
  // page navigates away
  return new Promise(() => {
    /* never resolves — redirect */
  });
}

export async function ensureGoogleToken(): Promise<string> {
  const existing = await getAccessToken();
  if (existing) return existing;
  await signInWithGoogleRedirect();
  throw new Error("Redirecting to Google…");
}

export function signOutGoogle(): void {
  const token = accessToken;
  accessToken = null;
  tokenExpiresAt = 0;
  currentUser = null;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
  if (token) {
    // Best-effort revoke
    fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }).catch(() => {});
  }
  emit();
}
