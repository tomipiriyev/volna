#!/usr/bin/env bash
# Installs the pinned Emscripten SDK into ~/emsdk (or $EMSDK).
set -euo pipefail

VERSION="6.0.13"
EMSDK_DIR="${EMSDK:-$HOME/emsdk}"

# emsdk requires Python >= 3.10.
if [[ -z "${EMSDK_PYTHON:-}" ]]; then
  for p in python3.14 python3.13 python3.12 python3.11 python3.10; do
    if command -v "$p" >/dev/null 2>&1; then export EMSDK_PYTHON="$(command -v "$p")"; break; fi
  done
fi
[[ -n "${EMSDK_PYTHON:-}" ]] || { echo "error: emsdk needs Python >= 3.10" >&2; exit 1; }

[[ -d "$EMSDK_DIR" ]] || git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
cd "$EMSDK_DIR"
./emsdk install "$VERSION"
./emsdk activate "$VERSION"
echo "Emscripten $VERSION installed in $EMSDK_DIR"
