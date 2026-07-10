/**
 * Google Identity Services (token client) + user profile.
 * Used for cross-device vault sync via Drive App Data.
 */

import { loadConfig } from "./config";

const GIS_SRC = "https://accounts.google.com/gsi/client";
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive.appdata",
].join(" ");

export type GoogleUser = {
  sub: string;
  email: string;
  name: string;
  picture?: string;
};

type TokenClient = {
  requestAccessToken: (overrides?: { prompt?: string }) => void;
};

type GoogleAccounts = {
  oauth2: {
    initTokenClient: (cfg: {
      client_id: string;
      scope: string;
      callback: (resp: {
        access_token?: string;
        error?: string;
        expires_in?: number;
      }) => void;
      error_callback?: (err: { type?: string; message?: string }) => void;
    }) => TokenClient;
    revoke: (token: string, done: () => void) => void;
  };
};

declare global {
  interface Window {
    google?: { accounts: GoogleAccounts };
  }
}

let tokenClient: TokenClient | null = null;
let accessToken: string | null = null;
let tokenExpiresAt = 0;
let currentUser: GoogleUser | null = null;
let gisLoaded = false;

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

function loadScript(): Promise<void> {
  if (gisLoaded && window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${GIS_SRC}"]`)) {
      const wait = () => {
        if (window.google?.accounts?.oauth2) {
          gisLoaded = true;
          resolve();
        } else setTimeout(wait, 50);
      };
      wait();
      return;
    }
    const s = document.createElement("script");
    s.src = GIS_SRC;
    s.async = true;
    s.onload = () => {
      gisLoaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error("Failed to load Google Identity Services"));
    document.head.appendChild(s);
  });
}

export async function isGoogleConfigured(): Promise<boolean> {
  const cfg = await loadConfig();
  return !!cfg.googleClientId && cfg.googleClientId.includes(".apps.googleusercontent.com");
}

export function getGoogleUser(): GoogleUser | null {
  return currentUser;
}

export function isGoogleSignedIn(): boolean {
  return !!(accessToken && currentUser && Date.now() < tokenExpiresAt - 30_000);
}

export async function getAccessToken(): Promise<string | null> {
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) return accessToken;
  return null;
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

export async function initGoogleAuth(): Promise<{ configured: boolean }> {
  const cfg = await loadConfig();
  if (!cfg.googleClientId) return { configured: false };
  await loadScript();
  if (!window.google?.accounts?.oauth2) {
    throw new Error("Google Identity Services unavailable");
  }
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: cfg.googleClientId,
    scope: SCOPES,
    callback: () => {
      /* set per-request */
    },
  });
  // Restore session hint from localStorage (token itself is not persisted for security)
  try {
    const raw = localStorage.getItem("edgerunner_google_user");
    if (raw) {
      // user profile only — still need to request token on demand
      currentUser = JSON.parse(raw) as GoogleUser;
    }
  } catch {
    /* ignore */
  }
  return { configured: true };
}

/**
 * Interactive sign-in (popup/consent). Resolves with access token + profile.
 */
export function signInWithGoogle(opts?: {
  forceConsent?: boolean;
}): Promise<{ user: GoogleUser; accessToken: string }> {
  return new Promise(async (resolve, reject) => {
    try {
      const cfg = await loadConfig();
      if (!cfg.googleClientId) {
        reject(
          new Error(
            "Google Client ID not configured. Add it in Settings or public/config.json"
          )
        );
        return;
      }
      await loadScript();
      if (!window.google?.accounts?.oauth2) {
        reject(new Error("Google Identity Services unavailable"));
        return;
      }

      tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: cfg.googleClientId,
        scope: SCOPES,
        callback: async (resp) => {
          if (resp.error || !resp.access_token) {
            reject(new Error(resp.error || "Google sign-in cancelled"));
            return;
          }
          try {
            accessToken = resp.access_token;
            tokenExpiresAt =
              Date.now() + (Number(resp.expires_in) || 3600) * 1000;
            currentUser = await fetchUserInfo(accessToken);
            try {
              localStorage.setItem(
                "edgerunner_google_user",
                JSON.stringify(currentUser)
              );
            } catch {
              /* ignore */
            }
            emit();
            resolve({ user: currentUser, accessToken });
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        },
        error_callback: (err) => {
          reject(new Error(err.message || err.type || "Google auth error"));
        },
      });

      tokenClient.requestAccessToken({
        prompt: opts?.forceConsent ? "consent" : "",
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Silent re-auth if possible; falls back to interactive. */
export async function ensureGoogleToken(): Promise<string> {
  const existing = await getAccessToken();
  if (existing) return existing;
  const { accessToken: t } = await signInWithGoogle();
  return t;
}

export function signOutGoogle(): void {
  const token = accessToken;
  accessToken = null;
  tokenExpiresAt = 0;
  currentUser = null;
  try {
    localStorage.removeItem("edgerunner_google_user");
  } catch {
    /* ignore */
  }
  if (token && window.google?.accounts?.oauth2) {
    try {
      window.google.accounts.oauth2.revoke(token, () => emit());
    } catch {
      emit();
    }
  } else {
    emit();
  }
}
