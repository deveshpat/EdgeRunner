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
   - Chat history is stored in the browser (**IndexedDB**)  
   - A `sendBeacon` shutdown + missing heartbeats tear down the Kaggle worker (protects ~30 GPU hrs/month)

Secrets stay in `sessionStorage` only (cleared when the tab closes). They are never written to IndexedDB or localStorage.

## Repo layout

```
EdgeRunner/
├── backend/              # FastAPI + LangGraph agent (local or on Kaggle)
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
2. On the Pages UI: username + token → **GPU** or **CPU** → **Launch**  
3. First boot installs pip deps + model (several minutes). Status shows log tail until `EDGERUNNER_URL=…` appears.

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
