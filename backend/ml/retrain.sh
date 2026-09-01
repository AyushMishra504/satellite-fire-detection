#!/usr/bin/env bash
# Rebuild the ML training dataset and retrain the ONNX models.
#
#   bash ml/retrain.sh            # warm context, rebuild dataset, retrain
#   bash ml/retrain.sh --no-warm  # skip the (network) context warm pass
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$(dirname "$HERE")"

echo "[retrain] Building dataset..."
node "$BACKEND/scripts/build-dataset.js" "$@"

echo "[retrain] Training models..."
python3 "$HERE/train.py"

echo "[retrain] Done. Restart the Node backend to reload the fresh ONNX models."
