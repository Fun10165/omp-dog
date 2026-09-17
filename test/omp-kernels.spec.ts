/** OMP adapter: script verdict parsing and the fail-closed agentic settlement kernel. */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { sha256Json } from "../core/json.ts";
import type { Verdict, VerifierExecutionEnv } from "../core/verifiers.ts";
import { createAgenticRunner, createProgrammaticRunner, parseVerdict } from "../omp/kernels.ts";
import {
	buildDispatchRequest,
	instructionHashOf,
	readSettlement,
	writeDispatchRequest,
	type DispatchRequest,
} from "../omp/settlement.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "omp-dog-kernels-"));
	temporaryRoots.push(path);
	return path;
}

/** Only `exec` is ever touched by the kernels; the rest of the API stays absent. */
type ExecFunction = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

function fakePi(exec: ExecFunction): ExtensionAPI {
	return { exec } as unknown as ExtensionAPI;
}

/** Field set shared by every successful fake `exec` result. */
const OK_EXEC = { stderr: "", code: 0, killed: false } as const;

function evidenceOf(verdict: Verdict): Record<string, unknown> {
	const value = verdict.evidence;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`verdict evidence is not an object: ${JSON.stringify(value)}`);
	}
	return value as Record<string, unknown>;
}

function expectInconclusiveWith(verdict: Verdict, expected: Record<string, unknown>): void {
	expect(verdict.state, JSON.stringify(verdict)).toBe("inconclusive");
	const evidence = evidenceOf(verdict);
	for (const [key, value] of Object.entries(expected)) expect(evidence[key], key).toBe(value);
	expect(typeof verdict.reason).toBe("string");
	expect(verdict.reason!.length).toBeGreaterThan(0);
}

describe("script verdict parsing", () => {
	it("reads pass, fail and inconclusive with the script evidence", () => {
		for (const state of ["pass", "fail", "inconclusive"] as const) {
			expect(parseVerdict(JSON.stringify({ verdict: state, evidence: { checked: 4 } }))).toStrictEqual({
				state,
				evidence: { checked: 4 },
			});
		}
	});

	it("substitutes evidence when the script supplies none", () => {
		expect(parseVerdict('{"verdict":"pass"}')).toStrictEqual({
			state: "pass",
			evidence: { outcome: "no evidence supplied by script" },
		});
	});

	it("reports output that is not JSON as inconclusive", () => {
		expectInconclusiveWith(parseVerdict("processed 4 artifacts"), { parseError: "script output was not JSON" });
	});

	it("reports output that is not an object as inconclusive", () => {
		for (const stdout of ['"pass"', "7", "null", '[{"verdict":"pass"}]']) {
			expectInconclusiveWith(parseVerdict(stdout), { parseError: "script output was not an object" });
		}
	});

	it("reports an unknown verdict as inconclusive", () => {
		for (const stdout of ['{"verdict":"ok"}', '{"verdict":true}', '{"result":"pass"}']) {
			expectInconclusiveWith(parseVerdict(stdout), { parseError: "invalid verdict" });
		}
	});
});

describe("programmatic kernel", () => {
	it("runs the registered script with the captured object path and parses its verdict", async () => {
		const root = await temporaryRoot();
		const scriptsDirectory = join(root, "scripts");
		await mkdir(scriptsDirectory, { recursive: true });
		const scriptPath = join(scriptsDirectory, "check.js");
		await writeFile(scriptPath, "#!/usr/bin/env node\n");
		const calls: Array<{ command: string; args: string[] }> = [];
		const runner = createProgrammaticRunner(
			fakePi(async (command, args) => {
				calls.push({ command, args });
				return { ...OK_EXEC, stdout: JSON.stringify({ verdict: "pass", evidence: { ok: true } }) };
			}),
			scriptsDirectory,
		);
		expect(await runner("check", "/tmp/captured-object.md", {})).toStrictEqual({
			state: "pass",
			evidence: { ok: true },
		});
		expect(calls).toEqual([{ command: scriptPath, args: ["/tmp/captured-object.md"] }]);
	});

	it("reports an unresolvable script instead of judging the object", async () => {
		const root = await temporaryRoot();
		const scriptsDirectory = join(root, "scripts");
		await mkdir(scriptsDirectory, { recursive: true });
		let executed = false;
		const runner = createProgrammaticRunner(
			fakePi(async () => {
				executed = true;
				return { ...OK_EXEC, stdout: '{"verdict":"pass"}' };
			}),
			scriptsDirectory,
		);
		const verdict = await runner("absent-script", "/tmp/captured-object.md", {});
		expectInconclusiveWith(verdict, {});
		expect(String(evidenceOf(verdict).error)).toContain("not found in library");
		expect(executed).toBe(false);
	});

	it("reports a failing exit code, an interruption and unparsable stdout as inconclusive", async () => {
		const root = await temporaryRoot();
		const scriptsDirectory = join(root, "scripts");
		await mkdir(scriptsDirectory, { recursive: true });
		await writeFile(join(scriptsDirectory, "check.js"), "#!/usr/bin/env node\n");

		const failing = createProgrammaticRunner(
			fakePi(async () => ({ stdout: '{"verdict":"pass"}', stderr: "boom\ndetails", code: 3, killed: false })),
			scriptsDirectory,
		);
		expectInconclusiveWith(await failing("check", "/tmp/object.md", {}), { code: 3, stderr: "boom\ndetails" });

		const interrupted = createProgrammaticRunner(
			fakePi(async () => ({ stdout: "", stderr: "", code: 0, killed: true })),
			scriptsDirectory,
		);
		expectInconclusiveWith(await interrupted("check", "/tmp/object.md", {}), { error: "script interrupted" });

		const garbage = createProgrammaticRunner(
			fakePi(async () => ({ ...OK_EXEC, stdout: "looks fine to me" })),
			scriptsDirectory,
		);
		expectInconclusiveWith(await garbage("check", "/tmp/object.md", {}), { parseError: "script output was not JSON" });
	});
});

const RUN_ID = "run-1";
const GRAPH_DIGEST = "graph-digest-1";
const GOAL_ID = "leaf";
const INSTRUCTION = "judge the artifact against the declared criteria";

interface AgenticRunOverrides {
	readonly instruction?: string;
	readonly inputPath?: string;
	readonly env?: VerifierExecutionEnv;
}

interface AgenticFixture {
	readonly dogRoot: string;
	readonly inputPath: string;
	readonly instruction: string;
	readonly request: DispatchRequest;
	run(overrides?: AgenticRunOverrides): Promise<Verdict>;
}

/** One agentic judgment on disk: a captured object, its dispatch request and the runner. */
async function agenticFixture(options: { readonly instruction?: string } = {}): Promise<AgenticFixture> {
	const root = await temporaryRoot();
	const dogRoot = join(root, ".omp", "dog");
	const inputPath = join(root, "artifact.md");
	const bytes = Buffer.from("# artifact\n");
	await writeFile(inputPath, bytes);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const instruction = options.instruction ?? INSTRUCTION;
	const request = buildDispatchRequest({
		dogRoot,
		graphDigest: GRAPH_DIGEST,
		goalId: GOAL_ID,
		target: "artifact.md",
		instruction,
		inputSha256: sha256,
		captured: {
			path: "artifact.md",
			digest: `sha256:${sha256}`,
			exists: true,
			byteLength: bytes.byteLength,
			sha256,
		},
	});
	const runner = createAgenticRunner({
		dogRoot,
		graphDigestFor: (id) => (id === RUN_ID ? GRAPH_DIGEST : undefined),
	});
	return {
		dogRoot,
		inputPath,
		instruction,
		request,
		run: (overrides: AgenticRunOverrides = {}) =>
			runner(
				overrides.instruction ?? instruction,
				{ path: join(root, "workspace") },
				overrides.inputPath ?? inputPath,
				overrides.env ?? { runId: RUN_ID, goalId: GOAL_ID },
			),
	};
}

/** A settlement record answering `request`, with per-field overrides. */
function settled(request: DispatchRequest, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: "0.1",
		requestId: request.requestId,
		graphDigest: request.graphDigest,
		goalId: request.goalId,
		instructionHash: request.instructionHash,
		inputSha256: request.inputSha256,
		state: "pass",
		evidence: { checked: 4 },
		settledAt: "2026-09-17T00:00:00.000Z",
		...overrides,
	};
}

async function writeSettlement(path: string, record: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(record));
}

async function backdate(path: string, secondsAgo: number): Promise<void> {
	const when = new Date(Date.now() - secondsAgo * 1_000);
	await utimes(path, when, when);
}

describe("agentic settlement kernel", () => {
	it("accepts a settlement bound to the same bytes, instruction and dispatch", async () => {
		const fixture = await agenticFixture();
		await writeDispatchRequest(fixture.request);
		await writeSettlement(
			fixture.request.settlementPath,
			settled(fixture.request, { state: "fail", evidence: { overlaps: 2 }, reason: "two boxes overlap" }),
		);
		expect(await fixture.run()).toStrictEqual({
			state: "fail",
			evidence: { overlaps: 2 },
			reason: "two boxes overlap",
		});
	});

	it("falls back to the settlement record when the verifier supplied no evidence", async () => {
		const fixture = await agenticFixture();
		const record = settled(fixture.request, { state: "inconclusive" });
		delete record.evidence;
		record.verifierAgent = "dog-verifier";
		record.reason = "could not open the artifact";
		await writeSettlement(fixture.request.settlementPath, record);
		expect(await fixture.run()).toStrictEqual({
			state: "inconclusive",
			evidence: { outcome: "inconclusive", verifierAgent: "dog-verifier", reason: "could not open the artifact" },
			reason: "could not open the artifact",
		});
	});

	it("fails closed when no verifier has settled this judgment", async () => {
		const fixture = await agenticFixture();
		expectInconclusiveWith(await fixture.run(), { outcome: "verifier has not settled this goal" });
	});

	it("fails closed when the captured object changed after the judgment was dispatched", async () => {
		const fixture = await agenticFixture();
		await writeSettlement(fixture.request.settlementPath, settled(fixture.request));
		expect(await readSettlement(fixture.request.settlementPath)).toBeDefined();
		// Same instruction, different bytes: the judgment no longer answers this object.
		await writeFile(fixture.inputPath, "# artifact, edited\n");
		expectInconclusiveWith(await fixture.run(), { outcome: "verifier has not settled this goal" });
	});

	it("fails closed on a settlement that judged different bytes", async () => {
		const fixture = await agenticFixture();
		await writeSettlement(fixture.request.settlementPath, settled(fixture.request, { inputSha256: "d".repeat(64) }));
		expectInconclusiveWith(await fixture.run(), { outcome: "settlement judged different bytes" });
	});

	it("fails closed on a settlement that answered a different instruction", async () => {
		const fixture = await agenticFixture();
		await writeSettlement(
			fixture.request.settlementPath,
			settled(fixture.request, { instructionHash: instructionHashOf("a superseded instruction") }),
		);
		expectInconclusiveWith(await fixture.run(), { outcome: "settlement answered a different instruction" });
	});

	it("fails closed on a settlement older than its dispatch request, but not the reverse", async () => {
		const fixture = await agenticFixture();
		await writeDispatchRequest(fixture.request);
		await writeSettlement(fixture.request.settlementPath, settled(fixture.request));
		await backdate(fixture.request.settlementPath, 600);
		expectInconclusiveWith(await fixture.run(), { outcome: "settlement predates its dispatch request" });

		// Control: with the request dispatched before the settlement, the same
		// record is accepted — the gate is ordering, not blanket rejection.
		await backdate(fixture.request.requestPath, 1_200);
		expect(await fixture.run()).toStrictEqual({ state: "pass", evidence: { checked: 4 } });
	});

	it("fails closed when the judgment is not bound to a goal or a graph revision", async () => {
		const fixture = await agenticFixture();
		await writeSettlement(fixture.request.settlementPath, settled(fixture.request));
		expectInconclusiveWith(await fixture.run({ env: { runId: RUN_ID } }), {
			outcome: "agentic kernel invoked without a goal",
		});
		expectInconclusiveWith(await fixture.run({ env: { goalId: GOAL_ID } }), {
			outcome: "run is not bound to a graph revision",
		});
		expectInconclusiveWith(await fixture.run({ env: { runId: "unknown-run", goalId: GOAL_ID } }), {
			outcome: "run is not bound to a graph revision",
		});
	});

	it("fails closed when the captured object cannot be read", async () => {
		const fixture = await agenticFixture();
		await writeSettlement(fixture.request.settlementPath, settled(fixture.request));
		const verdict = await fixture.run({ inputPath: join(fixture.dogRoot, "not-captured.md") });
		expectInconclusiveWith(verdict, { outcome: "captured object is unavailable" });
	});

	it("binds the settlement to the instruction text, not to a hash of its own choosing", async () => {
		const fixture = await agenticFixture();
		await writeSettlement(fixture.request.settlementPath, settled(fixture.request));
		expect(await fixture.run()).toStrictEqual({ state: "pass", evidence: { checked: 4 } });
		// A reworded instruction is a different judgment and must be re-dispatched.
		expectInconclusiveWith(await fixture.run({ instruction: `${INSTRUCTION} (v2)` }), {
			outcome: "verifier has not settled this goal",
		});
	});

	it("binds the settlement to the graph revision that was dispatched", async () => {
		const fixture = await agenticFixture();
		await writeSettlement(fixture.request.settlementPath, settled(fixture.request));
		expect(await fixture.run()).toStrictEqual({ state: "pass", evidence: { checked: 4 } });
		const otherRevision = createAgenticRunner({
			dogRoot: fixture.dogRoot,
			graphDigestFor: () => sha256Json({ graph: "a later revision" }),
		});
		const verdict = await otherRevision(fixture.instruction, { path: fixture.dogRoot }, fixture.inputPath, {
			runId: "run-2",
			goalId: GOAL_ID,
		});
		expectInconclusiveWith(verdict, { outcome: "verifier has not settled this goal" });
	});
});
