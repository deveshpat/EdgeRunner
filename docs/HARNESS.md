# EdgeRunner Harness

One automatic coding agent. Research and other harnesses are **design inputs**, not runtime options. Users never pick a “mode” or “fallback.”

## Principle

> Agent = Model + Harness.  
> Literature and production systems tell us *what to bake in*.  
> The product exposes **chat + plan/build intent** — not a harness menu.

## What we integrated (always on)

| Decision | Source | Behavior in the loop |
|----------|--------|----------------------|
| Tool settle loop, max steps, `done` | OpenCode | Bounded turns; final text if cap hit |
| Tool names: bash/read/write/edit/grep/glob/apply_patch/todo | OpenCode | Stable tool surface for GGUF XML protocol |
| Exact replace + read-before-edit | Aider / OpenCode | Fewer silent wrong edits |
| ACI-style observations | SWE-agent | `status` / stdout / stderr in tool results |
| Phase rhythm PLAN→CODE→VERIFY→REFLECT | statewright + practice | Guides weak models; tools still available |
| Must verify before success | Aider + harness eng. | Green tests (or plan-mode) before finish |
| Code fence → files when tools omitted | EdgeRunner | Recover from non-tool generations |
| Plan vs build | OpenCode / Claude Code | Readonly analysis vs full implement |
| `/init`, `/review`, slash UX | OpenCode / Claude Code | Product commands, not alternate engines |
| Optional MCP | MCP ecosystem | Extra tools when configured |
| Workspace isolation | OpenHands spirit | Ephemeral dir, path sandbox, timeouts |

## Runtime surface (user-facing)

| User action | System does |
|-------------|-------------|
| Coding question or `/code …` | Build agent, automatic phases |
| `/plan …` or “plan only” | Readonly plan agent |
| Casual chat | Short reply, no tools |
| “Continue…” after failed coding | Resume prior task (routing) |
| Tab / agent toggle in UI | Plan ↔ build **intent** only |

No `EDGERUNNER_HARNESS=…` menu. Optional knobs that remain are pure limits (not alternate designs):

| Env | Default | Role |
|-----|---------|------|
| `EDGERUNNER_MAX_STEPS` | 24 | Cap build turns |
| `EDGERUNNER_MAX_STEPS_PLAN` | 12 | Cap plan turns |

## Code map

```
backend/harness/
  pipeline.py       # entry: slash resolve → run_coding_agent
  agent_loop.py     # the one loop
  tools/registry.py # tools + parse
  commands.py       # slash → task/agent
  routing.py        # chat vs coding, continue
  sandbox.py        # multi-lang ACI exec (when used)
  language.py
  mcp_client.py     # optional MCP
```

## Deliberately not productized

| Idea | Why not a user toggle |
|------|------------------------|
| Separate “langgraph harness” | Same goals as the integrated loop; dual paths confuse |
| Separate “pure OpenCode free-form” | Phase rhythm is always useful; free-form is not an alternate product |
| Subagent swarms | Costly on single GGUF |
| Full Docker sandbox | Kaggle worker already isolated |

If research improves a piece, **merge it into `agent_loop.py`**, don’t add a flag.
