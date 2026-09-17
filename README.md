# omp-dog

DoG (DAG of Goals) acceptance gates for [OMP](https://github.com/can1357/oh-my-pi):
turn "is this deliverable actually good?" into per-goal judgment, each with its own
independent verifier, and leave an evidence ledger behind.

Ported from [dsh-dog](https://github.com/Fun10165/dsh-dog) (the DSH/Cordis deployment of
the same engine).

## What it is / is not

- **Is**: a graph of goals, a compile step that freezes every verifier target into
  immutable bytes, exactly two judgment kernels (a script, or a natural-language
  instruction), a content-addressed store and an append-only ledger, and incremental
  reuse of prior verdicts when neither the object nor the judgment changed.
- **Is not**: a work executor. DoG judges artifacts; producing them is the caller's job.
  And it is not a rules engine: a branch that is *entirely* mechanical belongs in ordinary
  tests, not here.

## Install

```bash
git clone https://github.com/Fun10165/omp-dog ~/Developer/omp-dog
cd ~/Developer/omp-dog && bun install
ln -s ~/Developer/omp-dog ~/.omp/agent/extensions/dog   # OMP discovers it in place
```

Restart the session: OMP has no extension hot reload. Verify with a fresh session —
`dog_create`, `dog_run`, `dog_status` should be top-level tools, and `dog_validate`,
`dog_cancel`, `dog_graph`, `dog_ledger` should appear as `xd://` devices.

  State lives in **`<project>/.omp/dog/`** — graphs, runs, captures, settlements and the
ledger travel with the repository they describe, not with your global agent directory.
`dog_ledger` reads one goal's verification record, its runtime events, and — for a goal
judged by a dispatched verifier — the **adoption record** naming who reported the verdict
(`verifier-bindings/`).

## Use

```
① dog_create {graphFile}   compile + freeze every target as immutable bytes
② dog_run {graphId}        either status:"needs_verification" (dispatch, then repeat)
                           or a terminal run summary
③ dog_status / dog_ledger  per-goal state, evidence, runtime events
```

**Write the graph to a file and pass `graphFile`** — a graph is a deeply nested literal
and one missing brace is a structural error the caller has to retype, so the file form is
the documented default. Inline graphs are accepted too (`graph`, as an object, with a
typed and described schema); the JSON-string form of earlier revisions is gone.

When `dog_run` returns `needs_verification`, each pending item carries a ready-to-paste
`verifierTask`. Dispatch it verbatim through the native `task` tool:

```json
{"context": "DoG agentic verification",
 "tasks": [{"name": "dog-1", "agent": "dog-verifier", "task": "<verifierTask text>"}]}
```

Then call `dog_run` again. **Never claim a goal verified yourself** — the engine judges
only settlement files written by dispatched verifiers, and it binds each verdict to the
bytes and the instruction it was issued for.

In the TUI every tool draws its own call and result line (a state line plus per-goal rows
when expanded), a `dog <rootState> ✓↺…` status line stays in the footer, a live panel
appears above the editor while a run is in flight or awaiting dispatch, and `/dog
[graphId]` opens the panel plus a run report card.

The full graph language and operational rules ship as a skill:
`skills/dog-acceptance-gates/SKILL.md`. OMP does not discover skills inside extension
packages, so install it where the session can see it (a managed skill).

## How a judgment happens

Two kernels, and only two:

| Kernel | Judged by | Contract |
|---|---|---|
| `programmatic` | a script from `scripts/` run through `pi.exec`, with the captured copy's path as its only argument | stdout `{"verdict":"pass\|fail\|inconclusive","evidence":…}`; a non-zero exit or unparsable output is `inconclusive` |
| `agentic` | a read-only `dog-verifier` subagent the **model** dispatches (`task`), because OMP exposes no extension API for spawning agents | the subagent writes one settlement file binding its verdict to `inputSha256`, `instructionHash`, and the request it answers |

Both kernels judge the **frozen capture**, never the live tree: the dispatch brief
materializes the captured bytes (a directory capture is unpacked) and the subagent is told
to read only that. A settlement whose recorded digest no longer matches the bytes, whose
instruction hash differs, or that predates its own dispatch request is treated as absent —
a stale verdict can never pass.

`dog_run` will not advance the engine while a required settlement is missing, so a run
cannot silently skip a gate; `mode: "force"` is the explicit escape hatch, and it settles
those goals as `needs_human` rather than passing them.

**Trust boundary.** The settlement is written by a subagent, and the model can write files
too, so a deliberately forged settlement is not cryptographically prevented (the DSH
deployment had the same property). What the binding guarantees is that no *stale* or
*mismatched* verdict can be reused as a pass. `agents/dog-verifier.md` is the only
component trusted to write one, and it is instructed to judge nothing but the frozen copy.
The adoption record is therefore provenance, not identity: it states which verifier the
settlement named for itself, on the same footing as the settlement it came from.

## Quality gates

```bash
bun run check     # oxlint + oxfmt --check + tsc --strict + vitest
bun run mutate    # calibrate the suite: inject faults, require the suite to go red
bun run smoke     # end-to-end against a throwaway project (three model turns)
```

- **`check`** mirrors the host repository's own gate shape (lint, format, types, tests).
- **`mutate`** is the reason to trust the suite. Each attack states a guarantee from this
  README and the smallest edit that breaks it; the harness injects it, runs the suite, and
  reports which tests failed. Which test catches a fault is *observed*, never named up
  front — an attack tuned to the tests would only prove the tests cover themselves.
  Current state: **16/16 broken guarantees caught**.
- **`smoke`** drives the real extension through three graphs and asserts on the engine's
  own persisted state (`<work>/.omp/dog/runs/*.json`, the settlement files), never on the
  model's prose.

Verified on the real host (OMP 18.2.3, macOS arm64): script kernel success with matching
evidence bytes; agentic kernel end-to-end with a dispatched verifier that re-derived the
bound digest; a falsification case where a bad sample fails the leaf and propagates to the
root; inheritance on re-run; dispatch pre-flight; TUI surfaces captured from a pty
session.

## Layout

```
index.ts            extension entry: 7 tools, the /dog command, the panel, the renderers
omp/                OMP adapter (config, kernels, settlement, dispatch, panel)
core/               the engine, vendored verbatim from dsh-dog (zero harness dependency)
agents/             dog-verifier.md — the read-only judge OMP's task tool discovers
skills/             product manual (not auto-discovered; install separately)
scripts/            the programmatic script library (CommonJS by contract)
schemas/schema-0.2/ JSON Schemas for every persisted record
test/               engine and adapter tests (vitest)
dev/                type-check sandbox, mutation calibration, core sync, smoke
```

**`core/` is vendored on purpose.** It is the same engine dsh-dog runs, and it keeps its
upstream formatting and lint status so that `dev/sync-core.sh` produces a
semantically-meaningful diff instead of a whitespace storm. This repository's own code
(`index.ts`, `omp/`, `test/`, `dev/`) is formatted and linted to the host's conventions;
`.oxlintrc.json` and the `fmt` scripts exclude `core/`.

## Caveats

- The engine shells out to `tar` for directory captures and for materializing a frozen
  object for a verifier.
- The script library is **CommonJS** while the repository is ESM, so `scripts/` carries its
  own `package.json` pinning `"type": "commonjs"`. Without that scope a `.js` script is
  loaded as an ES module, `require` is undefined, and every script-governed goal settles
  `inconclusive`. A script you drop into `scripts/` is CommonJS for the same reason.
- No hot reload: extension changes need a session restart. Loading takes no session-level
  action, so a broken edit cannot corrupt another session's state — it just fails to load.
- Two concurrent `dog_run` calls for the same graph race on the engine's own
  `supersedePriorRunningRuns`; run one graph at a time.
- Tools write only under `<project>/.omp/dog/` and never touch unrelated files.

## License

BSD 3-Clause (see `LICENSE`), same as the upstream engine.
