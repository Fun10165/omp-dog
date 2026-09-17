/**
 * The `/dog` ledger view for one goal: what was decided, on what evidence, and —
 * when the verdict came from a dispatched verifier — who reported it.
 */

import type { DogRun, GoalRuntimeEvent, VerificationRecord } from "../core/model.ts";
import type { VerifierBinding } from "./bindings.ts";

export interface LedgerEvent {
	readonly phase: GoalRuntimeEvent["phase"];
	readonly state: GoalRuntimeEvent["state"] | null;
	readonly at: string;
	readonly reason: string | null;
}

export interface LedgerAdoption {
	readonly requestId: string;
	readonly settlementPath: string;
	readonly state: string;
	/** As reported by the settlement itself; not an authenticated identity. */
	readonly reportedVerifier: string | null;
	readonly adoptedAt: string;
}

export interface LedgerView {
	readonly runId: string;
	readonly goalId: string;
	readonly state: string;
	readonly reason: string | null;
	readonly inheritedFrom: string | null;
	readonly verification: VerificationRecord | null;
	/** Null for goals judged by the programmatic kernel, or never judged. */
	readonly adoption: LedgerAdoption | null;
	readonly events: readonly LedgerEvent[];
}

export function ledgerView(options: {
	readonly run: DogRun;
	readonly goalId: string;
	readonly events: readonly GoalRuntimeEvent[];
	readonly binding: VerifierBinding | undefined;
}): LedgerView {
	const goal = options.run.goals[options.goalId];
	if (goal === undefined) {
		throw new Error(`goal ${options.goalId} is not part of run ${options.run.runId}`);
	}
	return {
		runId: options.run.runId,
		goalId: options.goalId,
		state: goal.state,
		reason: goal.reason ?? null,
		inheritedFrom: goal.inheritedFrom ?? null,
		verification: goal.verification ?? null,
		adoption:
			options.binding === undefined
				? null
				: {
						requestId: options.binding.requestId,
						settlementPath: options.binding.settlementPath,
						state: options.binding.state,
						reportedVerifier: options.binding.reportedVerifier ?? null,
						adoptedAt: options.binding.adoptedAt,
					},
		events: options.events.map((event) => ({
			phase: event.phase,
			state: event.state ?? null,
			at: event.at,
			reason: event.reason ?? null,
		})),
	};
}
