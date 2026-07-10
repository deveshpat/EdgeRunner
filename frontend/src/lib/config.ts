/**
 * Runtime config for GH Pages (no rebuild needed for client id).
 * Priority: localStorage override → public/config.json → build env.
 */

export type AppConfig = {
  googleClientId: string;
};

const LS_KEY = "edgerunner_google_client_id";

let cached: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached;

  let fromFile = "";
  try {
    const base =
      typeof window !== "undefined"
        ? // Next basePath for Pages
          (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "")
        : "";
    const res = await fetch(`${base}/config.json`, { cache: "no-store" });
    if (res.ok) {
      const j = (await res.json()) as { googleClientId?: string };
      fromFile = (j.googleClientId || "").trim();
    }
  } catch {
    /* ignore */
  }

  let fromLs = "";
  try {
    fromLs = (localStorage.getItem(LS_KEY) || "").trim();
  } catch {
    /* ignore */
  }

  const fromEnv = (process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || "").trim();

  cached = {
    googleClientId: fromLs || fromFile || fromEnv || "",
  };
  return cached;
}

export function setGoogleClientIdOverride(clientId: string): void {
  try {
    if (clientId.trim()) localStorage.setItem(LS_KEY, clientId.trim());
    else localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
  cached = null;
}

export function clearConfigCache(): void {
  cached = null;
}
