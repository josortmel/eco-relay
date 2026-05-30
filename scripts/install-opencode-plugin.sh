#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_SH="${SCRIPT_DIR}/install.sh"

if [ -f "${INSTALL_SH}" ]; then
    exec bash "${INSTALL_SH}"
else
    echo "ERROR: install.sh not found at ${INSTALL_SH}"
    echo "Run: bash scripts/install.sh"
    exit 1
fi
