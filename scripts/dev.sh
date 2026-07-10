#!/usr/bin/env bash
# Start EdgeRunner orchestrator + frontend for Kaggle-capable local development.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ ! -d "$ROOT/orchestrator/.venv" ]]; then
  python3 -m venv "$ROOT/orchestrator/.venv"
  "$ROOT/orchestrator/.venv/bin/pip" install -r "$ROOT/orchestrator/requirements.txt"
fi

if [[ ! -d "$ROOT/frontend/node_modules" ]]; then
  (cd "$ROOT/frontend" && npm install)
fi

echo "EdgeRunner"
echo "  Orchestrator  http://127.0.0.1:9000"
echo "  Frontend      http://127.0.0.1:3000"
echo

"$ROOT/orchestrator/.venv/bin/python" "$ROOT/orchestrator/main.py" &
ORCH_PID=$!
trap 'kill $ORCH_PID 2>/dev/null || true' EXIT

(cd "$ROOT/frontend" && npm run dev)

