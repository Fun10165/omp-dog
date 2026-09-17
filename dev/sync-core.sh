#!/usr/bin/env bash
# Copy the engine from a dsh-dog checkout and report what changed.
#
# core/ is a verbatim copy of dsh-dog's src/core — zero harness imports, so the
# same files serve both hosts. The two repositories are independent products, so
# this is a deliberate, visible sync rather than a shared package.
set -euo pipefail
cd "$(dirname "$0")/.."

src="${1:?usage: dev/sync-core.sh /path/to/dsh-dog}"
[ -d "$src/src/core" ] || { echo "no src/core under $src" >&2; exit 1; }

if [ -n "$(git status --porcelain core 2>/dev/null || true)" ]; then
  echo "note: core/ already has local modifications; review the diff after syncing." >&2
fi

cp "$src"/src/core/*.ts core/
echo "--- core diff after sync ---"
git --no-pager diff --stat core || true
echo
echo "then:" >&2
echo "  1. bun run test        # engine + store tests" >&2
echo "  2. bun run typecheck   # adapter still compiles" >&2
echo "  3. if core/model.ts changed its protocol, update omp/ and the graph section of" >&2
echo "     skills/dog-acceptance-gates/SKILL.md" >&2
