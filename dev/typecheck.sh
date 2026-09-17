#!/usr/bin/env bash
# Type-check the extension against the real OMP type surface.
#
# The @oh-my-pi/* packages install into dev/typecheck/ rather than the repository
# root on purpose: the extension's own node_modules must not carry a second copy
# of pi-tui / pi-coding-agent. OMP rewrites static imports of those specifiers to
# its bundled copies, and a local duplicate would be a silent version skew.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d dev/typecheck/node_modules/@oh-my-pi ]; then
  echo "installing type-check dependencies into dev/typecheck …" >&2
  (cd dev/typecheck && bun install)
fi

exec ./node_modules/.bin/tsc -p tsconfig.json "$@"
