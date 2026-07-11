# EdgeRunner

Agentic coding harness that runs **locally** or on **Kaggle CPU/GPU**, with a static UI on **GitHub Pages**.

Live UI: [https://deveshpat.github.io/EdgeRunner/](https://deveshpat.github.io/EdgeRunner/)

## User flow (GitHub Pages)

1. Open the site → choose **Kaggle** or **Local URL**
2. **Kaggle:** paste username + API token, pick GPU or CPU  
   - If GPU fails (e.g. monthly hour quota), it **falls back to CPU** by default  
   - Browser talks to the [Kaggle Public API](https://www.kaggle.com/docs/api) directly (CORS allowed), packs the worker, pushes a kernel, scrapes the HTTPS tunnel from logs, and attaches it
3. **Local:** paste `http://127.0.0.1:8000` (or any reachable backend)
4. Chat as usual
5. **Close the tab:**  
   - Chat stays **encrypted at rest** (AES-256-GCM in IndexedDB)  
   - A `sendBeacon` shutdown + missing heartbeats tear down the Kaggle worker (protects ~30 GPU hrs/month)

### Device vault (credentials + chat)

- **Default:** non-extractable WebCrypto key on this browser — token remembered encrypted, auto-unlock next visit  
- **Optional passphrase:** PBKDF2 (600k) wraps the key — unlock once per session on shared machines  
- Tokens are **never** stored in plaintext `localStorage` / `sessionStorage`  
- See [SECURITY.md](SECURITY.md)

### Sign in with Google

Users only see a **Sign in with Google** button → full Google login page → back into EdgeRunner.  
Vault encryption and credential sync run automatically in the background (no passphrase screens for normal use).

**Site owner (one-time):** create a Google Cloud **OAuth Web Client ID**, enable Drive API, set:

| Field | Value |
|-------|--------|
| Authorized JavaScript origins | `https://deveshpat.github.io`, `http://localhost:3000` |
| Authorized redirect URIs | `https://deveshpat.github.io/EdgeRunner/`, `http://localhost:3000/EdgeRunner/` |

Put the client ID in `frontend/public/config.json` as `googleClientId` (or `NEXT_PUBLIC_GOOGLE_CLIENT_ID` at build time). End users never touch that.

### Fast Kaggle install (prebuilt wheels)

Compiling `llama-cpp-python` every launch is the main delay. The worker installs
**prebuilt Linux wheels** from the GitHub release tag [`wheels-v1`](https://github.com/deveshpat/EdgeRunner/releases/tag/wheels-v1)
(see [wheels/README.md](wheels/README.md)). CI builds CPU wheels; GPU wheels are built once on Kaggle.

## Coding harness (best-of synthesis)

Casual chat (`hi`) uses a short LLM turn. Coding tasks (or `/code …`) run the **combined harness**.

Full research write-up: **[docs/HARNESS.md](docs/HARNESS.md)**.

Default loop (`EDGERUNNER_HARNESS=best`):

```
PLAN (readonly + tests) → CODE (write/edit) → VERIFY (bash/run_python) → REFLECT → …
```

| Component | Best source | EdgeRunner use |
|-----------|-------------|----------------|
| Tool names + settle loop + max steps | **OpenCode** | `bash/read/write/edit/grep/glob/todowrite/apply_patch` |
| ACI observations | **SWE-agent** | `status/exit_code/stdout/stderr` capped |
| Exact edits + tests-first | **Aider** | `edit` / `apply_patch` SEARCH-REPLACE; smoke tests |
| Plan vs Build agents | **OpenCode / Claude Code** | `/plan` readonly · `/build` full tools |
| Phase-gated tools (weak models) | **statewright** | Shrink tool space per phase for GGUF |
| Code as action | **CodeAct** | `run_python` + bash |
| Project memory prompts | **Claude Code** | `/init` AGENTS.md-style |
| Optional servers | **MCP** | `mcp_config.json` |
| Sandbox isolation | **OpenHands** spirit | Ephemeral workspace (Kaggle-safe) |

### Modes

| `EDGERUNNER_HARNESS` | Behavior |
|----------------------|----------|
| `best` / `phased` (default) | Phase-gated PLAN→CODE→VERIFY→REFLECT |
| `opencode` | Free-form OpenCode tool loop |
| `langgraph` | Legacy plan→test→reflect graph |

### OpenCode-compatible tools

`bash`, `read`, `write`, `edit`, `grep`, `glob`, `apply_patch`, `todowrite`, `webfetch`, `run_python`, `list_dir`, `done`

```xml
<tool name="write">
{"path": "solution.py", "content": "def reverse_string(s):\\n    return s[::-1]\\n"}
</tool>
```

### UI (CLI + slash commands)

Default **CLI view** (terminal transcript). Toggle with `/cli` · `/chat` · settings.

| Command | Action |
|---------|--------|
| `/help` | List commands |
| `/new` `/clear` | New session |
| `/plan` `/build` `/code` | Agent mode + optional task |
| `/init` `/review` | Claude/OpenCode-style prompts |
| `/models` `/settings` | Open pickers |
| `/export` `/undo` `/thinking` | Session utilities |

Tab (empty composer) toggles **build ↔ plan** (OpenCode-style).

### Optional MCP servers

Copy [`backend/mcp_config.example.json`](backend/mcp_config.example.json) → `backend/mcp_config.json`
(or set `EDGERUNNER_MCP_CONFIG`). On Kaggle, prefer **builtin** tools if Node/`npx` is unavailable.

### Languages

Python (primary), JavaScript/Node, Bash, Go, Rust (best-effort if toolchain present).

## Repo layout

```
EdgeRunner/
├── backend/              # FastAPI + LangGraph agent (local or on Kaggle)
│   ├── agent.py          # model load + chat/harness routing
│   ├── harness/          # plan→test→code→sandbox→reflect + MCP tools
│   └── mcp_config.example.json
├── frontend/             # Next.js static UI (GH Pages)
│   └── public/kernel-bundle.json   # packed worker (generated)
├── orchestrator/         # Optional local control plane (dev / offline)
├── kaggle_worker/        # Bootstrap template embedded into the Kaggle script
└── scripts/
    ├── pack_kernel_bundle.py   # rebuild kernel-bundle.json
    └── dev.sh
```


## Quick start (local backend + UI)

```bash
# Terminal 1 — backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
EDGERUNNER_AUTO=1 python main.py    # http://127.0.0.1:8000

# Terminal 2 — UI (basePath /EdgeRunner → open that path)
cd frontend
python3 ../scripts/pack_kernel_bundle.py
npm install && npm run dev
# http://127.0.0.1:3000/EdgeRunner/
```

On the setup screen, use **Local URL** → `http://127.0.0.1:8000`.

## Kaggle credentials

1. [kaggle.com/settings](https://www.kaggle.com/settings) → API → create token  
2. On the Pages UI: Kaggle **username** + token → **GPU** or **CPU** → **Launch**  
3. Always reuses one notebook: `username/edgerunner` (not a new kernel every time).  
4. Prior run output is remounted so GGUF/HF cache can skip re-download.  
5. Status: **API online · loading model…** then **Engine Online** when `model_ready` is true.

### Session lifecycle (GPU safety)

| Event | Behavior |
|-------|----------|
| Heartbeat | UI `POST /session/heartbeat` every ~25s |
| Tab close | `sendBeacon` → `/session/shutdown` |
| Idle | No heartbeat for 90s (configurable) → worker `os._exit(0)` |
| Max lifetime | Hard cap (default 1h) |

Kaggle has **no public stop-session API**. Teardown is the worker process exiting.

## Optional local orchestrator

Still available for offline/dev without browser→Kaggle:

```bash
./scripts/dev.sh
# orchestrator :9000 + frontend :3000
```

The Pages flow does **not** require the orchestrator.

## Deploy (GitHub Pages)

Push to `main`. Workflow [`.github/workflows/nextjs.yml`](.github/workflows/nextjs.yml):

1. `python3 scripts/pack_kernel_bundle.py`
2. `next build` (static export, `basePath=/EdgeRunner`)
3. Deploy `frontend/out` to Pages

## Environment (worker)

| Variable | Default | Meaning |
|----------|---------|---------|
| `EDGERUNNER_AUTO` | `1` | Non-interactive model selection |
| `KP_IDLE_TIMEOUT_SECONDS` | `90` | Exit without heartbeat |
| `KP_MAX_LIFETIME_SECONDS` | `3600` | Hard session cap |
| `KP_STARTUP_GRACE_SECONDS` | `600` | Cold-start allowance |
| `EDGERUNNER_MODEL_REPO` / `EDGERUNNER_MODEL_FILE` | — | Force a GGUF |

## API sketch

**Worker** (local or tunneled): `GET /health`, `POST /chat`, `POST /session/heartbeat`, `POST /session/shutdown`

## License

MIT. You are responsible for complying with [Kaggle’s terms](https://www.kaggle.com/terms) and usage quotas.
