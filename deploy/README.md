# Deploying the EdgeRunner backend on Kaggle

The backend runs on a Kaggle GPU node next to a llama.cpp `llama-server`, and is
reached from the frontend over a Cloudflare quick tunnel.

```
Kaggle GPU node
┌────────────────────────────────────────────┐
│  llama-server  (:8080)  ── GGUF on GPU       │
│        ▲                                     │
│        │ /v1/chat/completions (SSE)          │
│  FastAPI app   (:8000)  ── EdgeRunner        │
│        ▲                                     │
└────────┼─────────────────────────────────────┘
         │  cloudflared quick tunnel
         ▼
  https://<random>.trycloudflare.com  ──▶  frontend
```

## One-shot setup

In a Kaggle notebook with **GPU** and **Internet** enabled:

```python
# 1. get the code
!git clone https://github.com/<you>/EdgeRunner /kaggle/working/EdgeRunner

# 2. bring everything up (build + download + serve + tunnel)
!bash /kaggle/working/EdgeRunner/deploy/kaggle_bootstrap.sh
```

The script prints a public URL:

```
  Public API URL:  https://calm-forest-1234.trycloudflare.com
```

Set that as `NEXT_PUBLIC_API_URL` for the frontend and you're connected.

## Configuration

Everything is overridable via environment variables (defaults shown):

| Var | Default | Meaning |
|-----|---------|---------|
| `MODEL_REPO` | `Qwen/Qwen2.5-3B-Instruct-GGUF` | HF repo to pull the GGUF from |
| `MODEL_FILE` | `qwen2.5-3b-instruct-q4_k_m.gguf` | GGUF filename in that repo |
| `N_GPU_LAYERS` | `99` | layers to offload to GPU (99 = all) |
| `CTX_SIZE` | `8192` | context window |
| `LLAMA_PORT` | `8080` | llama-server port |
| `API_PORT` | `8000` | EdgeRunner FastAPI port |

Example — serve a different model:

```python
import os
os.environ["MODEL_REPO"] = "bartowski/Llama-3.2-3B-Instruct-GGUF"
os.environ["MODEL_FILE"] = "Llama-3.2-3B-Instruct-Q4_K_M.gguf"
!bash /kaggle/working/EdgeRunner/deploy/kaggle_bootstrap.sh
```

## How the backend finds llama-server

The FastAPI app reads `LLAMACPP_BASE_URL` (the bootstrap sets it to
`http://localhost:8080`). The catalog endpoint queries llama-server's
`/v1/models` so the frontend's model picker shows whatever GGUF is actually
loaded; if llama-server isn't reachable it falls back to a static placeholder
list and the `echo` harness still works.

## Logs & troubleshooting

Logs live under `/kaggle/working/logs`:

- `llama.log` — model load / llama-server
- `api.log` — FastAPI
- `tunnel.log` — cloudflared (contains the public URL)

Common issues:

- **Tunnel URL not captured** — check `tunnel.log`; the `trycloudflare.com`
  hostname appears a second or two after cloudflared starts.
- **CUDA build slow** — the first `llama.cpp` build takes a few minutes; it is
  cached in `/kaggle/working/llama.cpp` for reruns within the session.
- **Model won't fit** — pick a smaller quant (`Q4_K_M` → `Q3_K_M`) or lower
  `N_GPU_LAYERS`.
