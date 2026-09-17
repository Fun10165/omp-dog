/**
 * Panel: the DSH web debugger's replacement.
 *
 * OMP renders extensions only in the terminal, so a run is surfaced as a
 * status-line glyph, a widget above the editor, and a `/dog` command view.
 * Everything here is pure string formatting over persisted run state — the
 * same projections the tools return, so what the panel shows and what a tool
 * reports can never drift.
 */

import type { CompiledGraph, DogRun, GoalState } from '../core/model.ts'

const GLYPHS: Record<GoalState, string> = {
 pending: '·',
 running: '▶',
 success: '✓',
 failure: '✗',
 blocked: '⏸',
 needs_human: '?',
 cancelled: '⊘',
 invalidated: '⊘',
 partial: '◐',
 inherited: '↺',
}

/** One glyph per goal, in graph order, with the root state in front. */
export function statusText(run: DogRun | undefined, compiled: CompiledGraph | undefined): string | undefined {
 if (run === undefined) return undefined
 const rootState = run.rootState ?? run.state
 if (compiled === undefined) return `dog ${rootState}`
 const order = Object.keys(compiled.input.nodes)
 const glyphs = order.map(goalId => GLYPHS[run.goals[goalId]?.state ?? 'pending']).join('')
 return `dog ${rootState} ${glyphs}`
}

/** Bounded widget body: one line per goal, never more than `limit` goals. */
export function panelLines(options: {
 readonly run: DogRun | undefined
 readonly compiled: CompiledGraph | undefined
 readonly limit?: number
}): string[] {
 const { run, compiled } = options
 if (run === undefined) return ['dog: no run yet']
 const limit = options.limit ?? 12
 const lines: string[] = []
 const rootState = run.rootState ?? run.state
 const counts = countStates(run)
 lines.push(`dog ${run.graphId} · ${rootState} · ${counts}`)
 if (compiled === undefined) return lines
 const nodes = compiled.input.nodes
 for (const goalId of Object.keys(nodes).slice(0, limit)) {
  const node = nodes[goalId]
  const goal = run.goals[goalId]
  if (node === undefined) continue
  const glyph = GLYPHS[goal?.state ?? 'pending']
  const verifier = node.verifier?.mode === 'agentic' ? 'agent' : node.verifier?.mode === 'programmatic' ? 'script' : 'composite'
  const reason = goal?.reason === undefined ? '' : ` — ${goal.reason.slice(0, 48)}`
  lines.push(`${glyph} ${goalId} [${verifier}] ${node.title.slice(0, 32)}${reason}`)
 }
 if (Object.keys(nodes).length > limit) lines.push(`… ${Object.keys(nodes).length - limit} more goals`)
 return lines
}

function countStates(run: DogRun): string {
 const tally: Record<GoalState, number> = {
  pending: 0, running: 0, success: 0, failure: 0, blocked: 0,
  needs_human: 0, cancelled: 0, invalidated: 0, partial: 0, inherited: 0,
 }
 for (const goal of Object.values(run.goals)) tally[goal.state] += 1
 const order: GoalState[] = ['success', 'inherited', 'failure', 'needs_human', 'blocked', 'partial', 'running', 'pending', 'cancelled']
 return order
  .filter(state => tally[state] > 0)
  .map(state => `${tally[state]}${GLYPHS[state]}`)
  .join(' ')
}

/** `/dog` command view: full goal table with per-goal evidence pointers. */
export function runReport(options: {
 readonly run: DogRun
 readonly compiled: CompiledGraph | undefined
}): string {
 const { run, compiled } = options
 const lines: string[] = []
 lines.push(`run      ${run.runId}`)
 lines.push(`graph    ${run.graphId} @ ${run.graphDigest.slice(0, 12)}`)
 lines.push(`state    ${run.rootState ?? run.state}`)
 lines.push(`created  ${run.createdAt}`)
 lines.push(`updated  ${run.updatedAt}`)
 if (run.workspaceBaseDir !== undefined) lines.push(`base     ${run.workspaceBaseDir}`)
 if (run.runtimeWarning !== undefined) lines.push(`warning  ${run.runtimeWarning}`)
 lines.push('')
 for (const [goalId, goal] of Object.entries(run.goals)) {
  const node = compiled?.input.nodes[goalId]
  const glyph = GLYPHS[goal.state]
  lines.push(`${glyph} ${goalId}  ${goal.state}${node === undefined ? '' : `  (${node.title})`}`)
  if (goal.reason !== undefined) lines.push(`    reason: ${goal.reason}`)
  if (goal.inheritedFrom !== undefined) lines.push(`    inherited from: ${goal.inheritedFrom}`)
  const evidence = goal.verification?.evidence
  if (evidence !== undefined) lines.push(`    evidence: ${JSON.stringify(evidence).slice(0, 200)}`)
 }
 return lines.join('\n')
}
