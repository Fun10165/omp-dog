#!/usr/bin/env bash
# Copy the engine from a dsh-dog checkout and report what changed.
#
# core/ is vendored verbatim from dsh-dog's src/core: it is the same engine both
# hosts run, and it keeps its upstream formatting and lint status on purpose so a
# sync produces a semantically-meaningful diff instead of a whitespace storm.
# This repository's own code (index.ts, omp/, test/) is formatted and linted to
# the host's conventions; `.oxlintrc.json` and the fmt scripts exclude core/.
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
echo "  1. bun run check       # lint + fmt + types + tests" >&2
echo "  2. bun run smoke       # end-to-end against a throwaway project" >&2
echo "  3. if core/model.ts changed its protocol, update omp/ and the graph section of" >&2
echo "     skills/dog-acceptance-gates/SKILL.md" >&2
