#!/usr/bin/env bash
# End-to-end smoke against a throwaway project.
#
# Four cases: the script kernel, the agentic kernel (a real `omp --mode rpc`
# verifier session decides and reports over RPC), a falsification case that must
# fail, and inheritance on re-run. Assertions read the engine's own persisted
# report (stdout JSON + <work>/.omp/dog/runs/*.json), never the model's prose.
#
# Costs two short model turns (cases 2 and 3). Usage: dev/smoke.sh [model]
set -euo pipefail
cd "$(dirname "$0")/.."
model="${1:-deepseek/deepseek-flash}"

work=$(mktemp -d "${TMPDIR:-/tmp}/omp-dog-smoke-XXXXXX")
printf 'smoke artifact\n' > "$work/artifact.txt"
printf 'this file deliberately does not contain the required line\n' > "$work/wrong.txt"

cat > "$work/graphs.mjs" <<'JS'
// Emit the smoke graphs, so the shell stays readable.
import { writeFileSync } from "node:fs";
const dir = process.argv[2];
const leaf = (id, title, target, goal) => [id, {
  kind: "leaf", title, constraint: "hard", target,
  ...(goal === undefined
    ? { verifier: { mode: "programmatic", script: "file-non-empty" } }
    : { verifier: { mode: "agentic", goal } }),
}];
const graph = (id, target, goal) => ({
  schemaVersion: "0.9",
  id,
  root: "root",
  nodes: Object.fromEntries([
    ["root", {
      kind: "composite", title: "root", constraint: "hard", target,
      completion: { op: "all", items: [{ op: "ref", id: "leaf" }] },
    }],
    leaf("leaf", "smoke leaf", target, goal),
  ]),
  contains: [{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
  dependsOn: [],
});
writeFileSync(`${dir}/script-graph.json`, JSON.stringify(graph("smoke-script", "artifact.txt"), null, 2));
writeFileSync(`${dir}/agentic-graph.json`, JSON.stringify(
  graph("smoke-agentic", "artifact.txt", "The captured file must contain the exact line: smoke artifact"), null, 2));
writeFileSync(`${dir}/negative-graph.json`, JSON.stringify(
  graph("smoke-negative", "wrong.txt", "The captured file must contain the exact line: smoke artifact"), null, 2));
writeFileSync(`${dir}/dir-graph.json`, JSON.stringify(
  graph("smoke-directory", "bundle",
    "The captured directory must contain a file named inside.txt whose only line is: smoke artifact"), null, 2));
writeFileSync(`${dir}/git-graph.json`, JSON.stringify({
  schemaVersion: "0.9", id: "smoke-git", root: "root",
  nodes: {
    root: {
      kind: "composite", title: "root", constraint: "hard", target: { kind: "git", ref: "HEAD" },
      completion: { op: "all", items: [{ op: "ref", id: "leaf" }] },
    },
    leaf: {
      kind: "leaf", title: "smoke git leaf", constraint: "hard", target: { kind: "git", ref: "HEAD" },
      verifier: { mode: "programmatic", script: "file-non-empty" },
    },
  },
  contains: [{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
  dependsOn: [],
}, null, 2));
JS
node "$work/graphs.mjs" "$work"
mkdir -p "$work/bundle"
printf 'smoke artifact\n' > "$work/bundle/inside.txt"

dog() { bun cli.ts "$@" --project "$work" --model "$model"; }

graph_id() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).graphId)' "$1"; }
root_state() { node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).rootState))' "$1"; }
inherited() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).inherited.join(","))' "$1"; }

failed=0
check() { # $1=label $2=expected $3=actual
	if [ "$2" = "$3" ]; then
		printf '  ✓ %s: %s\n' "$1" "$3"
	else
		printf '  ✗ %s: expected %s, got %s\n' "$1" "$2" "$3"
		failed=$((failed + 1))
	fi
}

echo "work dir: $work"

echo "case 0 — the CLI loads under Node's type stripping as well as Bun"
if node --experimental-strip-types cli.ts --help >/dev/null 2>&1; then
	check "node can load cli.ts" "ok" "ok"
else
	check "node can load cli.ts" "ok" "failed (strip-only unsupported syntax in a source file)"
fi

echo "case 1 — script kernel (no model turn)"
dog create "$work/script-graph.json" > "$work/script-create.json"
dog run "$(graph_id "$work/script-create.json")" > "$work/script-run.json"
check "script kernel" "success" "$(root_state "$work/script-run.json")"

echo "case 2 — agentic kernel (one verifier session over RPC)"
dog create "$work/agentic-graph.json" > "$work/agentic-create.json"
agentic_id="$(graph_id "$work/agentic-create.json")"
dog run "$agentic_id" > "$work/agentic-run.json"
check "agentic kernel" "success" "$(root_state "$work/agentic-run.json")"
check "verifier session recorded" "agentic" \
	"$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).goals.find(g=>g.goalId==="leaf").verifier.mode)' "$work/agentic-run.json")"

echo "case 3 — inheritance (same graph, same bytes)"
dog run "$agentic_id" > "$work/agentic-rerun.json"
check "leaf inherited" "leaf" "$(inherited "$work/agentic-rerun.json")"

echo "case 4 — falsification (a bad sample must fail the root)"
dog create "$work/negative-graph.json" > "$work/negative-create.json"
dog run "$(graph_id "$work/negative-create.json")" > "$work/negative-run.json" || true
check "bad sample is blocked" "failure" "$(root_state "$work/negative-run.json")"

echo "case 5 — directory target (frozen as a tree, cloned for the verifier)"
dog create "$work/dir-graph.json" > "$work/dir-create.json"
check "directory capture is a tree" "tree:" \
	"$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).acceptancePlans.find(p=>p.goalId==="leaf").digest.slice(0,5))' "$work/dir-create.json")"
dog run "$(graph_id "$work/dir-create.json")" > "$work/dir-run.json"
check "verifier reads the frozen tree" "success" "$(root_state "$work/dir-run.json")"
dog run "$(graph_id "$work/dir-create.json")" > "$work/dir-rerun.json"
check "tree leaf inherited on re-run" "leaf" "$(inherited "$work/dir-rerun.json")"

echo "case 6 — git target (a commit, not the working tree)"
(
	cd "$work" && git init -q &&
		git -c user.email=dog@example.com -c user.name=DoG add -A &&
		git -c user.email=dog@example.com -c user.name=DoG commit -q -m initial
)
dog create "$work/git-graph.json" > "$work/git-create.json"
check "git capture is keyed by the commit" "git:" \
	"$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).acceptancePlans.find(p=>p.goalId==="leaf").digest.slice(0,4))' "$work/git-create.json")"
dog run "$(graph_id "$work/git-create.json")" > "$work/git-run.json"
check "git tree judged" "success" "$(root_state "$work/git-run.json")"
dog run "$(graph_id "$work/git-create.json")" > "$work/git-rerun.json"
check "git leaf inherited on re-run" "leaf" "$(inherited "$work/git-rerun.json")"

echo
if [ "$failed" -eq 0 ]; then
	echo "smoke: all cases passed"
else
	echo "smoke: $failed case(s) failed; work dir kept at $work" >&2
	exit 1
fi
