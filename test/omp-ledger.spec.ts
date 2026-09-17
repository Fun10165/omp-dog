/** The `/dog` ledger view: what was decided, on what evidence, and who reported it. */

import { describe, expect, it } from "vitest";
import type { DogRun, GoalResult, GoalRuntimeEvent } from "../core/model.ts";
import type { VerifierBinding } from "../omp/bindings.ts";
import { ledgerView } from "../omp/ledger.ts";

const RUN_ID = "run-1";
const GOAL_ID = "leaf";

function run(goal: GoalResult): DogRun {
	return {
		runId: RUN_ID,
		graphId: "graph",
		graphDigest: "digest",
		state: "completed",
		rootState: "success",
		gmDigests: {},
		goals: { [GOAL_ID]: goal },
		createdAt: "2026-09-17T00:00:00.000Z",
		updatedAt: "2026-09-17T00:00:00.000Z",
	};
}

const binding: VerifierBinding = {
	runId: RUN_ID,
	goalId: GOAL_ID,
	requestId: "request-1",
	settlementPath: "/tmp/settlement.json",
	graphDigest: "digest",
	state: "pass",
	reportedVerifier: "dog-verify-7",
	adoptedAt: "2026-09-17T00:01:00.000Z",
};

const events: readonly GoalRuntimeEvent[] = [
	{
		schemaVersion: "0.1",
		runId: RUN_ID,
		goalId: GOAL_ID,
		phase: "verifier_passed",
		state: "success",
		at: "2026-09-17T00:01:00.000Z",
		reason: "trusted verifier rejected the captured input",
	},
	{
		schemaVersion: "0.1",
		runId: RUN_ID,
		goalId: GOAL_ID,
		phase: "goal_settled",
		state: "success",
		at: "2026-09-17T00:01:00.000Z",
	},
];

describe("ledger view", () => {
	it("surfaces the adoption record beside the verdict", () => {
		const view = ledgerView({
			run: run({ state: "success" }),
			goalId: GOAL_ID,
			events,
			binding,
		});
		expect(view.state).toBe("success");
		expect(view.adoption).toStrictEqual({
			requestId: "request-1",
			settlementPath: "/tmp/settlement.json",
			state: "pass",
			reportedVerifier: "dog-verify-7",
			adoptedAt: "2026-09-17T00:01:00.000Z",
		});
		expect(view.events).toHaveLength(2);
		expect(view.events[0]).toStrictEqual({
			phase: "verifier_passed",
			state: "success",
			at: "2026-09-17T00:01:00.000Z",
			reason: "trusted verifier rejected the captured input",
		});
	});

	it("reports no adoption for a goal judged by the script kernel", () => {
		const view = ledgerView({
			run: run({ state: "success" }),
			goalId: GOAL_ID,
			events: [],
			binding: undefined,
		});
		expect(view.adoption).toBeNull();
		expect(view.events).toStrictEqual([]);
	});

	it("keeps a missing reason and a missing inheritance as null, not undefined", () => {
		const view = ledgerView({ run: run({ state: "pending" }), goalId: GOAL_ID, events: [], binding: undefined });
		expect(view.reason).toBeNull();
		expect(view.inheritedFrom).toBeNull();
		expect(view.verification).toBeNull();
	});

	it("refuses a goal that is not part of the run", () => {
		expect(() =>
			ledgerView({ run: run({ state: "success" }), goalId: "nope", events: [], binding: undefined }),
		).toThrow(/nope/);
	});
});
