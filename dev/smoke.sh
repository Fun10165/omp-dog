#!/usr/bin/env bash
# End-to-end smoke against a throwaway project: the script kernel, the agentic
# kernel with a dispatched verifier, and a falsification case that must fail.
#
# Assertions read the engine's own persisted state (<work>/.omp/dog/runs/*.json
# and the dispatch settlement files), never the model's prose: a transcript can
# claim anything, a run record cannot.
#
# Costs three short model turns. Usage: dev/smoke.sh [model]
set -euo pipefail
cd "$(dirname "$0")/.."
model="${1:-deepseek/deepseek-flash}"
omp_bin="${OMP_BIN:-omp}"

work=$(mktemp -d "${TMPDIR:-/tmp}/omp-dog-smoke-XXXXXX")
printf 'smoke artifact\n' > "$work/artifact.txt"
printf 'this file deliberately does not contain the required line\n' > "$work/wrong.txt"

cat > "$work/script-graph.json" <<'JSON'
{"schemaVersion":"0.9","id":"smoke-script","root":"root","nodes":{
 "root":{"kind":"composite","title":"smoke root","constraint":"hard","target":"artifact.txt","completion":{"op":"ref","id":"leaf"}},
 "leaf":{"kind":"leaf","title":"artifact non empty","constraint":"hard","target":"artifact.txt","verifier":{"mode":"programmatic","script":"file-non-empty"}}},
 "contains":[{"parent":"root","child":"leaf","required":true,"failure":"fatal"}],"dependsOn":[]}
JSON

agentic_graph() { # $1=id $2=target $3=instruction
cat <<JSON
{"schemaVersion":"0.9","id":"$1","root":"root","nodes":{
 "root":{"kind":"composite","title":"$1 root","constraint":"hard","target":"$2","completion":{"op":"ref","id":"leaf"}},
 "leaf":{"kind":"leaf","title":"$1 leaf","constraint":"hard","target":"$2","verifier":{"mode":"agentic","instruction":"$3"}}},
 "contains":[{"parent":"root","child":"leaf","required":true,"failure":"fatal"}],"dependsOn":[]}
JSON
}
agentic_graph smoke-agentic artifact.txt "The captured file must contain the exact line: smoke artifact" > "$work/agentic-graph.json"
agentic_graph smoke-negative wrong.txt "The captured file must contain the exact line: smoke artifact" > "$work/negative-graph.json"

run() { # $1=prompt; prints the model's tail for diagnostics only
  ( cd "$work" && "$omp_bin" -p --model "$model" "$1" 2>&1 | tail -8 )
}

# rootState of the most recently updated run of one graph, read from the store.
root_state() { # $1=graphId
  node -e '
   const fs = require("node:fs"), path = require("node:path");
   const dir = path.join(process.argv[1], ".omp", "dog", "runs");
   const want = process.argv[2];
   let best = null;
   for (const file of fs.readdirSync(dir)) {
    const run = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    if (run.graphId !== want) continue;
    if (best === null || run.updatedAt > best.updatedAt) best = run;
   }
   process.stdout.write(best === null ? "no-run" : String(best.rootState ?? best.state));
  ' "$work" "$1"
}

settlements() { # how many settlement files the dispatch wrote
  find "$work/.omp/dog/dispatches" -name '*.settlement.json' 2>/dev/null | wc -l | tr -d ' '
}

failed=0
check() { # $1=label $2=expected $3=actual
  if [ "$2" = "$3" ]; then
    echo "PASS  $1 ($2)"
  else
    echo "FAIL  $1: expected $2, engine says $3"
    failed=1
  fi
}

echo "work dir: $work"

run "Do exactly this: read $work/script-graph.json, parse it as JSON, pass the parsed object as the 'graph' parameter to dog_create, then call dog_run with that graphId, then stop."
check "script kernel passes" "success" "$(root_state smoke-script)"

run "Do exactly this, in order: (1) read $work/agentic-graph.json, parse it as JSON and pass the parsed object as the 'graph' parameter to dog_create. (2) call dog_run with that graphId; it returns status needs_verification plus a pending item. (3) dispatch that item's verifierTask text verbatim with the task tool, called as: {\"context\":\"DoG agentic verification\",\"tasks\":[{\"name\":\"dog-smoke\",\"agent\":\"dog-verifier\",\"task\":\"<the verifierTask text>\"}]} and wait for it. (4) call dog_run again with the same graphId. (5) stop."
check "agentic kernel passes" "success" "$(root_state smoke-agentic)"
check "verifier wrote a settlement" "1" "$(settlements)"

run "Do exactly this, in order: (1) read $work/negative-graph.json, parse it as JSON and pass the parsed object as the 'graph' parameter to dog_create. (2) call dog_run with that graphId. (3) dispatch that item's verifierTask text verbatim with the task tool, called as: {\"context\":\"DoG agentic verification\",\"tasks\":[{\"name\":\"dog-neg\",\"agent\":\"dog-verifier\",\"task\":\"<the verifierTask text>\"}]} and wait for it. (4) call dog_run again with the same graphId. (5) stop."
check "bad sample is blocked" "failure" "$(root_state smoke-negative)"

echo
if [ "$failed" -eq 0 ]; then
  echo "all smoke checks passed ($work)"
else
  echo "smoke FAILED (artifacts kept in $work)"
  exit 1
fi
