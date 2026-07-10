# EdgeRunner

Local agentic coding harness with optional **one-click Kaggle CPU/GPU** deploy.

- **Local:** run the FastAPI backend + Next.js UI on your machine  
- **Kaggle:** paste API credentials in the UI → orchestrator pushes a headless kernel → Cloudflare HTTPS tunnel → chat works → session self-kills on tab close / idle (protects monthly GPU quota)

## Repo layout

```
EdgeRunner/
├── backend/           # FastAPI + LangGraph agent (local or on Kaggle)
├── frontend/          # Next.js UI (chat + Kaggle session panel)
├── orchestrator/      # Local control plane: pack + push kernel, scrape tunnel URL
├── kaggle_worker/     # Bootstrap template embedded into the Kaggle script
└── scripts/dev.sh     # Start orchestrator + frontend together
```

## Quick start (local backend only)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
EDGERUNNER_AUTO=1 python main.py    # http://127.0.0.1:8000
```

```bash
cd frontend
npm install && npm run dev          # http://127.0.0.1:3000
```

Point the UI backend URL at `http://127.0.0.1:8000`.

## Quick start (Kaggle deploy)

1. Create a Kaggle API token: [kaggle.com/settings](https://www.kaggle.com/settings) → API  
2. Start orchestrator + UI:

```bash
./scripts/dev.sh
# or manually:
#   cd orchestrator && python -m venv .venv && source .venv/bin/activate
#   pip install -r requirements.txt && python main.py   # :9000
#   cd frontend && npm install && npm run dev           # :3000
```

3. Open the UI → session panel → username + token → **CPU** (for testing) → **Launch**  
4. Wait for state `online` (first boot: pip + model download can take several minutes)  
5. Chat as usual — backend URL is filled automatically  

### Session lifecycle (GPU safety)

| Event | Behavior |
|-------|----------|
| Heartbeat | UI POSTs `/session/heartbeat` every ~25s |
| Tab close | `sendBeacon` → `/session/shutdown` |
| Idle | No heartbeat for 90s (configurable) → worker `os._exit(0)` |
| Max lifetime | Hard cap (default 1h) |

Kaggle has **no public stop-session API**. Teardown is the worker process exiting.

**Use CPU while developing.** GPU sessions burn monthly quota if left running.

## Environment (worker)

| Variable | Default | Meaning |
|----------|---------|---------|
| `EDGERUNNER_AUTO` | `1` | Non-interactive model selection |
| `KP_IDLE_TIMEOUT_SECONDS` | `90` | Exit without heartbeat |
| `KP_MAX_LIFETIME_SECONDS` | `3600` | Hard session cap |
| `KP_STARTUP_GRACE_SECONDS` | `600` | Cold-start allowance |
| `EDGERUNNER_MODEL_REPO` / `EDGERUNNER_MODEL_FILE` | — | Force a GGUF |

## API sketch

**Orchestrator** (`:9000`): `POST /sessions/start`, `GET /sessions/{id}`, `POST /sessions/{id}/stop`  

**Worker** (tunneled): `GET /health`, `POST /chat`, `POST /session/heartbeat`, `POST /session/shutdown`

## License

MIT. You are responsible for complying with [Kaggle’s terms](https://www.kaggle.com/terms) and usage quotas.
