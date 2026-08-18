#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="/home/waqas/Waqas/Devs/Shamir/serfox/surfox-nlp/surfer-models"
TARGET_NAME="surfox-nlp-models.target"
SYSTEMD_DIR="/etc/systemd/system"

SERVICES=(
  "Serve-Embedding/bge_m3_server.service"
  "Serve-Gliner/triton_gliner_stack.service"
  "Serve-Reranker/bge-reranker.service"
)

echo "[1/6] Installing Python dependencies..."
python3 -m pip install --upgrade pip
python3 -m pip install vllm
python3 -m pip install -r "${ROOT_DIR}/Serve-Gliner/triton_gliner_bge/scripts/requirements-gliner-api.txt"

echo "[2/6] Ensuring reranker launcher is executable..."
chmod +x "${ROOT_DIR}/Serve-Reranker/bge-reranker"

echo "[3/6] Installing systemd unit files..."
for service_path in "${SERVICES[@]}"; do
  sudo cp "${ROOT_DIR}/${service_path}" "${SYSTEMD_DIR}/"
done
sudo cp "${ROOT_DIR}/${TARGET_NAME}" "${SYSTEMD_DIR}/"

echo "[4/6] Reloading systemd daemon..."
sudo systemctl daemon-reload

echo "[5/6] Enabling ${TARGET_NAME} at boot..."
sudo systemctl enable "${TARGET_NAME}"

echo "[6/6] Starting ${TARGET_NAME}..."
sudo systemctl restart "${TARGET_NAME}"

echo
echo "Target status:"
sudo systemctl status "${TARGET_NAME}" --no-pager
echo
echo "Service status:"
sudo systemctl status bge_m3_server.service triton_gliner_stack.service bge-reranker.service --no-pager
echo
echo "Logs:"
echo "  sudo journalctl -u bge_m3_server.service -f"
echo "  sudo journalctl -u triton_gliner_stack.service -f"
echo "  sudo journalctl -u bge-reranker.service -f"
