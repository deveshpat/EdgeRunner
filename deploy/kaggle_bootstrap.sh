#!/usr/bin/env bash
#
# EdgeRunner — Kaggle bootstrap.
#
# Brings up the full backend on a Kaggle GPU node:
#   1. builds llama.cpp (llama-server) with CUDA
#   2. downloads a GGUF model from the Hugging Face Hub
#   3. launches llama-server                 (localhost:8080)
#   4. launches the EdgeRunner FastAPI app    (localhost:8000)
#   5. opens a cloudflared quick tunnel to :8000 and prints the public URL
#
# Run it from a Kaggle notebook cell (GPU + Internet enabled):
#
#     !bash /kaggle/working/EdgeRunner/deploy/kaggle_bootstrap.sh
#
# The tunnel URL it prints is what you paste into the frontend's
# NEXT_PUBLIC_API_URL. Logs are written under $WORK/logs.
#
# Everything below can be overridden via environment variables.
set -euo pipefail

# ---------------------------------------------------------------- config -----
MODEL_REPO="${MODEL_REPO:-Qwen/Qwen2.5-3B-Instruct-GGUF}"
MODEL_FILE="${MODEL_FILE:-qwen2.5-3b-instruct-q4_k_m.gguf}"
N_GPU_LAYERS="${N_GPU_LAYERS:-99}"     # offload all layers to GPU
CTX_SIZE="${CTX_SIZE:-8192}"
LLAMA_PORT="${LLAMA_PORT:-8080}"
API_PORT="${API_PORT:-8000}"

WORK="${WORK:-/kaggle/working}"
REPO_DIR="${REPO_DIR:-$WORK/EdgeRunner}"
LLAMA_DIR="$WORK/llama.cpp"
MODEL_DIR="$WORK/models"
LOG_DIR="$WORK/logs"
mkdir -p "$MODEL_DIR" "$LOG_DIR"

log() { echo -e "\n\033[1;32m[edgerunner]\033[0m $*"; }

# ------------------------------------------------------------ 1. llama.cpp ---
if [ ! -x "$LLAMA_DIR/build/bin/llama-server" ]; then
  log "Building llama.cpp with CUDA (a few minutes the first time)…"
  pip install -q huggingface_hub >/dev/null
  rm -rf "$LLAMA_DIR"
  git clone --depth 1 https://github.com/ggml-org/llama.cpp "$LLAMA_DIR"
  cmake -S "$LLAMA_DIR" -B "$LLAMA_DIR/build" \
    -DGGML_CUDA=ON -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release >/dev/null
  cmake --build "$LLAMA_DIR/build" --config Release -j --target llama-server
else
  log "Reusing existing llama-server build."
fi

# ---------------------------------------------------------------- 2. model ---
MODEL_PATH="$MODEL_DIR/$MODEL_FILE"
if [ ! -f "$MODEL_PATH" ]; then
  log "Downloading $MODEL_FILE from $MODEL_REPO…"
  huggingface-cli download "$MODEL_REPO" "$MODEL_FILE" \
    --local-dir "$MODEL_DIR" --local-dir-use-symlinks False
else
  log "Model already present: $MODEL_PATH"
fi

# ------------------------------------------------------- 3. launch servers ---
log "Starting llama-server on :$LLAMA_PORT …"
nohup "$LLAMA_DIR/build/bin/llama-server" \
  --model "$MODEL_PATH" \
  --host 0.0.0.0 --port "$LLAMA_PORT" \
  --n-gpu-layers "$N_GPU_LAYERS" \
  --ctx-size "$CTX_SIZE" \
  >"$LOG_DIR/llama.log" 2>&1 &

log "Waiting for llama-server to load the model…"
for _ in $(seq 1 120); do
  if curl -sf "http://localhost:$LLAMA_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -sf "http://localhost:$LLAMA_PORT/health" >/dev/null \
  || { echo "llama-server failed to start; see $LOG_DIR/llama.log"; exit 1; }
log "llama-server is up."

log "Installing + starting the EdgeRunner backend on :$API_PORT …"
pip install -q -e "$REPO_DIR/backend" >/dev/null
export LLAMACPP_BASE_URL="http://localhost:$LLAMA_PORT"
nohup uvicorn app.main:app --app-dir "$REPO_DIR/backend" \
  --host 0.0.0.0 --port "$API_PORT" \
  >"$LOG_DIR/api.log" 2>&1 &

for _ in $(seq 1 30); do
  curl -sf "http://localhost:$API_PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done
log "EdgeRunner API is up."

# ------------------------------------------------------------- 4. tunnel -----
if ! command -v cloudflared >/dev/null 2>&1; then
  log "Installing cloudflared…"
  curl -sL -o /usr/local/bin/cloudflared \
    https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x /usr/local/bin/cloudflared
fi

log "Opening public tunnel to :$API_PORT …"
nohup cloudflared tunnel --no-autoupdate --url "http://localhost:$API_PORT" \
  >"$LOG_DIR/tunnel.log" 2>&1 &

PUBLIC_URL=""
for _ in $(seq 1 30); do
  PUBLIC_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG_DIR/tunnel.log" | head -1 || true)"
  [ -n "$PUBLIC_URL" ] && break
  sleep 1
done

echo
echo "================================================================"
if [ -n "$PUBLIC_URL" ]; then
  echo "  EdgeRunner is live."
  echo "  Public API URL:  $PUBLIC_URL"
  echo
  echo "  Point the frontend at it:"
  echo "      NEXT_PUBLIC_API_URL=$PUBLIC_URL"
  echo "  Sanity check:"
  echo "      curl $PUBLIC_URL/api/health"
else
  echo "  Servers are up but the tunnel URL wasn't captured."
  echo "  Check $LOG_DIR/tunnel.log"
fi
echo "================================================================"
