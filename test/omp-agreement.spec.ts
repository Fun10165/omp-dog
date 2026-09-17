/**
 * The dispatch pre-flight and the agentic kernel must agree on one question:
 * "does this settlement answer this judgment?"
 *
 * They were two copies of the same rule once, and they drifted: the pre-flight
 * accepted a settlement the kernel refused (it predated its own dispatch
 * request), so `dog_run` reported nothing to dispatch, the engine judged the goal
 * `needs_human`, and no path back to a re-dispatch existed. This file pins the
 * agreement itself, not either side's implementation.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Json } from "../core/json.ts";
import type { CompiledGraph } from "../core/model.ts";
import { planDispatch } from "../omp/dispatch.ts";
import { createAgenticRunner } from "../omp/kernels.ts";
import { buildDispatchRequest, instructionHashOf, writeDispatchRequest } from "../omp/settlement.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const INSTRUCTION = "The captured file must contain the exact line: smoke artifact";
const TARGET = "artifact.txt";
const GOAL = "leaf";

/** A one-goal agentic graph: nothing but the plan data the two sides read. */
async function fixture(): Promise<{
	readonly dogRoot: string;
	readonly compiled: CompiledGraph;
	readonly objectPath: string;
}> {
	const work = await mkdtemp(join(tmpdir(), "omp-dog-agreement-"));
	temporaryRoots.push(work);
	const dogRoot = join(work, ".omp", "dog");
	const objectPath = join(work, TARGET);
	const bytes = Buffer.from("smoke artifact\n");
	await writeFile(objectPath, bytes);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const compiled: CompiledGraph = {
		input: {
			schemaVersion: "0.9",
			id: "agreement",
			root: GOAL,
			nodes: {
				root: {
					kind: "composite",
					title: "root",
					constraint: "hard",
					target: TARGET,
					completion: { op: "ref", id: GOAL },
				},
				[GOAL]: {
					kind: "leaf",
					title: "leaf",
					constraint: "hard",
					target: TARGET,
					verifier: { mode: "agentic", instruction: INSTRUCTION },
				},
			},
			contains: [{ parent: "root", child: GOAL, required: true, failure: "fatal" }],
			dependsOn: [],
		},
		graphDigest: sha256Json({ fixture: "agreement" }),
		acceptancePlans: {
			[GOAL]: {
				goalId: GOAL,
				verifier: { mode: "agentic", instruction: INSTRUCTION },
				judgment: { mode: "agentic", instructionHash: instructionHashOf(INSTRUCTION) },
				target: TARGET,
				input: { path: TARGET, digest: `sha256:${sha256}`, exists: true, byteLength: bytes.byteLength, sha256 },
			},
		},
	};
	return { dogRoot, compiled, objectPath };
}

/** Write a settlement, then force its mtime to a chosen point in time. */
async function settle(
	dogRoot: string,
	compiled: CompiledGraph,
	options: { readonly mtimeMs: number; readonly state?: "pass" | "fail" | "inconclusive" },
): Promise<string> {
	const plan = compiled.acceptancePlans[GOAL]!;
	const request = buildDispatchRequest({
		dogRoot,
		graphDigest: compiled.graphDigest,
		goalId: GOAL,
		target: TARGET,
		instruction: INSTRUCTION,
		inputSha256: plan.input!.sha256,
		captured: plan.input!,
	});
	await writeDispatchRequest(request);
	await writeFile(
		request.settlementPath,
		JSON.stringify({
			schemaVersion: "0.1",
			requestId: request.requestId,
			goalId: GOAL,
			graphDigest: compiled.graphDigest,
			instructionHash: request.instructionHash,
			inputSha256: request.inputSha256,
			state: options.state ?? "pass",
			evidence: { outcome: "judged" },
			settledAt: new Date(options.mtimeMs).toISOString(),
		}),
		"utf8",
	);
	await utimes(request.settlementPath, options.mtimeMs / 1000, options.mtimeMs / 1000);
	return request.settlementPath;
}

describe("dispatch pre-flight and kernel agree on settlement validity", () => {
	it("dispatches again when the settlement predates its own request, and the kernel refuses it too", async () => {
		const { dogRoot, compiled, objectPath } = await fixture();
		const request = compiled.acceptancePlans[GOAL]!;
		const settlementPath = await settle(dogRoot, compiled, { mtimeMs: Date.now() - 60_000 });
		// Make the request unambiguously newer than the settlement it produced.
		const requestPath = join(
			dogRoot,
			"dispatches",
			`${sha256Json({
				graphDigest: compiled.graphDigest,
				goalId: GOAL,
				instructionHash: instructionHashOf(INSTRUCTION),
				inputSha256: request.input!.sha256,
			})}.request.json`,
		);
		const now = Date.now() / 1000;
		await utimes(requestPath, now, now);

		const plan = await planDispatch({ compiled, dogRoot, priorRun: undefined });
		expect(plan.required.map((entry) => entry.goalId)).toStrictEqual([GOAL]);
		expect(plan.inherited).toStrictEqual([]);

		const runner = createAgenticRunner({ dogRoot, graphDigestFor: () => compiled.graphDigest });
		const verdict = await runner(INSTRUCTION, { path: dogRoot }, objectPath, { runId: "run-1", goalId: GOAL });
		expect(verdict.state).toBe("inconclusive");
		expect(verdict.evidence).toMatchObject({ outcome: "settlement predates its dispatch request" });
		expect(settlementPath.startsWith(dogRoot)).toBe(true);
	});

	it("treats a settlement newer than its request as valid on both sides", async () => {
		const { dogRoot, compiled, objectPath } = await fixture();
		await settle(dogRoot, compiled, { mtimeMs: Date.now() + 1_000 });

		const plan = await planDispatch({ compiled, dogRoot, priorRun: undefined });
		expect(plan.required).toStrictEqual([]);

		const runner = createAgenticRunner({ dogRoot, graphDigestFor: () => compiled.graphDigest });
		const verdict = await runner(INSTRUCTION, { path: dogRoot }, objectPath, { runId: "run-2", goalId: GOAL });
		expect(verdict.state).toBe("pass");
		expect(verdict.evidence).toMatchObject({ outcome: "judged" });
	});

	it("keeps agreeing when the live tree changes under a judgment about the frozen capture", async () => {
		const { dogRoot, compiled, objectPath } = await fixture();
		await settle(dogRoot, compiled, { mtimeMs: Date.now() + 1_000 });
		// The kernel is handed the materialized capture, exactly as the engine does
		// it, so the live file changing underneath is not part of the judgment.
		const frozen = join(dogRoot, "frozen-copy.txt");
		await writeFile(frozen, await readFile(objectPath));
		await writeFile(objectPath, "something else entirely\n");

		const plan = await planDispatch({ compiled, dogRoot, priorRun: undefined });
		expect(plan.required).toStrictEqual([]);

		const runner = createAgenticRunner({ dogRoot, graphDigestFor: () => compiled.graphDigest });
		const verdict = await runner(INSTRUCTION, { path: dogRoot }, frozen, { runId: "run-3", goalId: GOAL });
		expect(verdict.state).toBe("pass");
		expect(await readFile(objectPath, "utf8")).toBe("something else entirely\n");
	});
});
