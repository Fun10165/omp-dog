/**
 * Pre-flight for a run: what the engine can judge now, and what it needs a
 * dispatched verifier for first.
 *
 * The engine pumps every ready leaf; an agentic leaf whose settlement is absent
 * would settle `needs_human` and poison the run. So the caller asks this module
 * first: every goal listed in `required` must get a verifier dispatch before
 * `dog_run` advances the engine.
 *
 * Inheritance is mirrored from the engine's own `anchorOfPlan` — the captured
 * object digest plus the judgment identity — so goals the next run will reuse
 * are never re-dispatched.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import { sha256Json } from '../core/json.ts'
import type { AcceptancePlan, CompiledGraph, DogRun } from '../core/model.ts'
import type { DogRepository } from '../core/storage.ts'
import { buildDispatchRequest, instructionHashOf, readSettlement, type DispatchRequest } from './settlement.ts'

export interface DeferredGoal {
 readonly goalId: string
 readonly target: string
 readonly reason: string
}

export interface DispatchPlan {
 /** Agentic goals that need a verifier dispatch before the engine can judge them. */
 readonly required: readonly DispatchRequest[]
 /** Agentic goals with nothing to judge yet (no captured object). */
 readonly deferred: readonly DeferredGoal[]
 /** Goals the next run inherits from a prior run instead of re-judging. */
 readonly inherited: readonly string[]
}

/** Engine's inheritance anchor, mirrored verbatim (`anchorOfPlan` in core/engine.ts). */
function anchorOf(plan: AcceptancePlan): string | undefined {
 if (plan.input === undefined || !plan.input.exists) return undefined
 return sha256Json({ object: plan.input.digest, judgment: plan.judgment })
}

function isInherited(priorRun: DogRun | undefined, goalId: string, anchor: string | undefined): boolean {
 if (priorRun === undefined || anchor === undefined) return false
 if (priorRun.gmDigests[goalId] !== anchor) return false
 return priorRun.goals[goalId]?.verification !== undefined
}

export async function planDispatch(options: {
 readonly compiled: CompiledGraph
 readonly dogRoot: string
 readonly priorRun: DogRun | undefined
}): Promise<DispatchPlan> {
 const { compiled, dogRoot, priorRun } = options
 const required: DispatchRequest[] = []
 const deferred: DeferredGoal[] = []
 const inherited: string[] = []

 for (const goalId of Object.keys(compiled.input.nodes).sort()) {
  const plan = compiled.acceptancePlans[goalId]
  if (plan === undefined) continue
  const verifier = plan.verifier
  if (verifier.mode !== 'agentic') continue
  const anchor = anchorOf(plan)
  if (isInherited(priorRun, goalId, anchor)) {
   inherited.push(goalId)
   continue
  }
  if (plan.input === undefined || !plan.input.exists) {
   deferred.push({
    goalId,
    target: plan.target,
    reason: 'no object was captured at the declared target; nothing to judge',
   })
   continue
  }
  const request = buildDispatchRequest({
   dogRoot,
   graphDigest: compiled.graphDigest,
   goalId,
   target: plan.target,
   instruction: verifier.instruction,
   inputSha256: plan.input.sha256,
   captured: plan.input,
  })
  const record = await readSettlement(request.settlementPath)
  if (
   record !== undefined &&
   record.inputSha256 === request.inputSha256 &&
   record.instructionHash === instructionHashOf(request.instruction)
  ) {
   continue
  }
  required.push(request)
 }

 return { required, deferred, inherited }
}

export interface MaterializedObject {
 /** Path the verifier reads: the frozen copy, never the live tree. */
 readonly path: string
 readonly kind: 'file' | 'directory'
}

/**
 * Freeze the captured object back onto disk for the verifier.
 *
 * The engine already judged a capture, not the live tree; handing the verifier
 * the live path would let it pass bytes the engine never saw. Extracting the
 * packed tar keeps the verifier's input byte-identical to the capture.
 */
export async function materializeObject(options: {
 readonly repository: DogRepository
 readonly pi: ExtensionAPI
 readonly request: DispatchRequest
 readonly cwd: string
}): Promise<MaterializedObject | undefined> {
 const { repository, pi, request } = options
 const root = join(dirname(request.requestPath), request.requestId, 'object')
 const bytes = await repository.read(request.captured)
 await mkdir(root, { recursive: true })
 if (!request.packed) {
  const target = join(root, request.target)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return { path: target, kind: 'file' }
 }
 const archive = join(dirname(request.requestPath), `${request.requestId}.tar`)
 await writeFile(archive, bytes)
 const extracted = await pi.exec('tar', ['-xf', archive, '-C', root], { cwd: options.cwd, timeout: 120_000 })
 if (extracted.code !== 0) return undefined
 return { path: join(root, request.target), kind: 'directory' }
}
