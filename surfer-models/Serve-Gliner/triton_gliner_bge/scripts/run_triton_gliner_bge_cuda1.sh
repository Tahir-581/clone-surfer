#!/usr/bin/env bash
# Run Triton with BOTH gliner_ner + bge_embeddings on a single host GPU (default: physical CUDA device 1).
# Inside the container that GPU is always index 0 — matches config.pbtxt instance_group gpus: [0].
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
NAME="${TRITON_CONTAINER_NAME:-triton-gliner-bge-cuda1}"
MODEL_REPO_DIR="${TRITON_MODEL_REPO_DIR:-$REPO_ROOT/model_repository}"

# By default, serve only GLiNER + BGE (avoid loading whisper unless explicitly requested).
SERVE_WHISPER="${TRITON_SERVE_WHISPER:-0}"

# Host GPU index (0 = first GPU, 1 = second GPU, ...)
GPU_INDEX="${TRITON_CUDA_DEVICE:-1}"

# Host ports (container uses 8000/8001/8002)
HTTP_PORT="${TRITON_HTTP_PORT:-18090}"
GRPC_PORT="${TRITON_GRPC_PORT:-18091}"
METRICS_PORT="${TRITON_METRICS_PORT:-18092}"

if [[ ! -d "$MODEL_REPO_DIR" ]]; then
  echo "ERROR: missing model repository dir: $MODEL_REPO_DIR" >&2
  exit 1
fi
if [[ ! -f "$MODEL_REPO_DIR/gliner_ner/config.pbtxt" ]]; then
  echo "ERROR: missing $MODEL_REPO_DIR/gliner_ner/config.pbtxt" >&2
  exit 1
fi
if [[ ! -f "$MODEL_REPO_DIR/bge_embeddings/config.pbtxt" ]]; then
  echo "ERROR: missing $MODEL_REPO_DIR/bge_embeddings/config.pbtxt" >&2
  exit 1
fi

docker rm -f "$NAME" 2>/dev/null || true

ENV_ARGS=()
# Prefer passing token via environment (do NOT hardcode it here).
# huggingface_hub uses HF_TOKEN (and some libs also respect HUGGINGFACE_HUB_TOKEN).
if [[ -n "${HF_TOKEN:-}" ]]; then
  ENV_ARGS+=(-e "HF_TOKEN=${HF_TOKEN}" -e "HUGGINGFACE_HUB_TOKEN=${HF_TOKEN}")
fi

MODEL_MOUNT_DIR="$MODEL_REPO_DIR"
TMP_REPO=""
if [[ "$SERVE_WHISPER" != "1" ]]; then
  TMP_REPO="$(mktemp -d)"
  mkdir -p "$TMP_REPO"
  # Copy (not symlink) so container sees real directories even under bind-mount.
  cp -a "$MODEL_REPO_DIR/gliner_ner" "$TMP_REPO/gliner_ner"
  cp -a "$MODEL_REPO_DIR/bge_embeddings" "$TMP_REPO/bge_embeddings"
  MODEL_MOUNT_DIR="$TMP_REPO"
fi

exec docker run -d \
  --name "$NAME" \
  --gpus "device=${GPU_INDEX}" \
  -p "${HTTP_PORT}:8000" \
  -p "${GRPC_PORT}:8001" \
  -p "${METRICS_PORT}:8002" \
  -v "${MODEL_MOUNT_DIR}:/models:ro" \
  "${ENV_ARGS[@]}" \
  "$IMAGE" \
  tritonserver --model-repository=/models