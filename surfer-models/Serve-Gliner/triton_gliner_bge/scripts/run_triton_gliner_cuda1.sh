#!/usr/bin/env bash
# Run Triton with ONLY gliner_ner on a single host GPU (default: physical CUDA device 1).
# Inside the container that GPU is always index 0 — matches model_repository/gliner_ner/config.pbtxt gpus: [0].
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Optional: load local .env (kept out of git) for secrets like HF_TOKEN.
# Expected format: KEY=VALUE per line.
if [[ -z "${HF_TOKEN:-}" && -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$REPO_ROOT/.env"
  set +a
fi

IMAGE="${TRITON_IMAGE:-triton-gliner-bge:latest}"
NAME="${TRITON_CONTAINER_NAME:-triton-gliner-cuda1}"
MODEL_SRC="${TRITON_MODEL_DIR:-$REPO_ROOT/model_repository/gliner_ner}"

# Host GPU index (0 = first GPU, 1 = second GPU, ...)
GPU_INDEX="${TRITON_CUDA_DEVICE:-1}"

HTTP_PORT="${TRITON_HTTP_PORT:-18090}"
GRPC_PORT="${TRITON_GRPC_PORT:-8011}"
METRICS_PORT="${TRITON_METRICS_PORT:-8012}"

if [[ ! -f "$MODEL_SRC/config.pbtxt" ]]; then
  echo "ERROR: missing $MODEL_SRC/config.pbtxt" >&2
  exit 1
fi

docker rm -f "$NAME" 2>/dev/null || true

ENV_ARGS=()
# huggingface_hub uses HF_TOKEN (and some libs also respect HUGGINGFACE_HUB_TOKEN).
if [[ -n "${HF_TOKEN:-}" ]]; then
  ENV_ARGS+=(-e "HF_TOKEN=${HF_TOKEN}" -e "HUGGINGFACE_HUB_TOKEN=${HF_TOKEN}")
fi

exec docker run -d \
  --name "$NAME" \
  --gpus "device=${GPU_INDEX}" \
  -p "${HTTP_PORT}:8000" \
  -p "${GRPC_PORT}:8001" \
  -p "${METRICS_PORT}:8002" \
  -v "${MODEL_SRC}:/models/gliner_ner:ro" \
  "${ENV_ARGS[@]}" \
  "$IMAGE" \
  tritonserver --model-repository=/models
