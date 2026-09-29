# Background

This file is attached to every verifier of `do-dog-genesis`. Write it in plain language; the
verifiers read it _before_ the instruction, and they cannot judge "does this match the user's goal"
without it. Copy it into your workspace next to `generated-dog.graph.json` and fill in the two
sections marked below.

## What DoG is for

DoG (DAG of Goals) turns "is this thing actually done well?" — a goal with no single pass/fail rule —
into a tree of goals that can each be reviewed on its own. Every leaf is judged by its own verifier
(one sentence, or one script); the engine records every verdict with its evidence; a composite node
combines its children and may carry its own whole-object assertion. DoG is a **judgment layer**: it
never produces, edits, or merges artifacts.

What is under review here is a **DoG graph itself** (`generated-dog.graph.json`) — not the artifact it
describes, but the declaration of how that artifact is meant to be accepted.

## What this graph is meant to solve

<!-- Fill in for the submission under review:
     - what the deliverable is,
     - which aspects of it this graph accepts,
     - why those aspects are the essential ones. -->

## The user's original words

<!-- Paste the user's own request here, verbatim. Without it, judgments like
     "does this faithfully reflect what the user wanted", "is there a branch unrelated to the goal",
     or "is any essential aspect missing" cannot be made. -->

## Reading a DoG graph (the field conventions these verifiers rely on)

- Each entry of `nodes` is either a **leaf** (it carries `verifier`, its one judgment) or a
  **composite** (it carries `completion`, a boolean combination of children).
- `contains` declares parent/child relations and failure policy: `required`, `failure`
  (`fatal` | `tolerable` | `degrade`), optional `degradeTo`.
- `completion` expressions are `ref` / `all` / `any` / `atLeast` / `not`; `ref` points at a child id.
- `dependsOn` is execution order only: `{ "source": "b", "target": "a" }` reads "b waits for a".
- `verifier` is either `{ "mode": "programmatic", "script": "<name in the script library>" }` or
  `{ "mode": "agentic", "instruction": "<one sentence that says what counts as good>" }`.
- A judgment's boundary is "what passes, what fails". Text that describes _how to produce_ something
  is not a judgment.
