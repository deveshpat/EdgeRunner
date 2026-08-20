/**
 * DeepSeek Harness (dsh) Cordis Meta-Framework & Plugin Pipeline for Browser Client.
 *
 * Implements spatiotemporal composability, runtime presets, and event hooks.
 */

export interface DshBrowserContext {
  sessionId: string;
  preset: "code" | "standard" | "minimal" | "creator";
  iteration: number;
  messages: { role: string; content?: string | null }[];
  reasoningTrace: string;
}

export interface DshBrowserPlugin {
  name: string;
  beforeStep?: (ctx: DshBrowserContext) => Promise<void> | void;
  onReasoningChunk?: (chunk: string, ctx: DshBrowserContext) => void;
  onToolCall?: (name: string, args: Record<string, unknown>, ctx: DshBrowserContext) => { name: string; args: Record<string, unknown> };
  afterToolExec?: (name: string, result: string, ctx: DshBrowserContext) => string;
}

export const DSH_PRESETS = {
  code: {
    name: "DeepSeek Code",
    description: "Laser-focused software engineering, surgical file editing, and test verification.",
    systemPrompt: `You are DeepSeek-Coder running inside EdgeRunner's DeepSeek Harness (dsh).
Your core mission is surgical, correct software engineering with verified code quality.
1. Reason through root causes inside <think>...</think> before generating actions.
2. Use 'view_file' with exact line windows to inspect files before editing.
3. Use 'replace_file_content' for surgical edits, or 'terminal' to execute tests/compilers.
4. Execute commands directly; verify outputs and never guess.`,
  },
  standard: {
    name: "DeepSeek Standard",
    description: "Autonomous general-purpose agent with multi-turn planning, web search, and terminal.",
    systemPrompt: `You are DeepSeek Assistant running inside EdgeRunner's DeepSeek Harness (dsh).
You are an autonomous general-purpose agent equipped with terminal, file system, web search, and ML oracles.
1. Plan complex multi-step tasks inside <think>...</think> reasoning blocks.
2. Formulate hypotheses, execute tools, verify results, and iterate autonomously.
3. Provide concise, clear markdown summaries upon completion.`,
  },
  minimal: {
    name: "DeepSeek Minimal",
    description: "Zero-overhead low-latency direct responses with minimal tool intervention.",
    systemPrompt: `You are DeepSeek running in Minimal Zero-Overhead mode.
Answer questions directly with high precision. Use tools only when strictly required.`,
  },
  creator: {
    name: "DeepSeek Creator",
    description: "Full-stack project scaffolding, Next.js / Tailwind UI development, and live preview.",
    systemPrompt: `You are DeepSeek Creator running inside EdgeRunner's DeepSeek Harness (dsh).
You specialize in rapid project scaffolding, modern UI development, and multi-file application architecture.
1. Synthesize project structure and dependencies cleanly.
2. Write production-ready, beautiful code with Tailwind CSS and Next.js / Python.
3. Test builds with 'terminal' and launch previews seamlessly.`,
  },
};
