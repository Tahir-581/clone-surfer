#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HOST="${FASTAPI_HOST:-0.0.0.0}"
PORT="${GLINER_API_PORT:-8081}"

export TRITON_HTTP_URL="${TRITON_HTTP_URL:-http://127.0.0.1:18090}"
export TRITON_GLINER_MODEL="${TRITON_GLINER_MODEL:-gliner_ner}"

exec python3 -m uvicorn gliner_only_fastapi_app:app \
  --app-dir "$REPO_ROOT" \
  --host "$HOST" \
  --port "$PORT"

