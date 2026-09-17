/**
 * The two judgment kernels on OMP.
 *
 * Programmatic: run the registered script with the captured object path — the
 * same contract the DSH deployment used, now through `pi.exec`.
 *
 * Agentic: read back the settlement an already-dispatched read-only verifier
 * wrote. The kernel never starts a worker (OMP gives extensions no such API)
 * and never accepts a verdict it cannot bind to the bytes on disk.
 */

import { join } from 'node:path'
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import { resolveScriptPath } from '../core/engine.ts'
import { sha256Json } from '../core/json.ts'
import { isJsonValue } from '../core/model.ts'
import type { AgenticRunner, ProgrammaticRunner, Verdict } from '../core/verifiers.ts'
import { dispatchDirectory, instructionHashOf, modifiedAtMs, readSettlement, sha256OfFile } from './settlement.ts'

const SCRIPT_TIMEOUT_MS = 900_000
const STDERR_TAIL = 2_000

/** Every non-pass path is built here, so "evidence is JSON, state is inconclusive" holds by construction. */
function inconclusive(evidence: Record<string, string | number | boolean>, reason: string): Verdict {
 return { state: 'inconclusive', evidence, reason }
}

/** Parse one programmatic script's stdout into a verdict. */
export function parseVerdict(stdout: string): Verdict {
 let value: unknown
 try {
  value = JSON.parse(stdout)
 } catch {
  return inconclusive({ parseError: 'script output was not JSON' }, 'script output was not JSON')
 }
 if (value === null || typeof value !== 'object' || Array.isArray(value)) {
  return inconclusive({ parseError: 'script output was not an object' }, 'script output was not an object')
 }
 const record = value as Record<string, unknown>
 const verdict = record.verdict
 if (verdict !== 'pass' && verdict !== 'fail' && verdict !== 'inconclusive') {
  return inconclusive({ parseError: 'invalid verdict' }, 'script returned an invalid verdict')
 }
 return {
  state: verdict,
  evidence: isJsonValue(record.evidence) ? record.evidence : { outcome: 'no evidence supplied by script' },
 }
}

export function createProgrammaticRunner(pi: ExtensionAPI, scriptsDirectory: string): ProgrammaticRunner {
 return async (script, inputPath, env) => {
  let scriptPath: string
  try {
   scriptPath = resolveScriptPath(scriptsDirectory, script)
  } catch (error) {
   return inconclusive({ error: messageOf(error) }, 'registered script could not be resolved')
  }
  const result = await pi.exec(scriptPath, [inputPath], {
   ...(env.signal === undefined ? {} : { signal: env.signal }),
   timeout: SCRIPT_TIMEOUT_MS,
  })
  if (result.killed) {
   return inconclusive({ error: 'script interrupted' }, 'script execution was interrupted')
  }
  if (result.code !== 0) {
   return inconclusive(
    { code: result.code, stderr: result.stderr.slice(-STDERR_TAIL) },
    `script exited with code ${result.code}`,
   )
  }
  return parseVerdict(result.stdout)
 }
}

export interface AgenticRunnerOptions {
 /** Project-scoped DoG root (settlements live under `<dogRoot>/dispatches`). */
 readonly dogRoot: string
 /** Graph revision each live run was started against. */
 readonly graphDigestFor: (runId: string) => string | undefined
}

/**
 * Resolve one agentic judgment from a dispatched verifier's settlement file.
 *
 * Every failure path is `inconclusive`, never `pass`: a missing verifier, a
 * settlement for another instruction, a verdict whose captured digest no longer
 * matches the bytes in the workspace, or one written before it was dispatched
 * all fail closed.
 */
export function createAgenticRunner(options: AgenticRunnerOptions): AgenticRunner {
 const directory = dispatchDirectory(options.dogRoot)
 return async (instruction, _workspace, inputPath, env) => {
  const { goalId, runId } = env
  if (goalId === undefined) {
   return inconclusive({ outcome: 'agentic kernel invoked without a goal' }, 'agentic kernel invoked without a goal')
  }
  const graphDigest = runId === undefined ? undefined : options.graphDigestFor(runId)
  if (graphDigest === undefined) {
   return inconclusive({ outcome: 'run is not bound to a graph revision' }, 'run is not bound to a graph revision')
  }
  const inputSha256 = await sha256OfFile(inputPath)
  if (inputSha256 === undefined) {
   return inconclusive(
    { outcome: 'captured object is unavailable', path: inputPath },
    'captured object is unavailable to the verifier',
   )
  }
  const instructionHash = instructionHashOf(instruction)
  const requestId = sha256Json({ graphDigest, goalId, instructionHash, inputSha256 })
  const settlementPath = join(directory, `${requestId}.settlement.json`)
  const record = await readSettlement(settlementPath)
  if (record === undefined) {
   return inconclusive(
    { outcome: 'verifier has not settled this goal', requestId },
    'no verifier settlement exists for this judgment',
   )
  }
  if (record.inputSha256 !== inputSha256) {
   return inconclusive(
    { outcome: 'settlement judged different bytes', settled: record.inputSha256, current: inputSha256 },
    'settlement is stale: the captured object changed after it was judged',
   )
  }
  if (record.instructionHash !== instructionHash) {
   return inconclusive(
    { outcome: 'settlement answered a different instruction' },
    'settlement is not for this instruction',
   )
  }
  // A verdict older than its own dispatch request cannot be an answer to it.
  const dispatchedAt = await modifiedAtMs(join(directory, `${requestId}.request.json`))
  const settledAt = await modifiedAtMs(settlementPath)
  if (dispatchedAt !== undefined && settledAt !== undefined && settledAt < dispatchedAt) {
   return inconclusive(
    { outcome: 'settlement predates its dispatch request' },
    'settlement was not written in response to the dispatched verification',
   )
  }
  return {
   state: record.state,
   evidence: record.evidence ?? {
    outcome: record.state,
    ...(record.verifierAgent === undefined ? {} : { verifierAgent: record.verifierAgent }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
   },
   ...(record.reason === undefined ? {} : { reason: record.reason }),
  }
 }
}

function messageOf(error: unknown): string {
 return error instanceof Error ? error.message : String(error)
}
