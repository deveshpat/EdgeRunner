const JINA_SEARCH = "https://s.jina.ai/";
let lastCall = 0;
const MIN_INTERVAL = 3000;

export async function searchWeb(query: string): Promise<string> {
  const now = Date.now();
  const delta = now - lastCall;
  if (delta < MIN_INTERVAL) {
    await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL - delta));
  }

  lastCall = Date.now();

  const res = await fetch(`${JINA_SEARCH}${encodeURIComponent(query)}`, {
    headers: { Accept: "text/plain" },
  });

  if (!res.ok) {
    throw new Error(`Jina search failed: ${res.status}`);
  }

  return res.text();
}
