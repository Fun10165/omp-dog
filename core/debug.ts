/**
 * Read-only debugger projections over the persisted store.
 *
 * Pure domain code: no Harness imports, so the browser half can consume the
 * snapshot types directly and the Host RPC layer in `src/dsh/debug.ts` only
 * adds the wire envelope.
 */

import type { CompiledGraph, DogRun, GoalRuntimeTrace } from './model.ts'
import type { DogRepository } from './storage.ts'

/** Upper bound on events returned by one goal runtime trace. */
export const MAX_RUNTIME_EVENTS_PER_GOAL = 64

/** One immutable graph revision and every run bound to that exact digest. */
export interface DogDebugGraphRevision {
 readonly graph: CompiledGraph
 readonly current: boolean
 readonly runs: readonly DogRun[]
}

/** Complete, point-in-time view exposed to the debugger. */
export interface DogDebugSnapshot {
 readonly schemaVersion: '0.1'
 readonly generatedAt: string
 readonly graphs: readonly DogDebugGraphRevision[]
}

/** Build a digest-safe view: an old run is never shown against a newer graph revision. */
export async function buildDogDebugSnapshot(
 repository: DogRepository,
 now: () => Date = () => new Date(),
): Promise<DogDebugSnapshot> {
 const [allGraphs, runs] = await Promise.all([repository.listGraphs(), repository.listRuns()])
 // 0.9 re-shaped the judgment layer; pre-0.9 graphs no longer parse under the
 // 0.9 schema and would poison the whole panel snapshot. Keep them on disk as
 // history (runs unchanged) but never surface them as current revisions.
 const graphs = allGraphs.filter(graph => graph.input.schemaVersion === '0.9')
 const graphIds = [...new Set(graphs.map(graph => graph.input.id))]
 const settled = await Promise.allSettled(graphIds.map(id => repository.loadGraph(id)))
 const currentDigests = new Set(settled
  .filter((result): result is PromiseFulfilledResult<CompiledGraph> => result.status === 'fulfilled')
  .map(result => result.value.graphDigest))
 const revisions = graphs.map(graph => ({
  graph,
  current: currentDigests.has(graph.graphDigest),
  runs: runs.filter(run => run.graphDigest === graph.graphDigest),
 })).sort(compareRevisions)
 return {
  schemaVersion: '0.1',
  generatedAt: now().toISOString(),
  graphs: revisions,
 }
}

/** Build one bounded node trace without loading any DSH transcript or artifact bytes. */
export async function buildGoalRuntimeTrace(
 repository: DogRepository,
 runId: string,
 goalId: string,
): Promise<GoalRuntimeTrace> {
 const run = await repository.loadRun(runId)
 const result = run.goals[goalId]
 if (result === undefined) throw new Error(`run ${runId} has no goal ${goalId}`)
 const matching = [...await repository.loadGoalRuntimeEvents(runId, goalId)]
 const truncated = matching.length > MAX_RUNTIME_EVENTS_PER_GOAL
 return {
  schemaVersion: '0.1',
  runId: run.runId,
  graphId: run.graphId,
  graphDigest: run.graphDigest,
  runState: run.state,
  ...(run.rootState === undefined ? {} : { rootState: run.rootState }),
  goalId,
  result,
  ...(run.invocation === undefined ? {} : { invocation: run.invocation }),
  ...(run.runtimeWarning === undefined ? {} : { runtimeWarning: boundedMessage(run.runtimeWarning) }),
  events: truncated ? matching.slice(-MAX_RUNTIME_EVENTS_PER_GOAL) : matching,
  truncated,
 }
}

/** Clamp one diagnostic string to the wire bound. */
export function boundedMessage(value: string): string {
 const normalized = value.length === 0 ? 'DoG debugger request failed' : value
 return normalized.length <= 512 ? normalized : `${normalized.slice(0, 509)}...`
}

/** Message of an unknown thrown value. */
export function messageOf(error: unknown): string {
 return error instanceof Error ? error.message : String(error)
}

function compareRevisions(left: DogDebugGraphRevision, right: DogDebugGraphRevision): number {
 if (left.current !== right.current) return left.current ? -1 : 1
 const leftUpdated = left.runs[0]?.updatedAt ?? ''
 const rightUpdated = right.runs[0]?.updatedAt ?? ''
 const byActivity = rightUpdated.localeCompare(leftUpdated)
 if (byActivity !== 0) return byActivity
 const byId = left.graph.input.id.localeCompare(right.graph.input.id)
 return byId === 0 ? left.graph.graphDigest.localeCompare(right.graph.graphDigest) : byId
}
