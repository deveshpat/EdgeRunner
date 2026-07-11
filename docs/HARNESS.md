# EdgeRunner Harness — best-of synthesis

> **Agent = Model + Harness.** On weak/local GGUF models, harness design often
> moves scores more than model swaps. This doc records *which systems we stole
> from* and *why*, so we don’t cargo-cult a single product.

## Landscape (2025–2026)

| System | Superpower | Weakness for us |
|--------|------------|-----------------|
| **SWE-agent / mini-SWE-agent** | Agent–Computer Interface (ACI): structured status/stdout/stderr; bash-first; official SWE-bench harness | Sparse tool UX for chat products |
| **OpenCode** | Build/Plan agents, OpenCode tool names, slash commands, max-steps, open TUI/CLI | Tuned for frontier API models |
| **Aider** | Exact SEARCH/REPLACE edits, repo-map, git-native commits, auto lint/test, token-efficient | Pair-programmer not full autonomous loop |
| **Claude Code** | AGENTS.md/CLAUDE.md memory, hooks, skills, subagents, permissions, deepest CLI product | Closed source |
| **OpenHands** | Docker sandbox, event stream, browser, parallel agents | Heavy for Kaggle GGUF worker |
| **CodeAct** | Code as universal action space (+20% vs JSON tools in research) | Needs solid interpreter + cleanup |
| **LangChain “harness eng.”** | Verify loops, context injection, loop detection, “reasoning sandwich” | Framework weight |
| **statewright** | Phase-gated tool sets → local models 2/10 → 10/10 on subset | Rigid if overdone |

**Consensus:** no single harness wins everything. Best products *compose* components.

## What EdgeRunner combines

### 1. Loop core — OpenCode + SWE-agent
- OpenCode-style **tool settle loop** with **max steps** and final text-only turn.
- SWE-agent **ACI observations**: `status / exit_code / stdout / stderr` (capped).
- GGUF protocol: `<tool name="…">{json}</tool>` (no native JSON tools required).

### 2. Tools — OpenCode names + Aider discipline
| Tool | Source |
|------|--------|
| `bash`, `read`, `write`, `edit`, `grep`, `glob`, `todowrite` | OpenCode |
| `apply_patch` (SEARCH/REPLACE + *** File blocks) | Aider / Codex |
| `run_python` | EdgeRunner fast-path |
| `done` | Explicit finish (many loops lack this; helps GGUF) |
| Aliases (`shell_exec`→`bash`, …) | Backward compat |

**Edit rule (OpenCode):** must `read` before `edit`.

### 3. Agents — Claude Code / OpenCode
| Agent | Tools | When |
|-------|-------|------|
| **build** | all | Default coding |
| **plan** | readonly only | `/plan`, “plan only”, analyze |

### 4. Phases — statewright + Aider tests-first
For small GGUF models, optional **phased tool masks** (default on):

```
PLAN  → readonly + todowrite + done
CODE  → write/edit/apply_patch/read/…
VERIFY → bash/run_python/read/…
REFLECT → readonly + edit + write (fix) then back to VERIFY
```

Falls back to full OpenCode free-form loop if `EDGERUNNER_PHASED=0`.

### 5. Verification — Aider + SWE-agent + LangChain harness eng.
- Prefer **tests before / with implementation**.
- Never claim success without a green tool observation.
- Auto-materialize `solution.py` + smoke tests if the model only emits a code fence.
- Reflect-on-fail (ReAct critic) then re-edit (legacy langgraph path kept as fallback).

### 6. Context / memory — Claude Code + Aider
- `/init` → AGENTS.md-style guidance prompt.
- History-aware **continue** routing (resume incomplete coding tasks).
- Prompt compaction at max steps (OpenCode `MAX_STEPS_PROMPT`).

### 7. Product UX — OpenCode TUI + CLI agents
- **CLI view** default (terminal transcript).
- Slash commands: `/help /new /compact /models /settings /plan /build /code /init /review /export /undo /thinking /details …`
- Settings: agent mode, UI view, show thinking, tool details.

### 8. Sandbox — OpenHands spirit, Kaggle reality
- Ephemeral workspace dir per run (not full Docker on free Kaggle).
- Path sandboxing (no escape from workspace).
- Timeouts on bash / python.

### 9. Extensibility — MCP + plugins (OpenCode / Claude Code)
- Builtin tools always.
- Optional MCP servers via `mcp_config.json`.

## Defaults (env)

| Env | Default | Meaning |
|-----|---------|---------|
| `EDGERUNNER_HARNESS` | `opencode` | `opencode` \| `langgraph` \| `phased` |
| `EDGERUNNER_PHASED` | `1` when harness=phased or auto for small models | Phase-gated tools |
| `EDGERUNNER_MAX_STEPS` | `20` | Build agent step cap |
| `EDGERUNNER_MAX_STEPS_PLAN` | `12` | Plan agent step cap |

## What we deliberately skip (for now)

| Skip | Why |
|------|-----|
| Full Docker (OpenHands) | Kaggle worker already isolated; extra Docker rare |
| Git snapshot undo (OpenCode) | No guaranteed git repo in workspace |
| Subagent fan-out | Costly on single GGUF / single GPU |
| Embedding repo-map (Aider) | Grep/glob enough for coding exercises; add later for large repos |
| Browser tool | Optional later via MCP |

## Implementation map

```
backend/harness/
  agent_loop.py      # OpenCode tool loop + max steps
  tools/registry.py  # OpenCode + Aider tools
  commands.py        # slash expansion
  pipeline.py        # entry: opencode | phased | langgraph
  sandbox.py         # ACI exec
  routing.py         # chat vs harness + continue
  language.py        # multi-lang
  mcp_client.py      # MCP + legacy builtins
frontend/src/lib/
  commands.ts        # OpenCode-inspired slash commands
  ui-prefs.ts        # CLI view, agent, thinking
```

## References

- SWE-agent ACI thesis; mini-SWE-agent as SWE-bench standard harness
- OpenCode (anomalyco) tools, plan/build, TUI commands
- Aider SEARCH/REPLACE + git discipline
- Claude Code AGENTS.md / plan mode product patterns
- CodeAct (ICML): code as action space
- LangChain harness engineering (Terminal Bench gains without model swap)
- statewright: phase-constrained tools for local models
