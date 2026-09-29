/** DoG 0.9 engine: compile and freeze a graph, judge every goal, settle the root. */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DogValidationError, parseGraph } from "./graph.ts";
import { dependencyComplete, dependencyNeedsHuman, evaluateBoolExpr } from "./logic.ts";
import { sha256Json } from "./json.ts";
import type {
	AcceptancePlan,
	CapturedInput,
	CompiledGraph,
	ContainsEdge,
	DogConfig,
	DogGraphInput,
	DogRun,
	GoalId,
	GoalResult,
	GoalState,
	GraphValidationReport,
	RootTerminalState,
	TargetSpec,
	VerificationRecord,
	VerifierShape,
} from "./model.ts";
import { DogRepository, captureTarget } from "./storage.ts";
import {
	runPlan,
	type AgenticRunner,
	type ProgrammaticRunner,
	type Settlement,
	type VerifierTarget,
} from "./verifiers.ts";

export interface DogEngineOptions {
	readonly config: DogConfig;
	readonly repository: DogRepository;
	/** Programmatic kernel (script executor). */
	readonly programmatic?: ProgrammaticRunner;
	/** Agentic kernel (verifier session launcher). */
	readonly agentic?: AgenticRunner;
	/** Live concurrency for model-backed verifiers; read once per run. */
	readonly concurrency?: () => number;
	readonly now?: () => Date;
	readonly nextRunId?: () => string;
}

export interface DogRunOptions {
	readonly signal?: AbortSignal;
	/** Called after every settlement with the current run record. */
	readonly onProgress?: (run: DogRun) => void;
}

/** Agentic CI engine: the single writer of one run record. */
export class DogEngine {
	private readonly config: DogConfig;
	private readonly repository: DogRepository;
	private readonly programmatic: ProgrammaticRunner | undefined;
	private readonly agentic: AgenticRunner | undefined;
	private readonly concurrency: (() => number) | undefined;
	private readonly now: () => Date;
	private readonly nextRunId: () => string;

	constructor(options: DogEngineOptions) {
		validateHostConfig(options.config);
		this.config = options.config;
		this.repository = options.repository;
		this.programmatic = options.programmatic;
		this.agentic = options.agentic;
		this.concurrency = options.concurrency;
		this.now = options.now ?? (() => new Date());
		this.nextRunId = options.nextRunId ?? (() => randomUUID());
	}

	validate(value: unknown): GraphValidationReport {
		try {
			const graph = this.parse(value);
			return { valid: true, errors: [], warnings: graphWarnings(graph) };
		} catch (error) {
			return {
				valid: false,
				errors: error instanceof DogValidationError ? [...error.errors] : [messageOf(error)],
				warnings: [],
			};
		}
	}

	/** Compile one graph revision, capturing every verifier target as immutable bytes. */
	async create(value: unknown, options: { readonly captureBaseDir?: string } = {}): Promise<CompiledGraph> {
		const graph = this.parse(value);
		const acceptancePlans: Record<string, AcceptancePlan> = {};
		const captured = new Map<string, CapturedInput>();
		const captureRoots =
			options.captureBaseDir !== undefined && options.captureBaseDir.length > 0
				? [options.captureBaseDir, this.config.workspaceRoot]
				: [this.config.workspaceRoot];
		for (const [goalId, node] of Object.entries(graph.nodes)) {
			if (node.verifier === undefined) continue;
			const target = requireTarget(node.target, goalId);
			const key = targetKey(target);
			let input = captured.get(key);
			if (input === undefined) {
				input = (await captureTarget(captureRoots, target, this.config.maxSandboxBytes, this.repository)).input;
				captured.set(key, input);
			}
			acceptancePlans[goalId] = {
				goalId,
				verifier: node.verifier,
				judgment: this.judgmentOf(node.verifier),
				target,
				objectPath: input.path,
				input,
			};
		}
		const graphDigest = sha256Json({ input: graph, acceptancePlans });
		const compiled: CompiledGraph = { input: graph, graphDigest, acceptancePlans };
		await this.repository.saveGraph(compiled);
		return compiled;
	}

	/**
	 * Judge the latest revision of one graph: reuse unchanged verdicts, run the
	 * programmatic kernel inline, dispatch every agentic judgment to its own
	 * verifier session, then settle the composites and the root.
	 */
	async run(graphId: string, options: DogRunOptions = {}): Promise<DogRun> {
		const compiled = await this.repository.loadGraph(graphId);
		const runId = this.nextRunId();
		const createdAt = this.now().toISOString();
		await this.repository.supersedeRunningRuns(graphId, runId, createdAt);
		const planFor = (goalId: string): AcceptancePlan | undefined => compiled.acceptancePlans[goalId];
		const goals: Record<GoalId, GoalResult> = Object.fromEntries(
			Object.keys(compiled.input.nodes).map((goalId) => [goalId, { state: "pending" as GoalState }]),
		);
		const anchors: Record<GoalId, string> = {};
		const priorRun = await this.repository.loadLatestSettledRun(graphId);
		for (const goalId of Object.keys(compiled.input.nodes)) {
			const plan = planFor(goalId);
			const anchor = plan === undefined ? undefined : anchorOfPlan(plan);
			if (anchor === undefined) continue;
			anchors[goalId] = anchor;
			const priorRecord = priorRun?.anchors[goalId] === anchor ? priorRun.goals[goalId]?.verification : undefined;
			if (priorRun !== undefined && priorRecord !== undefined) {
				goals[goalId] = { state: "inherited", inheritedFrom: priorRun.runId, verification: priorRecord };
			}
		}
		let run: DogRun = {
			schemaVersion: "0.1",
			runId,
			graphId: compiled.input.id,
			graphDigest: compiled.graphDigest,
			state: "running",
			anchors,
			goals,
			createdAt,
			updatedAt: createdAt,
		};
		await this.repository.saveRun(run);

		const signal = options.signal ?? new AbortController().signal;
		const saveProgress = async (): Promise<void> => {
			const updatedAt = this.now().toISOString();
			run = { ...run, goals: { ...goals }, updatedAt };
			await this.repository.saveRun(run);
			options.onProgress?.(run);
		};
		const settleLeaf = async (goalId: GoalId): Promise<GoalResult> => {
			const plan = planFor(goalId);
			if (plan === undefined) return { state: "needs_human", reason: "compiled acceptance plan is missing" };
			goals[goalId] = { state: "running" };
			await saveProgress();
			try {
				const prepared = await this.repository.prepareVerification(runId, goalId, plan);
				const settled = await runPlan(
					plan,
					{ workspace: prepared.workspace, inputPath: prepared.inputPath },
					this.verifierTarget(compiled.input, plan),
					{ runId, goalId, signal },
					this.programmatic,
					this.agentic,
				);
				if (signal.aborted) return { state: "cancelled", reason: "run cancelled; verifier aborted" };
				const record = this.verificationRecord(compiled, plan, settled, runId);
				if (settled.state === "pass") return { state: "success", verification: record };
				if (settled.state === "fail") return { state: "failure", verification: record };
				return {
					state: "needs_human",
					reason: "verifier was inconclusive; evidence insufficient",
					verification: record,
				};
			} catch (error) {
				return { state: "needs_human", reason: boundedMessage(messageOf(error)) };
			}
		};
		const settleComposite = async (goalId: GoalId): Promise<void> => {
			goals[goalId] = { state: "running" };
			await saveProgress();
			let result = evaluateComposite(compiled.input, goals, goalId);
			const plan = planFor(goalId);
			if (plan !== undefined && result.state !== "failure" && !signal.aborted) {
				try {
					const prepared = await this.repository.prepareVerification(runId, goalId, plan);
					const settled = await runPlan(
						plan,
						{ workspace: prepared.workspace, inputPath: prepared.inputPath },
						this.verifierTarget(compiled.input, plan),
						{ runId, goalId, signal },
						this.programmatic,
						this.agentic,
					);
					result = mergeWholeAssertion(result, settled);
					result = { ...result, verification: this.verificationRecord(compiled, plan, settled, runId) };
				} catch (error) {
					result = { state: "failure", reason: `whole-object assertion failed: ${boundedMessage(messageOf(error))}` };
				}
			}
			goals[goalId] = result;
			await saveProgress();
		};

		await this.schedule(compiled.input, goals, saveProgress, settleLeaf, settleComposite, signal);
		if (signal.aborted) {
			for (const [goalId, result] of Object.entries(goals)) {
				if (result.state === "pending" || result.state === "running") {
					goals[goalId] = { state: "cancelled", reason: "run cancelled before this goal settled" };
				}
			}
		}
		const rootState = terminalState(goals[compiled.input.root], this.config.allowPartialRoot);
		if (signal.aborted) {
			run = {
				...run,
				state: "cancelled",
				rootState: "cancelled",
				goals: { ...goals },
				updatedAt: this.now().toISOString(),
			};
		} else {
			run = { ...run, state: "completed", rootState, goals: { ...goals }, updatedAt: this.now().toISOString() };
		}
		await this.repository.saveRun(run);
		options.onProgress?.(run);
		return run;
	}

	async status(runId: string): Promise<DogRun> {
		return this.repository.loadRun(runId);
	}

	/** Watermark scheduling: leaves first (dependencies gate readiness), then composites. */
	private async schedule(
		input: DogGraphInput,
		goals: Record<GoalId, GoalResult>,
		saveProgress: () => Promise<void>,
		settleLeaf: (goalId: GoalId) => Promise<GoalResult>,
		settleComposite: (goalId: GoalId) => Promise<void>,
		signal: AbortSignal,
	): Promise<void> {
		const dependencies = dependenciesBySource(input);
		const children = childrenByParent(input);
		const budget = Math.max(1, Math.floor(this.concurrency?.() ?? this.config.maxConcurrentVerifications));
		const inFlight = new Set<Promise<void>>();
		let agenticInFlight = 0;
		const pendingLeaves = new Set(
			Object.keys(input.nodes).filter(
				(goalId) => input.nodes[goalId]?.kind === "leaf" && goals[goalId]?.state === "pending",
			),
		);
		const pumpLeaves = (): void => {
			for (const goalId of pendingLeaves) {
				if (signal.aborted) return;
				const waiting = (dependencies.get(goalId) ?? []).find((target) => !dependencyComplete(goals[target]));
				if (waiting !== undefined) continue;
				const agentic = input.nodes[goalId]?.verifier?.mode === "agentic";
				if (agentic && agenticInFlight >= budget) continue;
				pendingLeaves.delete(goalId);
				if (agentic) agenticInFlight++;
				const task = settleLeaf(goalId)
					.then((result) => {
						goals[goalId] = result;
						return saveProgress();
					})
					.finally(() => {
						inFlight.delete(task);
						if (agentic) agenticInFlight--;
					});
				inFlight.add(task);
			}
		};
		while (!signal.aborted) {
			pumpLeaves();
			if (inFlight.size === 0 || pendingLeaves.size === 0) break;
			await Promise.race(inFlight);
		}
		await Promise.allSettled(inFlight);

		const compositePending = new Set(postorder(input).filter((goalId) => input.nodes[goalId]?.kind === "composite"));
		const compositeInFlight = new Set<Promise<void>>();
		while (!signal.aborted && (compositePending.size > 0 || compositeInFlight.size > 0)) {
			for (const goalId of compositePending) {
				const unresolvedChild = (children.get(goalId) ?? []).find((childId) => !dependencyComplete(goals[childId]));
				if (unresolvedChild !== undefined) continue;
				const blocked = (dependencies.get(goalId) ?? []).find((target) => !dependencyComplete(goals[target]));
				if (blocked !== undefined) {
					goals[goalId] = dependencyNeedsHuman(goals[blocked])
						? { state: "needs_human", reason: `waiting for dependency ${blocked} to complete` }
						: { state: "blocked", reason: `waiting for dependency ${blocked} to complete` };
					compositePending.delete(goalId);
					await saveProgress();
					continue;
				}
				const agentic = input.nodes[goalId]?.verifier?.mode === "agentic";
				if (agentic && agenticInFlight >= budget) continue;
				compositePending.delete(goalId);
				if (agentic) agenticInFlight++;
				const task = settleComposite(goalId)
					.then(() => undefined)
					.finally(() => {
						compositeInFlight.delete(task);
						if (agentic) agenticInFlight--;
					});
				compositeInFlight.add(task);
			}
			if (compositeInFlight.size === 0) break;
			await Promise.race(compositeInFlight);
		}
		await Promise.allSettled(compositeInFlight);
	}

	private verifierTarget(input: DogGraphInput, plan: AcceptancePlan): VerifierTarget {
		const captured = plan.input;
		return {
			goalId: plan.goalId,
			title: input.nodes[plan.goalId]?.title ?? plan.goalId,
			target: plan.objectPath,
			isDirectory: captured?.packed === true,
			...(captured?.git === undefined
				? {}
				: {
						provenance: `git ${captured.git.ref} @ ${captured.git.commit.slice(0, 12)}${captured.git.path.length === 0 ? "" : ` (path: ${captured.git.path})`}`,
					}),
			...(captured === undefined || !captured.exists
				? {}
				: { byteLength: captured.byteLength, sha256: captured.sha256 }),
		};
	}

	private verificationRecord(
		compiled: CompiledGraph,
		plan: AcceptancePlan,
		settled: Settlement,
		runId: string,
	): VerificationRecord {
		return {
			schemaVersion: "0.1",
			runId,
			graphId: compiled.input.id,
			graphDigest: compiled.graphDigest,
			goalId: plan.goalId,
			judgment: plan.judgment,
			passed: settled.state === "pass" ? true : settled.state === "fail" ? false : null,
			...(settled.evidence === undefined ? {} : { evidence: settled.evidence }),
			verifier: {
				mode: plan.verifier.mode,
				...(settled.sessionFile === undefined ? {} : { sessionFile: settled.sessionFile }),
			},
			at: this.now().toISOString(),
		};
	}

	private judgmentOf(verifier: VerifierShape): AcceptancePlan["judgment"] {
		if (verifier.mode === "programmatic") {
			const scriptPath = resolveScriptPath(this.config.scriptsDirectory, verifier.script);
			return { mode: "programmatic", script: verifier.script, scriptDigest: readScriptDigest(scriptPath) };
		}
		return { mode: "agentic", instructionHash: `sha256:${sha256Json({ instruction: verifier.instruction })}` };
	}

	private parse(value: unknown): DogGraphInput {
		return parseGraph(value, {
			maxGraphNodes: this.config.maxGraphNodes,
			maxExpressionNodes: this.config.maxExpressionNodes,
			maxExpressionDepth: this.config.maxExpressionDepth,
		});
	}
}

/** Inheritance anchor: the captured object plus the judgment identity. */
function anchorOfPlan(plan: AcceptancePlan): string | undefined {
	if (plan.input === undefined || !plan.input.exists) return undefined;
	return sha256Json({ object: plan.input.digest, judgment: plan.judgment });
}

/** Reject a host configuration the engine cannot honour before anything is written. */
function validateHostConfig(config: DogConfig): void {
	for (const [name, value] of [
		["maxGraphNodes", config.maxGraphNodes],
		["maxExpressionNodes", config.maxExpressionNodes],
		["maxExpressionDepth", config.maxExpressionDepth],
		["maxSandboxBytes", config.maxSandboxBytes],
		["maxConcurrentVerifications", config.maxConcurrentVerifications],
	] as const) {
		if (value < 1 || !Number.isInteger(value)) throw new Error(`${name} must be a positive integer`);
	}
	if (
		config.storageDirectory.length === 0 ||
		isAbsolute(config.storageDirectory) ||
		hasTraversal(config.storageDirectory)
	) {
		throw new Error("storageDirectory must be a non-empty relative path without traversal");
	}
	if (!isAbsolute(config.workspaceRoot)) throw new Error("workspaceRoot must be absolute");
	if (!isAbsolute(config.scriptsDirectory)) throw new Error("scriptsDirectory must be absolute");
}

function requireTarget(target: TargetSpec, goalId: string): TargetSpec {
	if (target.kind === "path") {
		if (target.path.length === 0) throw new Error(`goal ${goalId} must declare a target`);
		if (isAbsolute(target.path)) throw new Error(`goal ${goalId} target must be workspace-relative (absolute given)`);
		return target;
	}
	if (target.ref.trim().length === 0) throw new Error(`goal ${goalId} git target must declare a ref`);
	const subpath = target.path;
	if (subpath !== undefined && (subpath.length === 0 || isAbsolute(subpath))) {
		throw new Error(`goal ${goalId} git target path must be a non-empty workspace-relative path`);
	}
	return target;
}

/** One capture per distinct target inside a single compile. */
function targetKey(target: TargetSpec): string {
	return target.kind === "path" ? `path:${target.path}` : `git:${target.ref}:${target.path ?? ""}`;
}

export function resolveScriptPath(scriptsDirectory: string, script: string): string {
	const direct = join(scriptsDirectory, script);
	if (existsSync(direct)) return direct;
	if (!script.endsWith(".js")) {
		const withJs = `${direct}.js`;
		if (existsSync(withJs)) return withJs;
	}
	throw new Error(`programmatic script not found in library: ${direct}`);
}

function readScriptDigest(scriptPath: string): string {
	try {
		return `sha256:${sha256Json({ script: readFileSync(scriptPath, "utf8") })}`;
	} catch {
		throw new Error(`programmatic script not found in library: ${scriptPath}`);
	}
}

function evaluateComposite(input: DogGraphInput, goals: Record<GoalId, GoalResult>, goalId: GoalId): GoalResult {
	const relations = input.contains.filter((edge) => edge.parent === goalId);
	const node = input.nodes[goalId];
	if (node?.completion === undefined)
		return { state: "needs_human", reason: "composite lost its completion expression" };
	const fatalRequired = relations.find(
		(edge) => edge.required && edge.failure === "fatal" && relationTruth(edge, goals) === false,
	);
	if (fatalRequired !== undefined) {
		return { state: "failure", reason: `required non-tolerable child ${fatalRequired.child} failed` };
	}
	const unknownRequired = relations.find((edge) => edge.required && relationTruth(edge, goals) === undefined);
	if (unknownRequired !== undefined) {
		return relationNeedsHuman(unknownRequired, goals)
			? { state: "needs_human", reason: `required child relation ${unknownRequired.child} requires human review` }
			: { state: "blocked", reason: `required child ${unknownRequired.child} is unresolved` };
	}
	const toleratedFailure = relations.find((edge) => edge.required && relationTruth(edge, goals) === false);
	if (toleratedFailure !== undefined) {
		return { state: "partial", reason: `required child ${toleratedFailure.child} failed under a tolerable policy` };
	}
	const values = new Map(relations.map((edge) => [edge.child, relationTruth(edge, goals)]));
	const completion = evaluateBoolExpr(node.completion, values);
	if (completion === true) return { state: "success" };
	if (completion === "unknown") {
		const humanChild = relations.find((edge) => relationNeedsHuman(edge, goals));
		return humanChild === undefined
			? { state: "blocked", reason: "one or more child outcomes are unresolved" }
			: { state: "needs_human", reason: `child ${humanChild.child} requires human review` };
	}
	const failed = relations.find((edge) => relationTruth(edge, goals) === false);
	return failed?.failure === "fatal"
		? { state: "failure", reason: `non-tolerable child ${failed.child} failed` }
		: {
				state: "partial",
				reason: "completion rule is false, but every failed child relation is tolerable or optional",
			};
}

/** The whole-object assertion may demote a settled composite; it never promotes one. */
function mergeWholeAssertion(logical: GoalResult, settled: Settlement): GoalResult {
	if (settled.state === "fail") return { state: "failure", reason: "whole-object assertion failed" };
	if (settled.state === "inconclusive") return { state: "needs_human", reason: "whole-object assertion inconclusive" };
	return logical;
}

function relationTruth(edge: ContainsEdge, goals: Record<GoalId, GoalResult>): boolean | undefined {
	const result = goals[edge.child];
	const state = result?.state;
	const inheritedPassed = state === "inherited" ? result?.verification?.passed : undefined;
	if (state === "success" || (state === "inherited" && inheritedPassed === true) || state === "partial") return true;
	if (state === "failure" || state === "blocked" || (state === "inherited" && inheritedPassed === false)) {
		if (edge.failure === "degrade" && edge.degradeTo !== undefined) {
			const substitute = goals[edge.degradeTo];
			if (substitute?.state === "success") return true;
			if (substitute?.state === "inherited") {
				if (substitute.verification?.passed === true) return true;
				if (substitute.verification?.passed === null || substitute.verification === undefined) return undefined;
			}
			if (substitute?.state === "needs_human" || substitute?.state === "invalidated") return undefined;
		}
		return false;
	}
	return undefined;
}

function relationNeedsHuman(edge: ContainsEdge, goals: Record<GoalId, GoalResult>): boolean {
	const state = goals[edge.child]?.state;
	const passed = goals[edge.child]?.verification?.passed;
	if (state === "needs_human" || state === "invalidated") return true;
	if (state === "inherited" && passed === null) return true;
	if (edge.failure === "degrade" && edge.degradeTo !== undefined) {
		const substitute = goals[edge.degradeTo];
		return (
			substitute?.state === "needs_human" ||
			substitute?.state === "invalidated" ||
			(substitute?.state === "inherited" && substitute.verification?.passed === null)
		);
	}
	return false;
}

function terminalState(rootResult: GoalResult | undefined, allowPartialRoot: boolean): RootTerminalState {
	if (rootResult?.state === "success" || rootResult?.state === "inherited") return "success";
	if (rootResult?.state === "partial" && allowPartialRoot) return "partial_success";
	if (rootResult?.state === "needs_human") return "needs_replan";
	return "failure";
}

function postorder(input: DogGraphInput): GoalId[] {
	const children = childrenByParent(input);
	const visited = new Set<GoalId>();
	const order: GoalId[] = [];
	const visit = (goalId: GoalId): void => {
		if (visited.has(goalId)) return;
		visited.add(goalId);
		for (const child of children.get(goalId) ?? []) visit(child);
		order.push(goalId);
	};
	visit(input.root);
	return order;
}

function dependenciesBySource(input: DogGraphInput): Map<GoalId, GoalId[]> {
	const map = new Map<GoalId, GoalId[]>();
	for (const edge of input.dependsOn) {
		map.set(edge.source, [...(map.get(edge.source) ?? []), edge.target]);
	}
	return map;
}

function childrenByParent(input: DogGraphInput): Map<GoalId, GoalId[]> {
	const map = new Map<GoalId, GoalId[]>();
	for (const edge of input.contains) {
		map.set(edge.parent, [...(map.get(edge.parent) ?? []), edge.child]);
	}
	return map;
}

function graphWarnings(graph: DogGraphInput): string[] {
	const warnings: string[] = [];
	for (const [goalId, node] of Object.entries(graph.nodes)) {
		if (node.constraint === "soft" && goalId !== graph.root) {
			warnings.push(`goal ${goalId} is soft; only the root constraint is enforced`);
		}
	}
	return warnings;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function boundedMessage(message: string): string {
	return message.length > 512 ? message.slice(0, 512) : message;
}

function hasTraversal(value: string): boolean {
	return value.split(/[\\/]/u).some((segment) => segment === ".." || segment === ".");
}
