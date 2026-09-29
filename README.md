# omp-dog

DoG (DAG of Goals) acceptance gates for [OMP](https://github.com/can1357/oh-my-pi): turn
"is this deliverable actually good?" into per-goal judgment, each judged by its own
independent verifier, and leave an evidence ledger behind.

Ported from [dsh-dog](https://github.com/Fun10165/dsh-dog) (the DSH/Cordis deployment of
the same engine). **This deployment is not an OMP extension.** It is a plain program that
drives OMP over its RPC protocol: `omp-dog host` serves the DoG tools to a real session
through `set_host_tools`, and every agentic judgment is its own `omp --mode rpc` verifier
session whose verdict comes back as a host-tool call.

## What it is / is not

- **Is**: a graph of goals; a compile step that freezes every verifier target into
  immutable bytes; exactly two judgment kernels (a script, or a natural-language
  instruction judged by a session); a content-addressed store; an append-only evidence
  ledger; incremental reuse of a prior verdict when neither the object nor the judgment
  changed.
- **Is not**: a work executor (DoG judges artifacts; producing them is the caller's job),
  a rules engine (a branch that is *entirely* mechanical belongs in ordinary tests), or a
  plugin (it registers nothing with OMP at load time and needs no session restart to
  change).

## Install

```bash
git clone <this repo> ~/Developer/omp-dog
cd ~/Developer/omp-dog && bun install
```

Nothing else is installed into OMP: no extension entry, no `~/.omp/agent/extensions` link.
The CLI runs on Bun or Node 22.6+ (`node cli.ts …` strips types natively). `omp` must be
on `PATH` (or pass `--omp <path>` / set `OMP_BIN`).

## Use

```bash
# Compile a graph and freeze its targets; prints { graphId, graphDigest, acceptancePlans }
./cli.ts create graphs/article-quality.json --project .

# Judge the latest revision; prints the run report. Exit 0 on success/partial_success.
./cli.ts run article-quality --project .

# Read one run record (by run ID, or the latest terminal run of a graph ID)
./cli.ts status article-quality --project .

# Start an OMP session whose DoG tools this process serves over RPC
./cli.ts host --project . --model <provider/model> [-- <extra omp flags>]
```

Options: `--project <dir>`, `--omp <path>`, `--model <m>`, `--thinking <level>`,
`--concurrency <n>` (concurrent verifier sessions, default 4), `--timeout <seconds>`
(verdict budget per verifier, default 900). State lives in **`<project>/.omp/dog/`** —
graphs, runs, captures and verifier sessions travel with the repository they describe.

In `host` mode the session sees four extra tools:

| Tool | Contract |
|---|---|
| `dog_validate` | static graph validation; writes nothing |
| `dog_create` | compile + freeze every target; returns the `graphId` |
| `dog_run` | judge the latest revision and return the run report (streams per-goal progress as tool updates) |
| `dog_status` | read one run record |

## How a judgment happens

Two kernels, and only two:

| Kernel | Judged by | Contract |
|---|---|---|
| `programmatic` | a script from `scripts/`, run with the frozen object's path as its only argument | stdout `{"verdict":"pass\|fail\|inconclusive","evidence":…}`; a non-zero exit or unparsable output is `inconclusive` |
| `agentic` | one `omp --mode rpc` verifier session, spawned per goal | the session reads the frozen object and calls the host tool `dog_submit_verdict` once; that call *is* the verdict |

A verifier session is started with a frozen plan, because OMP fixes the tool face and the
system prompt at launch:

```bash
omp --mode rpc --no-ui --no-extensions --no-skills --no-rules \
    --tools read,grep,glob,find --cwd <frozen object dir> \
    --session-dir <evidence dir> --append-system-prompt "<prompts/verifier.md>"
```

The engine places the captured bytes in that working directory (a directory capture is
unpacked) and the brief names the object, its byte size, and its sha256 — so a verifier
judges the *frozen* bytes, never the live tree. A session that never submits a verdict, or
that exceeds its budget, settles `inconclusive` and the goal becomes `needs_human`: a
missing verdict can never pass a gate.

**Freezing is clone-based.** A file target is hashed by streaming, then *cloned* into the
store (APFS `clonefile` via `cp -c`, Linux reflink via `cp --reflink=always`), so a large
object is never buffered in memory or written twice; the same clone places it in the
verifier's workspace. Where the filesystem cannot clone — another volume, another
filesystem, a reflink-less kernel — the bytes are copied instead, and `OMP_DOG_NO_COW=1`
forces that path. (Measured on APFS, 500 MiB: `cp -c` 1 ms and no extra space, a plain
`cp` 120 ms and 500 MiB. Node's own `fs.copyFile` also clones on macOS, so the fallback
still shares blocks there and only Linux pays a real copy.) Before materializing, the
stored bytes are re-hashed against the manifest, so a corrupted store is refused rather
than judged. Directory targets are packed into one `.tar` whose members keep their relative
paths, and unpacked into the verifier's working directory.

**Provenance.** Every agentic verdict records the verifier session's transcript path, so
"who judged this, and on what evidence" is answerable after the fact. The verdict itself is
the session's own; the engine binds it to the bytes and the instruction it was issued for.

## The graph (schemaVersion `0.9`)

```jsonc
{
  "schemaVersion": "0.9",
  "id": "article-quality",
  "root": "root",
  "nodes": {
    "root": { "kind": "composite", "title": "…", "constraint": "hard", "target": "article.md",
              "completion": { "op": "all", "items": [{ "op": "ref", "id": "no-slop" }] },
              "verifier": { "mode": "agentic", "instruction": "overall assertion…" } },
    "no-slop": { "kind": "leaf", "title": "…", "constraint": "hard", "target": "article.md",
                 "verifier": { "mode": "agentic", "instruction": "check for AI slop…" } }
  },
  "contains": [{ "parent": "root", "child": "no-slop", "required": true, "failure": "fatal" }],
  "dependsOn": []
}
```

- `leaf` = one verifier; `composite` = a `completion` expression over its children
  (`ref` / `all` / `any` / `not` / `atLeast`) plus an optional **whole-object assertion**
  that runs after the subtree settles and can only *demote* the result.
- `contains` carries `required`, `failure` (`fatal` / `tolerable` / `degrade`) and
  `degradeTo`; failures propagate upward until a relation tolerates them.
- `dependsOn` reads "{source} waits for {target}": a scheduling gate, nothing more.
- `target` is a workspace-relative path (file, or directory → packed into a `.tar`).
- The root is `composite` with `constraint: "hard"`.

The full language and operational rules ship as a skill:
[`skills/dog-acceptance-gates/SKILL.md`](skills/dog-acceptance-gates/SKILL.md). OMP does not
discover skills inside arbitrary repositories; install it where the session can see it (a
managed skill, `~/.omp/agent/skills/<name>/SKILL.md`, or `.omp/skills/<name>/SKILL.md` in
the project).

## Inheritance

The inheritance anchor is `sha256({object digest, judgment identity})`, where the judgment
identity is the script's content hash, or the sha256 of the instruction text. When the
anchor matches the graph's most recent terminal run and that run has a verification record
for the goal, the goal settles `inherited` and no verifier runs. Change the object or the
instruction and it re-runs. A fresh or fully re-verified submission is normal; reuse is
what makes iteration cheap.

## Limits (read before trusting a green root)

- **Agentic judgments are single-shot**: one isolated verifier session per goal, no
  re-check, no voting.
- **Inheritance anchors, it does not re-verify**: an unchanged agentic leaf reuses its
  prior verdict, so drift in model behavior stays invisible until the anchor changes.
- **A verdict is written by a model-driven session.** The engine binds it to the frozen
  bytes and the instruction, which rules out stale or mismatched reuse — it is not
  cryptographic proof of independence.
- Anything that must be reproducible belongs in a programmatic script; anything
  judgment-based is best read as evidence, with human confirmation for high-stakes goals.

## Quality gates

```bash
bun run check   # oxlint + oxfmt --check + tsc --strict + vitest
bun run smoke   # end-to-end against a throwaway project (two model turns)
```

`smoke` runs four cases — script kernel, agentic kernel through a real verifier session,
inheritance on re-run, and a falsification case that must fail the root — and asserts on
the engine's own persisted report, never on the model's prose.

## Layout

```
cli.ts              entry: create / run / status / host
omp/                OMP-facing adapter: rpc client, verifier kernel, host session, report
core/               engine: graph parsing, capture, scheduling, composition, inheritance
prompts/verifier.md the persona appended to every verifier session
scripts/            the programmatic script library (CommonJS by contract)
skills/             the product manual for an agent (install separately)
examples/           ready-to-run demo graphs
test/               engine, RPC and kernel tests (vitest), plus a fake RPC server
dev/smoke.sh        the end-to-end gate
```

## Caveats

- The engine shells out to `cp` (clone or copy) and to `tar` for directory captures and their
  unpacking.
- Cloning is an optimization with a real fallback, not a requirement: every path behaves identically
  when `cp` cannot clone. Set `OMP_DOG_NO_COW=1` on filesystems where cloning is unreliable.
- The script library is **CommonJS** while the repository is ESM, so `scripts/` carries its
  own `package.json` pinning `"type": "commonjs"`.
- Two concurrent `run`s of the same graph race on supersede bookkeeping; run one graph at a
  time.
- `--tools` on the verifier sessions is a tool *selection*, not a whitelist, which is why
  the sessions are also started with `--no-extensions --no-skills --no-rules`.
- Tools write only under `<project>/.omp/dog/` and never touch unrelated files.

## License

BSD 3-Clause (see `LICENSE`), same as the upstream engine.
