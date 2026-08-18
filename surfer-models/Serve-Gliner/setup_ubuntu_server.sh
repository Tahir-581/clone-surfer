#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="triton_gliner_stack.service"
PROJECT_DIR="/home/waqas/Waqas/Devs/Shamir/serfox/surfox-nlp/surfer-models/Serve-Gliner"
SERVICE_SRC="${PROJECT_DIR}/${SERVICE_NAME}"
SERVICE_DST="/etc/systemd/system/${SERVICE_NAME}"

echo "[1/5] Installing Python dependencies..."
python3 -m pip install --upgrade pip
python3 -m pip install -r "${PROJECT_DIR}/triton_gliner_bge/scripts/requirements-gliner-api.txt"

echo "[2/5] Installing systemd service..."
sudo cp "${SERVICE_SRC}" "${SERVICE_DST}"

echo "[3/5] Reloading systemd daemon..."
sudo systemctl daemon-reload

echo "[4/5] Enabling service at boot..."
sudo systemctl enable "${SERVICE_NAME}"

echo "[5/5] Starting service..."
sudo systemctl restart "${SERVICE_NAME}"

echo
echo "Service status:"
sudo systemctl status "${SERVICE_NAME}" --no-pager
echo
echo "Logs:"
echo "sudo journalctl -u ${SERVICE_NAME} -f"
