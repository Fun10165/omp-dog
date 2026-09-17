/** OMP adapter: derived dispatch identity, idempotent request persistence, fail-closed settlements. */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Json } from "../core/json.ts";
import type { CapturedInput } from "../core/model.ts";
import {
	buildDispatchRequest,
	dispatchDirectory,
	instructionHashOf,
	modifiedAtMs,
	readSettlement,
	sha256OfFile,
	writeDispatchRequest,
	type DispatchRequest,
} from "../omp/settlement.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "omp-dog-settlement-"));
	temporaryRoots.push(path);
	return path;
}

/** A stable, non-zero captured-bytes digest. */
const BYTES_SHA = "b".repeat(64);

function capture(overrides: Partial<CapturedInput> = {}): CapturedInput {
	return {
		path: "artifact.txt",
		digest: `sha256:${BYTES_SHA}`,
		exists: true,
		byteLength: 12,
		sha256: BYTES_SHA,
		...overrides,
	};
}

function dispatchRequest(
	dogRoot: string,
	overrides: {
		readonly graphDigest?: string;
		readonly goalId?: string;
		readonly instruction?: string;
		readonly inputSha256?: string;
		readonly captured?: CapturedInput;
	} = {},
): DispatchRequest {
	return buildDispatchRequest({
		dogRoot,
		graphDigest: overrides.graphDigest ?? "graph-digest-1",
		goalId: overrides.goalId ?? "leaf",
		target: "artifact.txt",
		instruction: overrides.instruction ?? "judge the artifact against the criteria",
		inputSha256: overrides.inputSha256 ?? BYTES_SHA,
		captured: overrides.captured ?? capture(),
	});
}

describe("dispatch request identity", () => {
	it("derives the request ID from graph revision, goal, instruction and captured bytes", async () => {
		const dogRoot = join(await temporaryRoot(), ".omp", "dog");
		const request = dispatchRequest(dogRoot, { instruction: "the instruction" });
		expect(request.instructionHash).toBe(`sha256:${sha256Json({ instruction: "the instruction" })}`);
		expect(request.instructionHash).toBe(instructionHashOf("the instruction"));
		expect(request.requestId).toBe(
			sha256Json({
				graphDigest: "graph-digest-1",
				goalId: "leaf",
				instructionHash: request.instructionHash,
				inputSha256: BYTES_SHA,
			}),
		);
		// Both files the verifier and the kernel exchange live under one directory,
		// and both are keyed by that derived ID.
		const directory = dispatchDirectory(dogRoot);
		expect(directory).toBe(join(dogRoot, "dispatches"));
		expect(request.requestPath).toBe(join(directory, `${request.requestId}.request.json`));
		expect(request.settlementPath).toBe(join(directory, `${request.requestId}.settlement.json`));
	});

	it("keeps the ID stable for the same judgment and changes it when any binding field changes", async () => {
		const dogRoot = join(await temporaryRoot(), ".omp", "dog");
		const base = dispatchRequest(dogRoot);
		expect(dispatchRequest(dogRoot).requestId).toBe(base.requestId);

		const variants: ReadonlyArray<readonly [string, DispatchRequest]> = [
			["graph revision", dispatchRequest(dogRoot, { graphDigest: "graph-digest-2" })],
			["goal", dispatchRequest(dogRoot, { goalId: "other-goal" })],
			["instruction", dispatchRequest(dogRoot, { instruction: "a different instruction" })],
			["captured bytes", dispatchRequest(dogRoot, { inputSha256: "c".repeat(64) })],
		];
		for (const [label, variant] of variants) {
			expect(variant.requestId, label).not.toBe(base.requestId);
			expect(variant.requestPath, label).not.toBe(base.requestPath);
		}
		expect(new Set([base.requestId, ...variants.map(([, variant]) => variant.requestId)]).size).toBe(
			1 + variants.length,
		);
	});

	it("carries the packed flag so the verifier is handed an extracted tree", async () => {
		const dogRoot = join(await temporaryRoot(), ".omp", "dog");
		const packed = dispatchRequest(dogRoot, { captured: capture({ path: "reports", packed: true }) });
		expect(packed.packed).toBe(true);
		const single = dispatchRequest(dogRoot, { captured: capture() });
		expect(single.packed).toBe(false);
	});
});

describe("dispatch request persistence", () => {
	it("writes the request once and never rewrites an existing file", async () => {
		const dogRoot = join(await temporaryRoot(), ".omp", "dog");
		const request = dispatchRequest(dogRoot);
		await writeDispatchRequest(request);
		const written = await readFile(request.requestPath, "utf8");
		expect(JSON.parse(written)).toMatchObject({
			requestId: request.requestId,
			goalId: "leaf",
			instruction: request.instruction,
			instructionHash: request.instructionHash,
			inputSha256: request.inputSha256,
		});

		// Age the file, then dispatch the same judgment again: the mtime is when the
		// judgment was first handed out, so a rewrite would bump it back to now.
		const aged = new Date(Date.now() - 600_000);
		await utimes(request.requestPath, aged, aged);
		await writeDispatchRequest(request);
		expect(await modifiedAtMs(request.requestPath)).toBeLessThan(aged.getTime() + 1_000);

		// Even a payload for a different judgment landing on this path is ignored.
		const forged: DispatchRequest = {
			...dispatchRequest(dogRoot, { instruction: "rewritten" }),
			requestPath: request.requestPath,
		};
		await writeDispatchRequest(forged);
		expect(await readFile(request.requestPath, "utf8")).toBe(written);
	});

	it("reports mtime only for paths that exist", async () => {
		const root = await temporaryRoot();
		const path = join(root, "present.txt");
		await writeFile(path, "x");
		const present = await modifiedAtMs(path);
		expect(typeof present).toBe("number");
		expect(present!).toBeGreaterThan(0);
		expect(present!).toBeLessThanOrEqual(Date.now() + 1_000);
		expect(await modifiedAtMs(join(root, "absent.txt"))).toBeUndefined();
	});
});

describe("settlement reading", () => {
	it("reads a well-formed settlement and defaults the fields it can rebuild", async () => {
		const root = await temporaryRoot();
		const minimal = join(root, "minimal.json");
		await writeFile(
			minimal,
			JSON.stringify({
				state: "fail",
				requestId: "req-1",
				goalId: "leaf",
				instructionHash: "sha256:aaaa",
				inputSha256: BYTES_SHA,
			}),
		);
		expect(await readSettlement(minimal)).toEqual({
			schemaVersion: "0.1",
			requestId: "req-1",
			graphDigest: "",
			goalId: "leaf",
			instructionHash: "sha256:aaaa",
			inputSha256: BYTES_SHA,
			state: "fail",
			settledAt: "",
		});

		const full = join(root, "full.json");
		await writeFile(
			full,
			JSON.stringify({
				schemaVersion: "0.3",
				state: "pass",
				requestId: "req-2",
				graphDigest: "graph-digest-1",
				goalId: "leaf",
				instructionHash: "sha256:bbbb",
				inputSha256: BYTES_SHA,
				evidence: { checked: 3, notes: ["a", null] },
				reason: "three artifacts inspected",
				verifierAgent: "dog-verifier",
				settledAt: "2026-09-17T00:00:00.000Z",
			}),
		);
		expect(await readSettlement(full)).toEqual({
			schemaVersion: "0.3",
			requestId: "req-2",
			graphDigest: "graph-digest-1",
			goalId: "leaf",
			instructionHash: "sha256:bbbb",
			inputSha256: BYTES_SHA,
			state: "pass",
			evidence: { checked: 3, notes: ["a", null] },
			reason: "three artifacts inspected",
			verifierAgent: "dog-verifier",
			settledAt: "2026-09-17T00:00:00.000Z",
		});
	});

	it("reads every broken shape as absent, never as a verdict", async () => {
		const root = await temporaryRoot();
		const cases: ReadonlyArray<readonly [string, string]> = [
			["empty file", ""],
			["not JSON", "settled: pass"],
			["JSON null", "null"],
			["JSON string", '"pass"'],
			["JSON number", "7"],
			["JSON array", '[{"state":"pass"}]'],
			["no state", '{"requestId":"r","goalId":"g","instructionHash":"i","inputSha256":"s"}'],
			["invalid state", '{"state":"maybe","requestId":"r","goalId":"g","instructionHash":"i","inputSha256":"s"}'],
			["state not a string", '{"state":true,"requestId":"r","goalId":"g","instructionHash":"i","inputSha256":"s"}'],
			["missing goalId", '{"state":"pass","requestId":"r","instructionHash":"i","inputSha256":"s"}'],
			["missing requestId", '{"state":"pass","goalId":"g","instructionHash":"i","inputSha256":"s"}'],
			["missing instructionHash", '{"state":"pass","requestId":"r","goalId":"g","inputSha256":"s"}'],
			["missing inputSha256", '{"state":"pass","requestId":"r","goalId":"g","instructionHash":"i"}'],
			[
				"non-string inputSha256",
				'{"state":"pass","requestId":"r","goalId":"g","instructionHash":"i","inputSha256":12}',
			],
		];
		for (const [label, source] of cases) {
			const path = join(root, `${label.replaceAll(/[^a-z]+/giu, "-")}.json`);
			await writeFile(path, source);
			expect(await readSettlement(path), label).toBeUndefined();
		}
		expect(await readSettlement(join(root, "never-written.json"))).toBeUndefined();
	});

	it("reports captured bytes by content hash so staleness is checked against bytes", async () => {
		const root = await temporaryRoot();
		const path = join(root, "captured.bin");
		const bytes = Buffer.from("captured payload\n");
		await writeFile(path, bytes);
		expect(await sha256OfFile(path)).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(await sha256OfFile(join(root, "absent.bin"))).toBeUndefined();
	});
});
