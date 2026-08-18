#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HOST="${FASTAPI_HOST:-0.0.0.0}"
PORT="${BGE_API_PORT:-8082}"

export TRITON_HTTP_URL="${TRITON_HTTP_URL:-http://127.0.0.1:18090}"
export TRITON_BGE_MODEL="${TRITON_BGE_MODEL:-bge_embeddings}"

exec python3 -m uvicorn bge_only_fastapi_app:app \
  --app-dir "$REPO_ROOT" \
  --host "$HOST" \
  --port "$PORT"

