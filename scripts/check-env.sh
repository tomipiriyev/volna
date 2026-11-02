#!/usr/bin/env bash
# Reports the toolchain this project needs and whether each piece is present.
set -uo pipefail

status=0
check() { # name, command, required(1/0)
  local out
  if out=$(eval "$2" 2>/dev/null) && [[ -n "$out" ]]; then
    printf '  %-14s %s\n' "$1" "$(echo "$out" | head -1)"
  else
    printf '  %-14s MISSING%s\n' "$1" "$([[ $3 == 1 ]] && echo ' (required)')"
    [[ $3 == 1 ]] && status=1
  fi
}

echo "Toolchain:"
check node "node --version" 1
check npm "npm --version" 1
check cmake "cmake --version" 1
check c++ "c++ --version" 1
EMSDK_DIR="${EMSDK:-$HOME/emsdk}"
check emsdk "test -f '$EMSDK_DIR/emsdk_env.sh' && echo '$EMSDK_DIR'" 1
check em++ "command -v em++ >/dev/null && em++ --version || (test -x '$EMSDK_DIR/upstream/emscripten/em++' && echo 'installed (not on PATH; build-wasm.sh sources emsdk_env.sh)')" 1
check python3.10+ "for p in python3.14 python3.13 python3.12 python3.11 python3.10; do command -v \$p && break; done" 1
check openEMS "test -x '$HOME/opt/openEMS/bin/openEMS' && echo '$HOME/opt/openEMS (validation reference only)'" 0
check playwright "npx --no-install playwright --version" 0
exit $status
