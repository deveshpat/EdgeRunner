// Bookmark of the current live backend URL, so a reload/other-tab can probe it
// directly and go straight to "online" instead of re-scraping Kaggle logs
// (which is what left the UI stuck on "starting"). Mirrors the old design.

const KEY = "edgerunner.live";
const MAX_AGE_MS = 6 * 3600_000;

interface Live {
  url: string;
  savedAt: number;
}

export function saveLiveSession(url: string): void {
  const v = JSON.stringify({ url, savedAt: Date.now() } satisfies Live);
  try {
    localStorage.setItem(KEY, v);
    sessionStorage.setItem(KEY, v);
  } catch {
    /* ignore */
  }
}

export function loadLiveSession(): string | null {
  for (const store of [
    typeof localStorage !== "undefined" ? localStorage : null,
    typeof sessionStorage !== "undefined" ? sessionStorage : null,
  ]) {
    try {
      const raw = store?.getItem(KEY);
      if (!raw) continue;
      const v = JSON.parse(raw) as Live;
      if (v?.url && Date.now() - (v.savedAt || 0) < MAX_AGE_MS) return v.url;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function clearLiveSession(): void {
  try {
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
