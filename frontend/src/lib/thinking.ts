/**
 * Client-side mirror of backend/harness/thinking.py — split streamed model
 * output into (visible, reasoning) so raw <think> text never lands in the
 * chat bubble while tokens stream in.
 */

const TAGS = "(?:think|thinking|thought|reasoning)";
const OPEN = new RegExp(`<\\s*${TAGS}\\s*>`, "i");
const CLOSE = new RegExp(`</\\s*${TAGS}\\s*>`, "i");
const CLOSED_BLOCK = new RegExp(
  `<\\s*${TAGS}\\s*>([\\s\\S]*?)</\\s*${TAGS}\\s*>`,
  "gi"
);

export function splitThink(text: string): { visible: string; reasoning: string } {
  if (!text) return { visible: "", reasoning: "" };
  const reasoning: string[] = [];
  let s = text.replace(CLOSED_BLOCK, (_m, inner: string) => {
    reasoning.push(inner.trim());
    return " ";
  });

  const open = s.match(OPEN);
  if (open && open.index !== undefined) {
    reasoning.push(s.slice(open.index + open[0].length).trim());
    s = s.slice(0, open.index);
  }

  const close = s.match(CLOSE);
  if (close && close.index !== undefined) {
    reasoning.push(s.slice(0, close.index).trim());
    s = s.slice(close.index + close[0].length);
  }

  return {
    visible: s.replace(/\n{3,}/g, "\n\n").trim(),
    reasoning: reasoning.filter(Boolean).join("\n\n"),
  };
}
