/**
 * DoG (DAG of Goals) for OMP — mechanical acceptance gates over a declared graph.
 *
 * The engine, graph language, repository and ledger are the same code the DSH
 * deployment runs; only the host wiring differs. Two host facts shape it:
 *
 * 1. An extension cannot start a subagent, so the agentic judgment kernel reads
 *    a settlement written by a verifier the *model* dispatches through the
 *    native `task` tool. `dog_run` refuses to advance while a required
 *    settlement is missing, so a run can never silently skip its gates.
 * 2. OMP renders extensions only in the terminal, so a run is surfaced as a
 *    status line, a widget above the editor, and a `/dog` report card.
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { DogEngine } from './core/engine.ts'
import type { CompiledGraph, DogConfig, DogRun } from './core/model.ts'
import { loadSchemaSet, type SchemaSet } from './core/schema.ts'
import { DogRepository } from './core/storage.ts'
import { WorkspaceManager } from './core/workspace.ts'
import { dogRootFor, resolveDogConfig } from './omp/config.ts'
import { materializeObject, planDispatch, type DeferredGoal } from './omp/dispatch.ts'
import { createAgenticRunner, createProgrammaticRunner } from './omp/kernels.ts'
import { panelLines, runReport, statusText } from './omp/panel.ts'
import { writeDispatchRequest, type DispatchRequest } from './omp/settlement.ts'

const WIDGET_KEY = 'dog.panel'
const STATUS_KEY = 'dog'

interface ProjectContext {
 readonly cwd: string
 readonly dogRoot: string
 readonly config: DogConfig
 readonly repository: DogRepository
 readonly schema: SchemaSet
}

const projects = new Map<string, Promise<ProjectContext>>()

/** One repository per project directory, initialized once per process. */
function projectContext(cwd: string): Promise<ProjectContext> {
 const existing = projects.get(cwd)
 if (existing !== undefined) return existing
 const created = (async (): Promise<ProjectContext> => {
  const config = resolveDogConfig(cwd)
  const repository = new DogRepository(join(cwd, config.storageDirectory), undefined)
  await repository.initialize()
  const schema = await loadSchemaSet()
  return { cwd, dogRoot: dogRootFor(cwd), config, repository: new DogRepository(join(cwd, config.storageDirectory), schema), schema }
 })()
 projects.set(cwd, created)
 return created
}

export default function dog(pi: ExtensionAPI): void {
 const z = pi.zod
 const Graph = dogGraphSchema(z)
 // Registry only. The extension takes no session-lifecycle action of its own:
 // every side effect below happens inside a tool call or the `/dog` command,
 // so loading it can never change what another session in the same project sees.

 pi.registerTool({
  name: 'dog_validate',
  label: 'DoG Validate',
  description:
   'Statically validate a DoG v0.9 graph: schema, root/edge rules, reachability, acyclicity, expression binding. Writes nothing and runs nothing. ' +
   'Graph shape: {schemaVersion:"0.9", id, root, nodes, contains, dependsOn}; a node is ' +
   '{kind:"leaf"|"composite", title, constraint:"hard"|"soft", target (workspace-relative path), verifier? {mode:"programmatic",script} | {mode:"agentic",instruction}, completion?}; ' +
   'a contains edge is {parent, child, required, failure:"fatal"|"tolerable"|"degrade"}; a dependsOn edge is {source, target} and reads "source waits for target"; ' +
   'root must be a composite with constraint "hard".',
  parameters: z.object({
   graph: Graph.optional().describe('Complete DoG graph. Prefer graphFile when the graph is large: an inline literal with this much nesting is easy to malform.'),
   graphFile: z.string().optional().describe('Path to a JSON file holding the complete graph, resolved against the session working directory. Preferred over graph.'),
  }),
  loadMode: 'discoverable',
  approval: 'read',
  async execute(_id, params: { graph?: unknown; graphFile?: string }, _signal, _onUpdate, ctx) {
   const parsed = await resolveGraphInput(params, ctx.cwd)
   if ('error' in parsed) return textResult({ valid: false, errors: [parsed.error], warnings: [] })
   const project = await projectContext(ctx.cwd)
   const engine = engineFor(project, pi, undefined)
   const report = engine.validate(parsed.value)
   return textResult(report)
  },
 })

 pi.registerTool({
  name: 'dog_create',
  label: 'DoG Create',
  description:
   'Compile and persist a valid DoG v0.9 graph, capturing every verifier target from the session working directory as immutable bytes. Re-issuing the same graph ID captures a new revision — call this again after the artifacts change. ' +
   'Graph shape: {schemaVersion:"0.9", id, root, nodes, contains, dependsOn}; a node is ' +
   '{kind:"leaf"|"composite", title, constraint:"hard"|"soft", target (workspace-relative path), verifier? {mode:"programmatic",script} | {mode:"agentic",instruction}, completion?}; ' +
   'a contains edge is {parent, child, required, failure:"fatal"|"tolerable"|"degrade"}; a dependsOn edge is {source, target} and reads "source waits for target"; ' +
   'root must be a composite with constraint "hard".',
  parameters: z.object({
   graph: Graph.optional().describe('Complete DoG graph. Prefer graphFile when the graph is large: an inline literal with this much nesting is easy to malform.'),
   graphFile: z.string().optional().describe('Path to a JSON file holding the complete graph, resolved against the session working directory. Preferred over graph.'),
  }),
  loadMode: 'essential',
  approval: 'write',
  async execute(_id, params: { graph?: unknown; graphFile?: string }, _signal, _onUpdate, ctx) {
   const parsed = await resolveGraphInput(params, ctx.cwd)
   if ('error' in parsed) return textResult({ error: parsed.error })
   const project = await projectContext(ctx.cwd)
   const engine = engineFor(project, pi, undefined)
   const compiled = await engine.create(parsed.value, { captureBaseDir: ctx.cwd })
   return textResult(summarizeCompiled(compiled), { graphDigest: compiled.graphDigest })
  },
 })

 pi.registerTool({
  name: 'dog_run',
  label: 'DoG Run',
  description:
   'Advance the acceptance CI for the latest revision of a graph. Script-governed goals are judged inline; instruction-governed goals need a dispatched read-only verifier first, so this returns "needs_verification" with one brief per goal instead of judging them blind. Dispatch the briefs with the task tool, then call dog_run again.',
  parameters: z.object({
   graphId: z.string().describe('Graph ID persisted by dog_create.'),
   mode: z
    .enum(['auto', 'force'])
    .optional()
    .describe('"auto" (default) refuses to advance while a verifier is outstanding. "force" runs anyway, settling those goals as needs_human.'),
  }),
  loadMode: 'essential',
  // Judging a script-governed goal runs that script through pi.exec, so this
  // declares the code-execution tier rather than hiding behind "write".
  approval: 'exec',
  async execute(toolCallId, params: { graphId: string; mode?: 'auto' | 'force' }, _signal, _onUpdate, ctx) {
   const project = await projectContext(ctx.cwd)
   const compiled = await project.repository.loadGraph(params.graphId)
   const priorRun = await project.repository.loadLatestSettledRun(params.graphId)
   const plan = await planDispatch({ compiled, dogRoot: project.dogRoot, priorRun })
   if (plan.required.length > 0 && params.mode !== 'force') {
    const briefs = await dispatchBriefs({ project, pi, compiled, requests: plan.required, cwd: ctx.cwd })
    const latest = priorRun ?? (await latestRun(project, params.graphId))
    await publish(ctx, latest, compiled, { keep: true })
    return textResult({
     status: 'needs_verification',
     graphId: params.graphId,
     graphDigest: compiled.graphDigest,
     instruction:
      'Dispatch each item below with the task tool (agent "dog-verifier"), then call dog_run again. Do not report a goal as verified yourself: the engine judges only the settlement files those subagents write.',
     pending: briefs,
     deferred: plan.deferred,
     inherited: plan.inherited,
    })
   }
   const engine = engineFor(project, pi, compiled)
   const run = await engine.run(params.graphId, { invocation: { callId: toolCallId } })
   const effective = await project.repository.loadRun(run.runId)
   await publish(ctx, effective, compiled)
   return textResult(summarizeRun(effective, compiled, {
    forced: plan.required.length > 0,
    outstanding: plan.required.map(request => request.goalId),
    deferred: plan.deferred.map(goal => goal.goalId),
   }))
  },
 })

 pi.registerTool({
  name: 'dog_status',
  label: 'DoG Status',
  description: 'Read persisted DoG state: goal states, verifier evidence and the goal ledger for one run, or every graph in this project when called without arguments.',
  parameters: z.object({
   runId: z.string().optional().describe('Run ID returned by dog_run.'),
   graphId: z.string().optional().describe('Graph ID; resolves to its most recent run.'),
  }),
  loadMode: 'essential',
  approval: 'read',
  async execute(_id, params: { runId?: string; graphId?: string }, _signal, _onUpdate, ctx) {
   const project = await projectContext(ctx.cwd)
   if (params.runId !== undefined) {
    const run = await project.repository.loadRun(params.runId)
    const compiled = await safeLoadGraph(project, run.graphId)
    await publish(ctx, run, compiled)
    return textResult(summarizeRun(run, compiled))
   }
   if (params.graphId !== undefined) {
    const run = await latestRun(project, params.graphId)
    const compiled = await safeLoadGraph(project, params.graphId)
    await publish(ctx, run, compiled)
    return run === undefined
     ? textResult({ graphId: params.graphId, run: null, hint: 'no run recorded yet; call dog_create then dog_run' })
     : textResult(summarizeRun(run, compiled))
   }
   const graphs = await project.repository.listGraphs()
   const runs = await project.repository.listRuns()
   const latestByGraph = new Map<string, DogRun>()
   for (const run of runs) if (!latestByGraph.has(run.graphId)) latestByGraph.set(run.graphId, run)
   return textResult({
    dogRoot: project.dogRoot,
    graphs: graphs.map(graph => {
     const run = latestByGraph.get(graph.input.id)
     return {
      graphId: graph.input.id,
      graphDigest: graph.graphDigest.slice(0, 12),
      goals: Object.keys(graph.input.nodes).length,
      root: graph.input.root,
      latestRun: run === undefined ? null : { runId: run.runId, state: run.rootState ?? run.state, updatedAt: run.updatedAt },
     }
    }),
   })
  },
 })

 pi.registerTool({
  name: 'dog_cancel',
  label: 'DoG Cancel',
  description: 'Cancel one running DoG run; partial verification records and evidence stay inspectable.',
  parameters: z.object({
   runId: z.string().describe('Run ID returned by dog_run.'),
   reason: z.string().optional().describe('Bounded human-readable cancellation reason.'),
  }),
  loadMode: 'discoverable',
  approval: 'write',
  async execute(_id, params: { runId: string; reason?: string }, _signal, _onUpdate, ctx) {
   const project = await projectContext(ctx.cwd)
   const engine = engineFor(project, pi, undefined)
   const run = await engine.cancelRun(params.runId, params.reason ?? 'cancelled by the calling session')
   const compiled = await safeLoadGraph(project, run.graphId)
   await publish(ctx, run, compiled)
   return textResult(summarizeRun(run, compiled))
  },
 })

 pi.registerCommand('dog', {
  description: 'Show the DoG acceptance panel and the latest run report',
  handler: async (args, ctx) => {
   const project = await projectContext(ctx.cwd)
   const trimmed = (args ?? '').trim()
   const run = trimmed.length > 0 ? await latestRun(project, trimmed) : await mostRecentRun(project)
   const compiled = run === undefined ? undefined : await safeLoadGraph(project, run.graphId)
   await publish(ctx, run, compiled, { keep: true })
   if (run === undefined) {
    ctx.ui.notify('dog: no run recorded in this project yet', 'info')
    return
   }
   pi.sendMessage(
    { customType: 'dog.report', content: `**DoG run**\n\n\`\`\`\n${runReport({ run, compiled })}\n\`\`\``, display: true },
    { triggerTurn: false },
   )
  },
 })

 pi.registerTool({
  name: 'dog_graph',
  label: 'DoG Graph',
  description: 'Render one persisted graph revision as text: nodes, kinds, constraints, verifier shapes and edges.',
  parameters: z.object({ graphId: z.string().describe('Graph ID persisted by dog_create.') }),
  loadMode: 'discoverable',
  approval: 'read',
  async execute(_id, params: { graphId: string }, _signal, _onUpdate, ctx) {
   const project = await projectContext(ctx.cwd)
   const compiled = await safeLoadGraph(project, params.graphId)
   if (compiled === undefined) return textResult({ error: `unknown graph ${params.graphId}` })
   return textResult(summarizeCompiled(compiled))
  },
 })

 pi.registerTool({
  name: 'dog_ledger',
  label: 'DoG Ledger',
  description: 'Read the verifier evidence ledger for one goal: every verification record and runtime event, newest last.',
  parameters: z.object({
   runId: z.string().describe('Run ID returned by dog_run.'),
   goalId: z.string().describe('Goal ID inside that run.'),
  }),
  loadMode: 'discoverable',
  approval: 'read',
  async execute(_id, params: { runId: string; goalId: string }, _signal, _onUpdate, ctx) {
   const project = await projectContext(ctx.cwd)
   const run = await project.repository.loadRun(params.runId)
   const record = run.goals[params.goalId]
   if (record === undefined) return textResult({ error: `goal ${params.goalId} is not part of run ${params.runId}` })
   const events = await project.repository.loadGoalRuntimeEvents(params.runId, params.goalId)
   return textResult({
    runId: params.runId,
    goalId: params.goalId,
    state: record.state,
    reason: record.reason ?? null,
    inheritedFrom: record.inheritedFrom ?? null,
    verification: record.verification ?? null,
    events: events.map(event => ({ phase: event.phase, state: event.state ?? null, at: event.at, reason: event.reason ?? null })),
   })
  },
 })
}

/**
 * The graph parameter, declared field by field.
 *
 * Every other tool in this harness types its input and describes each field; an
 * untyped blob would leave the caller to hand-write a deep literal blind, which
 * is exactly how malformed graphs happen. The one place that stays open is the
 * nested boolean expression: the language is recursive and the builder has no
 * recursive form, so `items`/`item` accept anything and the engine validates
 * them after parsing (it reports `$.nodes.<id>.completion...` paths).
 */
function dogGraphSchema(z: ExtensionAPI['zod']) {
 const boolExpr = z.object({
  op: z.enum(['ref', 'all', 'any', 'not', 'atLeast']).describe('ref: one child; all: every listed child; any: at least one; atLeast: at least `count`; not: negation'),
  id: z.string().optional().describe('child goal id, required when op is ref'),
  count: z.number().optional().describe('threshold, required when op is atLeast'),
  items: z.array(z.unknown()).optional().describe('nested expressions for all/any/atLeast, same shape as this one; validated by the engine'),
  item: z.unknown().optional().describe('nested expression for not, same shape as this one; validated by the engine'),
 })
 const verifier = z.union([
  z.object({
   mode: z.literal('programmatic').describe('a script decides'),
   script: z.string().describe('script name in the host library, the .js suffix may be omitted'),
  }),
  z.object({
   mode: z.literal('agentic').describe('a dispatched read-only verifier decides'),
   instruction: z.string().describe('the whole acceptance criterion, in one instruction; the verifier judges the frozen capture against it and nothing else'),
  }),
 ])
 const node = z.object({
  kind: z.enum(['leaf', 'composite']).describe('leaf: judged by its verifier; composite: judged by its children plus completion'),
  title: z.string().describe('human-readable name'),
  constraint: z.enum(['hard', 'soft']).describe('hard: failure propagates; soft: advisory'),
  target: z.string().describe('workspace-relative path of the object to judge: a file, or a directory that is packed into a tar'),
  verifier: verifier.optional().describe('required on leaves; on composites an optional whole-object assertion, applied after the subtree settles'),
  completion: boolExpr.optional().describe('composites only: how child results combine'),
 })
 const containsEdge = z.object({
  parent: z.string().describe('must name a composite node'),
  child: z.string(),
  required: z.boolean(),
  failure: z.enum(['fatal', 'tolerable', 'degrade']).describe('fatal: this child failing fails the group; tolerable: partial; degrade: fall back to degradeTo'),
  degradeTo: z.string().optional().describe('required when failure is degrade'),
 })
 const dependsOnEdge = z.object({
  source: z.string().describe('waits for target'),
  target: z.string(),
  data: z.array(z.string()).optional(),
 })
 return z.object({
  schemaVersion: z.literal('0.9').describe('protocol version, literally "0.9"'),
  id: z.string().describe('graph id; re-creating the same id records a new revision'),
  root: z.string().describe('goal id of the root node; it must be a composite with constraint "hard"'),
  nodes: z.record(node).describe('goal id to node'),
  contains: z.array(containsEdge).describe('ownership and failure-propagation edges'),
  dependsOn: z.array(dependsOnEdge).describe('ordering edges; [] when none'),
 })
}

/** Build one engine bound to a compiled revision (the agentic kernel needs its digest). */
function engineFor(project: ProjectContext, pi: ExtensionAPI, compiled: CompiledGraph | undefined): DogEngine {
 const digests = new Map<string, string>()
 let pendingDigest = compiled?.graphDigest
 return new DogEngine({
  config: project.config,
  repository: project.repository,
  programmatic: createProgrammaticRunner(pi, project.config.scriptsDirectory),
  agentic: createAgenticRunner({ dogRoot: project.dogRoot, graphDigestFor: runId => digests.get(runId) }),
  workspaces: new WorkspaceManager({ baseDir: project.config.workspaceRoot }),
  nextRunId: () => {
   const id = randomUUID()
   if (pendingDigest !== undefined) digests.set(id, pendingDigest)
   return id
  },
 })
}

async function dispatchBriefs(options: {
 readonly project: ProjectContext
 readonly pi: ExtensionAPI
 readonly compiled: CompiledGraph
 readonly requests: readonly DispatchRequest[]
 readonly cwd: string
}): Promise<unknown[]> {
 const briefs: unknown[] = []
 for (const request of options.requests) {
  const object = await materializeObject({
   repository: options.project.repository,
   pi: options.pi,
   request,
   cwd: options.cwd,
  })
  if (object !== undefined) {
   await writeDispatchRequest({ ...request, objectPath: object.path, objectKind: object.kind })
   briefs.push({
    goalId: request.goalId,
    target: request.target,
    instruction: request.instruction,
    objectPath: object.path,
    objectKind: object.kind,
    settlementPath: request.settlementPath,
    inputSha256: request.inputSha256,
    instructionHash: request.instructionHash,
    requestId: request.requestId,
    verifierTask: verifierBrief({ request, objectPath: object.path, objectKind: object.kind }),
   })
  } else {
   await writeDispatchRequest(request)
   briefs.push({
    goalId: request.goalId,
    target: request.target,
    instruction: request.instruction,
    settlementPath: request.settlementPath,
    error: 'the captured object could not be materialized for the verifier; re-run dog_create and try again',
   })
  }
 }
 return briefs
}

/** The exact assignment a dispatched verifier must receive. */
function verifierBrief(options: {
 readonly request: DispatchRequest
 readonly objectPath: string
 readonly objectKind: 'file' | 'directory'
}): string {
 const { request, objectPath, objectKind } = options
 return [
  `Judge goal "${request.goalId}" and write exactly one settlement file.`,
  '',
  `Object: ${objectPath} (${objectKind})`,
  'This is the frozen capture the engine will judge. Read it, and only it — never the live working tree.',
  '',
  'Instruction you are judging:',
  request.instruction,
  '',
  'Write the settlement file with this exact JSON shape (state must be "pass", "fail" or "inconclusive"; evidence is free-form JSON):',
  JSON.stringify(
   {
    schemaVersion: '0.1',
    requestId: request.requestId,
    goalId: request.goalId,
    graphDigest: request.graphDigest,
    instructionHash: request.instructionHash,
    inputSha256: request.inputSha256,
    state: '<pass|fail|inconclusive>',
    evidence: { outcome: '<what you observed>' },
    reason: '<one line>',
    verifierAgent: '<your agent id if known>',
    settledAt: '<ISO timestamp>',
   },
   null,
   2,
  ),
  `Path: ${request.settlementPath}`,
  '',
  'Copy instructionHash, inputSha256, requestId, goalId and graphDigest verbatim from this assignment — they bind your verdict to this exact object. Do not edit any file other than the settlement path.',
 ].join('\n')
}

async function publish(
 ctx: ExtensionContext,
 run: DogRun | undefined,
 compiled: CompiledGraph | undefined,
 options: { readonly keep?: boolean } = {},
): Promise<void> {
 if (!ctx.hasUI) return
 const status = statusText(run, compiled)
 ctx.ui.setStatus(STATUS_KEY, status)
 // The widget is a takeover of the editor area: show it while a run is in
 // flight or while the caller asked for it, and drop it once the run is done.
 const showWidget = run !== undefined && (options.keep === true || run.state === 'running')
 ctx.ui.setWidget(WIDGET_KEY, showWidget ? panelLines({ run, compiled }) : undefined)
}

async function latestRun(project: ProjectContext, graphId: string): Promise<DogRun | undefined> {
 const runs = await project.repository.listRuns()
 return runs.find(run => run.graphId === graphId)
}

async function mostRecentRun(project: ProjectContext): Promise<DogRun | undefined> {
 const runs = await project.repository.listRuns()
 return runs[0]
}

async function safeLoadGraph(project: ProjectContext, graphId: string): Promise<CompiledGraph | undefined> {
 try {
  return await project.repository.loadGraph(graphId)
 } catch {
  return undefined
 }
}

function coerceGraphValue(value: unknown): { readonly value: unknown } | { readonly error: string } {
 if (typeof value !== 'string') return { value }
 try {
  return { value: JSON.parse(value) as unknown }
 } catch (error) {
  return { error: `graph string is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
 }
}

/**
 * Resolve the graph from either an inline value or a file path.
 *
 * `graphFile` exists because an inline graph is a large hand-written nested
 * literal: a single missing brace turns into a structural error the model has
 * to retype, and that happens often enough to be worth a second entry point.
 * Writing the graph once and passing the path keeps the JSON in a file the
 * write tool already validated as JSON.
 */
async function resolveGraphInput(
 params: { readonly graph?: unknown; readonly graphFile?: string },
 cwd: string,
): Promise<{ readonly value: unknown } | { readonly error: string }> {
 const file = typeof params.graphFile === 'string' ? params.graphFile.trim() : ''
 if (params.graph !== undefined && file.length > 0) {
  return { error: 'pass exactly one of graph or graphFile, not both' }
 }
 if (file.length === 0) {
  if (params.graph === undefined) return { error: 'a graph is required: pass graphFile (path to a JSON file) or graph (object or JSON string)' }
  return coerceGraphValue(params.graph)
 }
 const path = isAbsolute(file) ? file : join(cwd, file)
 let source: string
 try {
  source = await readFile(path, 'utf8')
 } catch (error) {
  return { error: `graphFile could not be read (${path}): ${error instanceof Error ? error.message : String(error)}` }
 }
 try {
  return { value: JSON.parse(source) as unknown }
 } catch (error) {
  return { error: `graphFile is not valid JSON (${path}): ${error instanceof Error ? error.message : String(error)}` }
 }
}

function summarizeCompiled(compiled: CompiledGraph): unknown {
 return {
  graphId: compiled.input.id,
  graphDigest: compiled.graphDigest,
  root: compiled.input.root,
  goals: Object.entries(compiled.input.nodes).map(([goalId, node]) => {
   const plan = compiled.acceptancePlans[goalId]
   return {
    goalId,
    kind: node.kind,
    constraint: node.constraint,
    title: node.title,
    target: node.target,
    verifier: node.verifier?.mode ?? (node.kind === 'composite' ? 'completion' : 'missing'),
    captured: plan?.input === undefined ? null : { bytes: plan.input.byteLength, sha256: plan.input.sha256.slice(0, 16), packed: plan.input.packed === true, exists: plan.input.exists },
   }
  }),
  edges: compiled.input.contains.map(edge => ({ parent: edge.parent, child: edge.child, required: edge.required, failure: edge.failure })),
  dependencies: compiled.input.dependsOn.map(edge => ({ source: edge.source, target: edge.target })),
 }
}

function summarizeRun(run: DogRun, compiled: CompiledGraph | undefined, extra?: unknown): unknown {
 const root = compiled?.input.root
 const rootGoal = root === undefined ? undefined : run.goals[root]
 return {
  runId: run.runId,
  graphId: run.graphId,
  graphDigest: run.graphDigest.slice(0, 12),
  state: run.state,
  rootState: run.rootState ?? null,
  root: root === undefined || rootGoal === undefined ? null : { goalId: root, ...rootGoal },
  goals: Object.fromEntries(
   Object.entries(run.goals).map(([goalId, goal]) => [
    goalId,
    {
     state: goal.state,
     ...(goal.reason === undefined ? {} : { reason: goal.reason }),
     ...(goal.inheritedFrom === undefined ? {} : { inheritedFrom: goal.inheritedFrom }),
     ...(goal.verification?.evidence === undefined ? {} : { evidence: goal.verification.evidence }),
    },
   ]),
  ),
  ...(run.runtimeWarning === undefined ? {} : { runtimeWarning: run.runtimeWarning }),
  ...(extra === undefined ? {} : { dispatch: extra }),
 }
}

function textResult(value: unknown, details: Record<string, unknown> = {}): {
 content: { type: 'text'; text: string }[]
 details: Record<string, unknown>
} {
 return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], details }
}
