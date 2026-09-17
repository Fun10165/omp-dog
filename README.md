# omp-dog

DoG (DAG of Goals) acceptance gates for [OMP](https://github.com/can1357/oh-my-pi):
turn "is this deliverable actually good?" into per-goal judgment, each with its own
independent verifier, and leave an evidence ledger behind.

Ported from [dsh-dog](https://github.com/Fun10165/dsh-dog) (the DSH/Cordis deployment of
the same engine).

## What it is / is not

- **Is**: a graph of goals, a compilation step that freezes every verifier target into
  immutable bytes, exactly two judgment kernels (a script, or a natural-language
  instruction), a content-addressed store and an append-only ledger, and incremental
  reuse of prior verdicts when neither the object nor the judgment changed.
- **Is not**: a work executor. DoG judges artifacts; producing them is the caller's job.
  And it is not a rules engine: any branch that is *entirely* mechanical belongs in
  ordinary tests, not here.

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

## Use

```
① dog_create {graph}    compile + freeze every target as immutable bytes
② dog_run {graphId}     either status:"needs_verification" (dispatch, then repeat)
                        or a terminal run summary
③ dog_status / dog_ledger   per-goal state, evidence, runtime events
```

When `dog_run` returns `needs_verification`, each pending item carries a ready-to-paste
`verifierTask`. Dispatch it verbatim through the native `task` tool:

```json
{"context": "DoG agentic verification",
 "tasks": [{"name": "dog-1", "agent": "dog-verifier", "task": "<verifierTask text>"}]}
```

Then call `dog_run` again. **Never claim a goal verified yourself** — the engine judges
only settlement files written by dispatched verifiers, and it binds each verdict to the
bytes and the instruction it was issued for.

In the TUI: a `dog <rootState> ✓↺…` status line, a live panel above the editor while a run
is in flight or awaiting dispatch, and `/dog [graphId]` for the panel plus a run report
card.

The full graph language and operational rules ship as a skill:
`skills/dog-acceptance-gates/SKILL.md` (install it where your session can see it —
OMP does not discover skills inside extension packages).

## How a judgment happens

Two kernels, and only two:

| Kernel | Judged by | Contract |
|---|---|---|
| `programmatic` | a script from `scripts/` run through `pi.exec`, with the captured copy's path as its only argument | stdout `{"verdict":"pass\|fail\|inconclusive","evidence":…}`; non-zero exit or unparsable output is `inconclusive` |
| `agentic` | a read-only `dog-verifier` subagent the **model** dispatches (`task`), because OMP exposes no extension API for spawning agents | the subagent writes one settlement file binding its verdict to `inputSha256`, `instructionHash`, and the request it answers |

Both kernels judge the **frozen capture**, never the live tree: the dispatch brief
materializes the captured bytes (a directory capture is unpacked) and the subagent is
told to read only that. A settlement whose recorded digest no longer matches the bytes,
whose instruction hash differs, or that predates its own dispatch request is treated as
absent — a stale verdict can never pass.

**Trust boundary.** The settlement is written by a subagent, and the model can write
files too, so a deliberately forged settlement is not cryptographically prevented (the
DSH deployment had the same property). What the binding does guarantee is that no *stale*
or *mismatched* verdict can ever be reused as a pass.

## Falsification-tested, not just happy-path

Verified on the real host (OMP 18.2.3, macOS arm64):

| Check | Result |
|---|---|
| script kernel end-to-end | `rootState: success`, evidence `{outcome:"object is non-empty",bytes:15}` matching the artifact |
| agentic kernel end-to-end | model dispatched `dog-verifier` → subagent read the frozen copy, re-derived sha256 and matched the bound digest → settlement → engine `success` (35 s) |
| **bad sample blocked** | artifact lacking the required line → verifier `fail` → leaf `failure` → root `failed` via "required non-tolerable child leaf failed" |
| inheritance | re-running an unchanged graph yields leaf `inherited` pointing at the source run, with evidence retained and no re-judgment |
| dispatch pre-flight | `dog_run` with an outstanding verifier returns `needs_verification` without running the engine, so a run is never poisoned by a missing settlement |
| TUI surfaces | status line, widget rows and the `/dog` report card captured from a real pty session |
| type check | `tsc --strict` clean |

## Layout

```
index.ts            extension entry: 7 tools, the /dog command, the panel
omp/                OMP adapter (config, kernels, settlement, dispatch, panel)
core/               the engine, verbatim from dsh-dog (zero harness dependency)
agents/             dog-verifier.md — the read-only judge OMP's task tool discovers
skills/             product manual (not auto-discovered; install separately)
scripts/            the programmatic script library
schemas/schema-0.2/ JSON Schemas for every persisted record
tests/              engine and store tests
dev/                type-check sandbox and the core sync helper
```

`core/` is a **verbatim copy** of `dsh-dog`'s `src/core/` (12 files, zero
`@deepseek-ai` imports). Fixes to the engine must land in both repositories;
`dev/sync-core.sh <dsh-dog-checkout>` copies and reports the diff.

## Caveats

- The engine shells out to `tar` for directory captures and for materializing a frozen
  object for a verifier.
- The script library is **CommonJS** while the repository is ESM, so `scripts/` carries its
  own `package.json` pinning `"type": "commonjs"`. Without that scope a `.js` script is
  loaded as an ES module, `require` is undefined, and every script-governed goal settles
  `inconclusive`. A script you drop into `scripts/` is CommonJS for the same reason.
- No hot reload: extension changes need a session restart. Loading takes no session-level
  action, so a broken edit cannot corrupt another session's state — it just fails to load.
- Tools write only under `<project>/.omp/dog/` and never touch unrelated files.

## License

BSD 3-Clause (see `LICENSE`), same as the upstream engine.
