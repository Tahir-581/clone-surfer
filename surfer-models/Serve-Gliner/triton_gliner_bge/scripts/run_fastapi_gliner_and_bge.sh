#!/usr/bin/env bash
set -euo pipefail

# Starts BOTH FastAPI wrappers on separate ports:
# - GLiNER: ${GLINER_API_PORT:-8081}
# - BGE:    ${BGE_API_PORT:-8082}
#
# Stop with Ctrl+C (sends termination to child processes).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GLINER_API_PORT="${GLINER_API_PORT:-8081}"
BGE_API_PORT="${BGE_API_PORT:-8082}"

export GLINER_API_PORT
export BGE_API_PORT

"$SCRIPT_DIR/run_gliner_fastapi.sh" &
GLINER_PID=$!

"$SCRIPT_DIR/run_bge_fastapi.sh" &
BGE_PID=$!

cleanup() {
  kill "$GLINER_PID" "$BGE_PID" 2>/dev/null || true
  wait "$GLINER_PID" "$BGE_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

wait "$GLINER_PID" "$BGE_PID"

