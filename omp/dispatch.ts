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

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { sha256Json } from "../core/json.ts";
import { dependencyComplete } from "../core/logic.ts";
import type { AcceptancePlan, CompiledGraph, DogGraphInput, DogRun } from "../core/model.ts";
import type { DogRepository } from "../core/storage.ts";
import { buildDispatchRequest, instructionHashOf, resolveSettlement, type DispatchRequest } from "./settlement.ts";

export interface DeferredGoal {
	readonly goalId: string;
	readonly target: string;
	readonly reason: string;
}

/** An agentic goal whose prerequisites have not settled yet — dispatching it now would judge out of order. */
export interface WaitingGoal {
	readonly goalId: string;
	readonly target: string;
	/** The dependency targets and/or children this judgment waits for. */
	readonly waitingOn: readonly string[];
	readonly reason: string;
}

export interface DispatchPlan {
	/** Agentic goals that need a verifier dispatch before the engine can judge them. */
	readonly required: readonly DispatchRequest[];
	/** Agentic goals with nothing to judge yet (no captured object). */
	readonly deferred: readonly DeferredGoal[];
	/** Agentic goals whose dependencies are still running; they enter `required` on a later call. */
	readonly waiting: readonly WaitingGoal[];
	/** Goals the next run inherits from a prior run instead of re-judging. */
	readonly inherited: readonly string[];
}

/** Engine's inheritance anchor, mirrored verbatim (`anchorOfPlan` in core/engine.ts). */
function anchorOf(plan: AcceptancePlan): string | undefined {
	if (plan.input === undefined || !plan.input.exists) return undefined;
	return sha256Json({ object: plan.input.digest, judgment: plan.judgment });
}

function isInherited(priorRun: DogRun | undefined, goalId: string, anchor: string | undefined): boolean {
	if (priorRun === undefined || anchor === undefined) return false;
	if (priorRun.gmDigests[goalId] !== anchor) return false;
	return priorRun.goals[goalId]?.verification !== undefined;
}

export async function planDispatch(options: {
	readonly compiled: CompiledGraph;
	readonly dogRoot: string;
	readonly priorRun: DogRun | undefined;
	/** The live run, when one exists: dependency gating reads its goal states. */
	readonly run?: DogRun | undefined;
}): Promise<DispatchPlan> {
	const { compiled, dogRoot, priorRun } = options;
	const run = options.run ?? priorRun;
	const prerequisites = prerequisitesOf(compiled.input);
	const outcomes = await Promise.all(Object.keys(compiled.input.nodes).toSorted().map(planOneGoal));
	const required: DispatchRequest[] = [];
	const deferred: DeferredGoal[] = [];
	const waiting: WaitingGoal[] = [];
	const inherited: string[] = [];
	for (const outcome of outcomes) {
		if (outcome.kind === "required") required.push(outcome.request);
		else if (outcome.kind === "inherited") inherited.push(outcome.goalId);
		else if (outcome.kind === "deferred") deferred.push(outcome.goal);
		else if (outcome.kind === "waiting") waiting.push(outcome.goal);
	}
	return { required, deferred, waiting, inherited };

	/**
	 * One goal's verdict on what the engine still needs. The settlement read is the
	 * only I/O here, so every goal is classified concurrently.
	 */
	async function planOneGoal(goalId: string): Promise<GoalOutcome> {
		const plan = compiled.acceptancePlans[goalId];
		if (plan === undefined) return { kind: "skip" };
		const verifier = plan.verifier;
		if (verifier.mode !== "agentic") return { kind: "skip" };
		if (isInherited(priorRun, goalId, anchorOf(plan))) return { kind: "inherited", goalId };
		if (plan.input === undefined || !plan.input.exists) {
			return {
				kind: "deferred",
				goal: {
					goalId,
					target: plan.target,
					reason: "no object was captured at the declared target; nothing to judge",
				},
			};
		}
		const request = buildDispatchRequest({
			dogRoot,
			graphDigest: compiled.graphDigest,
			goalId,
			target: plan.target,
			instruction: verifier.instruction,
			inputSha256: plan.input.sha256,
			captured: plan.input,
		});
		// Exactly the rule the kernel will apply, so a goal reported as settled here
		// is one the kernel accepts, and a settlement the kernel would refuse is
		// dispatched again instead of stranding the goal.
		const resolution = await resolveSettlement({
			settlementPath: request.settlementPath,
			requestPath: request.requestPath,
			inputSha256: request.inputSha256,
			instructionHash: instructionHashOf(request.instruction),
		});
		if (resolution.ok) return { kind: "skip" };
		// A judgment that waits for a dependency or for its own children runs in a
		// later wave: the engine's own wakeup gate is the same completion rule, and
		// dispatching early would judge an object whose inputs are still moving.
		const unsettled = (prerequisites.get(goalId) ?? []).filter((id) => !dependencyComplete(run?.goals[id]));
		if (unsettled.length > 0) {
			return {
				kind: "waiting",
				goal: {
					goalId,
					target: plan.target,
					waitingOn: unsettled,
					reason: `waiting for ${unsettled.join(", ")} to settle before this judgment can run`,
				},
			};
		}
		return { kind: "required", request };
	}
}

/**
 * What a judgment waits for: its `dependsOn` targets, plus — for a composite
 * with its own assertion — its children. Mirrors the engine's scheduling gate
 * (`unresolvedChild`/`blockedDependency` in core/engine.ts), so the pre-flight
 * plan and the engine never disagree about what is ready.
 */
function prerequisitesOf(input: DogGraphInput): Map<string, string[]> {
	const map = new Map<string, string[]>();
	const add = (goalId: string, prerequisite: string): void => {
		const list = map.get(goalId) ?? [];
		if (!list.includes(prerequisite)) list.push(prerequisite);
		map.set(goalId, list);
	};
	for (const edge of input.dependsOn) add(edge.source, edge.target);
	for (const edge of input.contains) add(edge.parent, edge.child);
	return map;
}

/** What one agentic goal contributes to the dispatch plan. */
type GoalOutcome =
	| { readonly kind: "skip" }
	| { readonly kind: "inherited"; readonly goalId: string }
	| { readonly kind: "deferred"; readonly goal: DeferredGoal }
	| { readonly kind: "waiting"; readonly goal: WaitingGoal }
	| { readonly kind: "required"; readonly request: DispatchRequest };

export interface MaterializedObject {
	/** Path the verifier reads: the frozen copy, never the live tree. */
	readonly path: string;
	readonly kind: "file" | "directory";
}

/**
 * Freeze the captured object back onto disk for the verifier.
 *
 * The engine already judged a capture, not the live tree; handing the verifier
 * the live path would let it pass bytes the engine never saw. Extracting the
 * packed tar keeps the verifier's input byte-identical to the capture.
 */
export async function materializeObject(options: {
	readonly repository: DogRepository;
	readonly pi: ExtensionAPI;
	readonly request: DispatchRequest;
	readonly cwd: string;
}): Promise<MaterializedObject | undefined> {
	const { repository, pi, request } = options;
	const root = join(dirname(request.requestPath), request.requestId, "object");
	const bytes = await repository.read(request.captured);
	await mkdir(root, { recursive: true });
	if (!request.packed) {
		const target = join(root, request.target);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, bytes);
		return { path: target, kind: "file" };
	}
	const archive = join(dirname(request.requestPath), `${request.requestId}.tar`);
	await writeFile(archive, bytes);
	const extracted = await pi.exec("tar", ["-xf", archive, "-C", root], { cwd: options.cwd, timeout: 120_000 });
	if (extracted.code !== 0) return undefined;
	return { path: join(root, request.target), kind: "directory" };
}
