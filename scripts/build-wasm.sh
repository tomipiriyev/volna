#!/usr/bin/env bash
# Builds the single-thread and multi-thread (pthreads) solver modules with
# Emscripten and copies them to app/public/wasm/, where the solver worker
# loads them at runtime (they are not bundled by Vite).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMSDK_DIR="${EMSDK:-$HOME/emsdk}"

if ! command -v em++ >/dev/null 2>&1; then
  if [[ ! -f "$EMSDK_DIR/emsdk_env.sh" ]]; then
    echo "error: emsdk not found at $EMSDK_DIR (set EMSDK or run scripts/setup-emsdk.sh)" >&2
    exit 1
  fi
  # emsdk needs Python >= 3.10; prefer Homebrew's if the default is older.
  if [[ -z "${EMSDK_PYTHON:-}" ]]; then
    for p in python3.14 python3.13 python3.12 python3.11 python3.10; do
      if command -v "$p" >/dev/null 2>&1; then export EMSDK_PYTHON="$(command -v "$p")"; break; fi
    done
  fi
  # shellcheck disable=SC1091
  source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
fi

echo "emcc: $(emcc --version | head -1)"
OUT="$ROOT/app/public/wasm"
mkdir -p "$OUT"

for variant in st mt; do
  (cd "$ROOT/cpp" && cmake --preset "wasm-$variant" >/dev/null && cmake --build --preset "wasm-$variant" -j 8)
  cp "$ROOT/build/wasm-$variant/antsim-$variant.js" "$ROOT/build/wasm-$variant/antsim-$variant.wasm" "$OUT/"
done

ls -l "$OUT"
