/** Runs, compiled graphs, and the per-goal ledger, in one wire-shaped report. */

import type { CompiledGraph, DogRun, GoalResult, JsonValue, VerificationRecord } from "../core/model.ts";

/** What `dog_create` hands back: the frozen plans, without capture bytes. */
export function compiledSummary(compiled: CompiledGraph): JsonValue {
	return {
		graphId: compiled.input.id,
		graphDigest: compiled.graphDigest,
		nodes: Object.keys(compiled.input.nodes).length,
		acceptancePlans: Object.entries(compiled.acceptancePlans).map(([goalId, plan]) => ({
			goalId,
			mode: plan.verifier.mode,
			...(plan.verifier.mode === "programmatic"
				? { script: plan.verifier.script }
				: { instruction: plan.verifier.instruction }),
			target: plan.target,
			...(plan.input === undefined
				? {}
				: { digest: plan.input.digest, exists: plan.input.exists, byteLength: plan.input.byteLength }),
		})) as unknown as JsonValue,
	};
}

export interface ReportGoal {
	readonly goalId: string;
	readonly state: GoalResult["state"];
	readonly reason?: string;
	readonly inheritedFrom?: string;
	readonly judgment?: VerificationRecord["judgment"];
	readonly verifier?: VerificationRecord["verifier"];
	readonly evidence?: JsonValue;
	readonly at?: string;
}

export interface DogReport {
	readonly runId: string;
	readonly graphId: string;
	readonly graphDigest: string;
	readonly state: DogRun["state"];
	readonly rootState: DogRun["rootState"] | null;
	readonly warning?: string;
	readonly inherited: readonly string[];
	readonly goals: readonly ReportGoal[];
	readonly generatedAt: string;
}

/** One report shape for the CLI, the host tools, and the ledger view. */
export function buildReport(run: DogRun): DogReport {
	const goals = Object.entries(run.goals)
		.map(([goalId, result]) => ({
			goalId,
			state: result.state,
			...(result.reason === undefined ? {} : { reason: result.reason }),
			...(result.inheritedFrom === undefined ? {} : { inheritedFrom: result.inheritedFrom }),
			...(result.verification === undefined
				? {}
				: {
						judgment: result.verification.judgment,
						...(result.verification.verifier === undefined ? {} : { verifier: result.verification.verifier }),
						...(result.verification.evidence === undefined ? {} : { evidence: result.verification.evidence }),
						at: result.verification.at,
					}),
		}))
		.sort((left, right) => left.goalId.localeCompare(right.goalId));
	return {
		runId: run.runId,
		graphId: run.graphId,
		graphDigest: run.graphDigest,
		state: run.state,
		rootState: run.rootState ?? null,
		...(run.runtimeWarning === undefined ? {} : { warning: run.runtimeWarning }),
		inherited: Object.entries(run.goals)
			.filter(([, result]) => result.state === "inherited")
			.map(([goalId]) => goalId),
		goals,
		generatedAt: run.updatedAt,
	};
}
