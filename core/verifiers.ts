/** DoG verification kernels: exactly two — programmatic (script) and agentic (session). */

import { isJsonValue, type AcceptancePlan, type GoalId, type JsonValue } from "./model.ts";

/** A verdict is a two-field minimum: the judgment and free-form evidence. */
export interface Verdict {
	readonly state: "pass" | "fail" | "inconclusive";
	readonly evidence: JsonValue;
	readonly reason?: string;
	/** Verifier session transcript, when the agentic kernel produced this verdict. */
	readonly sessionFile?: string;
}

/** What one judgment is about, beyond the instruction text. */
export interface VerifierTarget {
	readonly goalId: GoalId;
	readonly title: string;
	/** Path of the frozen object inside the kernel workspace. */
	readonly target: string;
	/** True when a directory capture was unpacked there. */
	readonly isDirectory: boolean;
	/** Where the object came from when that is not a live path (a git ref). */
	readonly provenance?: string;
	/** Frozen background the graph wants every agentic verifier to read first. */
	readonly background?: string;
	readonly byteLength?: number;
	readonly sha256?: string;
}

export interface VerifierExecutionEnv {
	readonly runId: string;
	readonly goalId: GoalId;
	readonly signal?: AbortSignal;
}

/** Programmatic kernel: runs a host-registered script with the frozen object's path. */
export type ProgrammaticRunner = (script: string, inputPath: string, env: VerifierExecutionEnv) => Promise<Verdict>;

/** Agentic kernel: hands one instruction plus the frozen object to a verifier session. */
export type AgenticRunner = (
	instruction: string,
	/** Working directory holding the frozen object; the verifier may read nothing else. */
	workspace: string,
	target: VerifierTarget,
	env: VerifierExecutionEnv,
) => Promise<Verdict>;

/** Result of one judgment, unified across both kernels. */
export interface Settlement {
	readonly state: "pass" | "fail" | "inconclusive";
	readonly observation: Record<string, JsonValue>;
	readonly evidence?: JsonValue;
	readonly sessionFile?: string;
}

/** Where one goal's frozen object was materialized for its verifier. */
export interface PreparedObject {
	/** Directory handed to the kernel. */
	readonly workspace: string;
	/** Absolute path of the frozen object inside that directory. */
	readonly inputPath: string;
}

/**
 * Run one plan through the selected kernel. The engine holds none of the
 * judgment semantics: programmatic goes to a script, agentic to a session that
 * receives the instruction text and nothing else.
 */
export async function runPlan(
	plan: AcceptancePlan,
	prepared: PreparedObject,
	target: VerifierTarget,
	env: VerifierExecutionEnv,
	programmatic: ProgrammaticRunner | undefined,
	agentic: AgenticRunner | undefined,
): Promise<Settlement> {
	if (plan.verifier.mode === "programmatic") {
		if (programmatic === undefined) {
			return { state: "inconclusive", observation: { outcome: "programmatic kernel unavailable" } };
		}
		const verdict = await programmatic(plan.verifier.script, prepared.inputPath, env);
		return {
			state: verdict.state,
			observation: evidenceToObservation(verdict),
			...(verdict.evidence === undefined ? {} : { evidence: verdict.evidence }),
		};
	}
	if (agentic === undefined) {
		return { state: "inconclusive", observation: { outcome: "agentic kernel unavailable" } };
	}
	const verdict = await agentic(plan.verifier.instruction, prepared.workspace, target, env);
	return {
		state: verdict.state,
		observation: evidenceToObservation(verdict),
		...(verdict.evidence === undefined ? {} : { evidence: verdict.evidence }),
		...(verdict.sessionFile === undefined ? {} : { sessionFile: verdict.sessionFile }),
	};
}

function evidenceToObservation(verdict: Verdict): Record<string, JsonValue> {
	const observation: Record<string, JsonValue> = { outcome: verdict.state };
	if (verdict.reason !== undefined) observation.reason = verdict.reason;
	if (verdict.evidence !== undefined && isJsonValue(verdict.evidence)) observation.evidence = verdict.evidence;
	return observation;
}
