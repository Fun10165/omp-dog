#!/usr/bin/env bash
# End-to-end smoke against a throwaway project: the script kernel, the agentic
# kernel with a dispatched verifier, and a falsification case that must fail.
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

run() { # $1=prompt
  ( cd "$work" && "$omp_bin" -p --model "$model" "$1" 2>&1 | tail -60 )
}

expect() { # $1=label $2=needle $3=output
  if grep -q "$2" <<<"$3"; then
    echo "PASS  $1"
  else
    echo "FAIL  $1 (looked for: $2)"
    echo "$3" | tail -20
    failed=1
  fi
}

failed=0
echo "work dir: $work"

out=$(run "Do exactly this: read the file $work/script-graph.json, parse it as JSON, pass the parsed object as the 'graph' parameter to dog_create, then call dog_run with that graphId, then reply with only the raw JSON that dog_run returned.")
expect "script kernel passes" '"rootState": "success"' "$out"

request="Do exactly this, in order: (1) read $work/agentic-graph.json, parse it as JSON and pass the parsed object as the 'graph' parameter to dog_create. (2) call dog_run with that graphId; it returns status needs_verification plus a pending item. (3) dispatch that item's verifierTask text verbatim with the task tool, called as: {\"context\":\"DoG agentic verification\",\"tasks\":[{\"name\":\"dog-smoke\",\"agent\":\"dog-verifier\",\"task\":\"<the verifierTask text>\"}]} and wait for it. (4) call dog_run again with the same graphId. (5) reply with only the raw JSON from step (4)."
out=$(run "$request")
expect "agentic kernel passes" '"rootState": "success"' "$out"

request="Do exactly this, in order: (1) read $work/negative-graph.json, parse it as JSON and pass the parsed object as the 'graph' parameter to dog_create. (2) call dog_run with that graphId. (3) dispatch that item's verifierTask text verbatim with the task tool, called as: {\"context\":\"DoG agentic verification\",\"tasks\":[{\"name\":\"dog-neg\",\"agent\":\"dog-verifier\",\"task\":\"<the verifierTask text>\"}]} and wait for it. (4) call dog_run again with the same graphId. (5) reply with only the raw JSON from step (4)."
out=$(run "$request")
expect "bad sample is blocked" '"rootState": "failure"' "$out"

echo
if [ "$failed" -eq 0 ]; then
  echo "all smoke checks passed ($work)"
else
  echo "smoke FAILED (artifacts kept in $work)"
  exit 1
fi
