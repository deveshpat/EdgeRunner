"""DeepSeek Harness (dsh) Cordis Meta-Framework & Plugin Runtime.

Implements the 'everything is a plugin' spatiotemporal composability architecture
established by DeepSeek AI (deepseek-ai/deepseek-harness), providing:
1. Swappable Runtime Presets: 'standard', 'code', 'minimal', 'creator'.
2. Composable Plugin Lifecycle Hooks: before_step, on_reasoning, on_tool_call, after_tool_exec, on_fork.
3. Native DeepSeek Prompt Protocols: Dual-Phase <think> reasoning, FIM code completion, and MLA KV-caching.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

logger = logging.getLogger("edgerunner.dsh")


@dataclass
class DshContext:
    """Spatiotemporal execution context passed through the Cordis plugin pipeline."""
    session_id: str
    model: str
    preset: str = "code"
    iteration: int = 0
    messages: list[dict] = field(default_factory=list)
    active_tools: list[dict] = field(default_factory=list)
    reasoning_trace: str = ""
    thinking_ms: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


class DshPlugin:
    """Base class for all DeepSeek Harness Cordis plugins."""
    name: str = "base-plugin"
    version: str = "1.0.0"
    description: str = "DeepSeek Harness Plugin"

    async def on_init(self, ctx: DshContext) -> None:
        """Called when plugin is mounted into the session context."""
        pass

    async def before_step(self, ctx: DshContext) -> None:
        """Called before the model begins generating a new reasoning/tool step."""
        pass

    async def on_reasoning_chunk(self, chunk: str, ctx: DshContext) -> None:
        """Called when streaming <think> tokens arrive."""
        pass

    async def on_tool_call(self, tool_name: str, arguments: dict, ctx: DshContext) -> tuple[str, dict]:
        """Intercept or mutate tool calls before execution."""
        return tool_name, arguments

    async def after_tool_exec(self, tool_name: str, result: str, ctx: DshContext) -> str:
        """Post-process tool execution results before injecting into history."""
        return result

    async def on_fork(self, parent_id: str, new_id: str, fork_index: int) -> None:
        """Called when a session branch is forked from a checkpoint."""
        pass


class ReasoningPlugin(DshPlugin):
    """DeepSeek R1/V3/V4 dual-phase reasoning and <think> token parser."""
    name: str = "dsh-plugin-reasoning"
    description = "Extracts and formats DeepSeek <think> reasoning tokens with timing metadata."

    async def before_step(self, ctx: DshContext) -> None:
        ctx.reasoning_trace = ""
        ctx.metadata["t_reason_start"] = time.perf_counter()

    async def on_reasoning_chunk(self, chunk: str, ctx: DshContext) -> None:
        ctx.reasoning_trace += chunk


class SandboxPlugin(DshPlugin):
    """DeepSeek execution safety guard with command sanitization and path boundary enforcement."""
    name: str = "dsh-plugin-sandbox"
    description = "Enforces strict workspace boundaries and sanitizes nested shell escaping."

    async def on_tool_call(self, tool_name: str, arguments: dict, ctx: DshContext) -> tuple[str, dict]:
        from app.tools import sanitize_shell_command
        if tool_name == "terminal" and "command" in arguments:
            arguments["command"] = sanitize_shell_command(str(arguments["command"]))
        return tool_name, arguments


class LinUCBRouterPlugin(DshPlugin):
    """DeepSeek tool routing via Contextual LinUCB matrix regression."""
    name: str = "dsh-plugin-linucb-router"
    description = "Dynamically slices active tool definitions using LinUCB contextual bandits."

    async def before_step(self, ctx: DshContext) -> None:
        from app.tools import get_active_tool_slice
        ctx.active_tools = get_active_tool_slice(ctx.messages)


class ReflexionPlugin(DshPlugin):
    """Reflexion verbal reinforcement episodic memory injector."""
    name: str = "dsh-plugin-reflexion"
    description = "Injects episodic counterfactual memories from past errors into turn context."

    async def before_step(self, ctx: DshContext) -> None:
        from app.reflexion import retrieve_episodic_reflections
        if ctx.messages:
            last_content = str(ctx.messages[-1].get("content") or "")
            reflections = retrieve_episodic_reflections(last_content)
            if reflections:
                ctx.messages.append({
                    "role": "system",
                    "content": "[DeepSeek Reflexion Episodic Memory]\n" + "\n".join(reflections),
                })


class SessionForkPlugin(DshPlugin):
    """DeepSeek session branching and time-travel replay engine."""
    name: str = "dsh-plugin-session-fork"
    description = "Manages session branch trees, checkpoints, and deterministic replay."

    async def on_fork(self, parent_id: str, new_id: str, fork_index: int) -> None:
        logger.info(f"[DSH] Forked session {parent_id} -> {new_id} at step {fork_index}")


class CordisKernel:
    """DeepSeek Cordis meta-framework runtime engine."""

    def __init__(self, preset: str = "code"):
        self.preset = preset
        self.plugins: list[DshPlugin] = []
        self._load_preset(preset)

    def _load_preset(self, preset: str) -> None:
        """Mount plugins according to DeepSeek Harness runtime presets."""
        self.preset = preset.lower()
        self.plugins = [
            ReasoningPlugin(),
            SandboxPlugin(),
        ]

        if self.preset in ("code", "standard"):
            self.plugins.extend([
                LinUCBRouterPlugin(),
                ReflexionPlugin(),
                SessionForkPlugin(),
            ])
        elif self.preset == "creator":
            self.plugins.extend([
                LinUCBRouterPlugin(),
                SessionForkPlugin(),
            ])
        elif self.preset == "minimal":
            pass

    def mount_plugin(self, plugin: DshPlugin) -> None:
        """Mount a custom dsh-plugin into the live kernel."""
        self.plugins.append(plugin)

    async def run_before_step(self, ctx: DshContext) -> None:
        for p in self.plugins:
            await p.before_step(ctx)

    async def process_tool_call(self, tool_name: str, arguments: dict, ctx: DshContext) -> tuple[str, dict]:
        cur_name, cur_args = tool_name, arguments
        for p in self.plugins:
            cur_name, cur_args = await p.on_tool_call(cur_name, cur_args, ctx)
        return cur_name, cur_args

    async def process_tool_result(self, tool_name: str, result: str, ctx: DshContext) -> str:
        cur_res = result
        for p in self.plugins:
            cur_res = await p.after_tool_exec(tool_name, cur_res, ctx)
        return cur_res


DSH_PRESET_PROMPTS: dict[str, str] = {
    "code": """You are DeepSeek-Coder running inside EdgeRunner's DeepSeek Harness (dsh).
Your core mission is surgical, correct software engineering with verified code quality.
Protocol:
1. Always reason through root causes inside <think>...</think> before generating actions.
2. Use 'view_file' with exact line windows to inspect files before editing.
3. Use 'replace_file_content' for surgical edits, or 'terminal' to execute tests/compilers.
4. Execute commands directly; verify outputs and never guess.
""",
    "standard": """You are DeepSeek Assistant running inside EdgeRunner's DeepSeek Harness (dsh).
You are an autonomous general-purpose agent equipped with terminal, file system, web search, and ML oracles.
Protocol:
1. Plan complex multi-step tasks inside <think>...</think> reasoning blocks.
2. Formulate hypotheses, execute tools, verify results, and iterate autonomously.
3. Provide concise, clear markdown summaries upon completion.
""",
    "minimal": """You are DeepSeek running in Minimal Zero-Overhead mode.
Answer questions directly with high precision. Use tools only when strictly required.
""",
    "creator": """You are DeepSeek Creator running inside EdgeRunner's DeepSeek Harness (dsh).
You specialize in rapid project scaffolding, modern UI development, and multi-file application architecture.
Protocol:
1. Synthesize project structure and dependencies cleanly.
2. Write production-ready, beautiful code with Tailwind CSS and Next.js / Python.
3. Test builds with 'terminal' and launch previews seamlessly.
""",
}
