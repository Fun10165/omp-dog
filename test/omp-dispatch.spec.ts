/** OMP adapter: pre-flight dispatch planning, and freezing a capture for the verifier. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { DogEngine } from "../core/engine.ts";
import { sha256Json } from "../core/json.ts";
import type {
	AcceptancePlan,
	CapturedInput,
	CompiledGraph,
	DogRun,
	GoalNodeInput,
	VerificationRecord,
} from "../core/model.ts";
import { DogRepository } from "../core/storage.ts";
import { dogRootFor } from "../omp/config.ts";
import { materializeObject, planDispatch } from "../omp/dispatch.ts";
import { buildDispatchRequest, dispatchDirectory, instructionHashOf, type DispatchRequest } from "../omp/settlement.ts";
import { compositeNode, graph as graphFixture, leafNode, mkConfig, stubAgentic, temporaryRoot } from "./helpers.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryFixtureRoot(): Promise<string> {
	const path = await temporaryRoot();
	temporaryRoots.push(path);
	return path;
}

const GRAPH_DIGEST = "graph-digest-1";
const GOAL_ID = "leaf";
const INSTRUCTION = "judge the artifact against the declared criteria";

type ExecFunction = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

function fakePi(exec: ExecFunction): ExtensionAPI {
	return { exec } as unknown as ExtensionAPI;
}

/** Delegate to the real `tar` so extraction is exercised, not stubbed. */
const spawnRealTar: ExecFunction = async (command, args, options) => {
	try {
		const stdout = execFileSync(command, args, { cwd: options?.cwd });
		return { stdout: stdout.toString(), stderr: "", code: 0, killed: false };
	} catch (error) {
		const failure = error as { status?: number; stderr?: Buffer };
		return {
			stdout: "",
			stderr: failure.stderr?.toString() ?? String(error),
			code: failure.status ?? 1,
			killed: false,
		};
	}
};

function capturedObject(path: string, content: string): CapturedInput {
	const sha256 = createHash("sha256").update(content).digest("hex");
	return { path, digest: `sha256:${sha256}`, exists: true, byteLength: Buffer.byteLength(content), sha256 };
}

function nodeFixture(id: string, plan: AcceptancePlan): GoalNodeInput {
	return { kind: "leaf", title: `title for ${id}`, constraint: "hard", target: plan.target, verifier: plan.verifier };
}

function compiledFixture(plans: Record<string, AcceptancePlan>): CompiledGraph {
	const nodes: Record<string, GoalNodeInput> = {};
	for (const [goalId, plan] of Object.entries(plans)) nodes[goalId] = nodeFixture(goalId, plan);
	return {
		input: { schemaVersion: "0.9", id: "demo", root: GOAL_ID, nodes, contains: [], dependsOn: [] },
		graphDigest: GRAPH_DIGEST,
		acceptancePlans: plans,
	};
}

function agenticPlan(
	goalId: string,
	options: { readonly instruction?: string; readonly input?: CapturedInput } = {},
): AcceptancePlan {
	const instruction = options.instruction ?? `judge ${goalId}`;
	return {
		goalId,
		verifier: { mode: "agentic", instruction },
		judgment: { mode: "agentic", instructionHash: instructionHashOf(instruction) },
		target: `${goalId}.md`,
		...(options.input === undefined ? {} : { input: options.input }),
	};
}

function programmaticPlan(goalId: string): AcceptancePlan {
	return {
		goalId,
		verifier: { mode: "programmatic", script: "file-non-empty" },
		judgment: { mode: "programmatic", script: "file-non-empty", scriptDigest: `sha256:${"e".repeat(64)}` },
		target: `${goalId}.md`,
		input: capturedObject(`${goalId}.md`, "programmatically judged\n"),
	};
}

function runFixture(overrides: Partial<DogRun> = {}): DogRun {
	return {
		runId: "run-0",
		graphId: "demo",
		graphDigest: GRAPH_DIGEST,
		state: "completed",
		gmDigests: {},
		goals: {},
		createdAt: "2026-09-16T00:00:00.000Z",
		updatedAt: "2026-09-16T00:00:00.000Z",
		...overrides,
	};
}

function requestFor(plan: AcceptancePlan, dogRoot: string): DispatchRequest {
	if (plan.verifier.mode !== "agentic") throw new Error(`plan ${plan.goalId} is not agentic`);
	if (plan.input === undefined) throw new Error(`plan ${plan.goalId} captured nothing`);
	return buildDispatchRequest({
		dogRoot,
		graphDigest: GRAPH_DIGEST,
		goalId: plan.goalId,
		target: plan.target,
		instruction: plan.verifier.instruction,
		inputSha256: plan.input.sha256,
		captured: plan.input,
	});
}

async function writeSettlement(path: string, record: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(record));
}

describe("dispatch planning", () => {
	it("requires a dispatch for a captured agentic goal and reports nothing else", async () => {
		const root = await temporaryFixtureRoot();
		const dogRoot = dogRootFor(root);
		const plan = agenticPlan(GOAL_ID, { input: capturedObject("leaf.md", "# artifact\n") });
		const compiled = compiledFixture({ [GOAL_ID]: plan });
		const dispatch = await planDispatch({ compiled, dogRoot, priorRun: undefined });

		expect(dispatch.deferred).toEqual([]);
		expect(dispatch.inherited).toEqual([]);
		expect(dispatch.required).toHaveLength(1);
		const request = dispatch.required[0]!;
		expect(request.goalId).toBe(GOAL_ID);
		expect(request.target).toBe("leaf.md");
		expect(request.instruction).toBe(plan.verifier.mode === "agentic" ? plan.verifier.instruction : "");
		// The verifier judges the captured bytes, never the live tree.
		expect(request.captured).toEqual(plan.input);
		expect(request.inputSha256).toBe(plan.input!.sha256);
		expect(request.requestId).toBe(
			sha256Json({
				graphDigest: GRAPH_DIGEST,
				goalId: GOAL_ID,
				instructionHash: instructionHashOf(plan.verifier.mode === "agentic" ? plan.verifier.instruction : ""),
				inputSha256: plan.input!.sha256,
			}),
		);
		// No settlement exists yet, so nothing is recorded as already judged.
		expect(dispatch.required.map((goal) => goal.settlementPath)).toEqual([request.settlementPath]);
	});

	it("defers agentic goals with no captured object and skips programmatic ones", async () => {
		const root = await temporaryFixtureRoot();
		const dogRoot = dogRootFor(root);
		const compiled = compiledFixture({
			absent: agenticPlan("absent"),
			missing: agenticPlan("missing", {
				input: { path: "missing.md", digest: "missing:deadbeef", exists: false, byteLength: 0, sha256: "" },
			}),
			scripted: programmaticPlan("scripted"),
		});
		const dispatch = await planDispatch({ compiled, dogRoot, priorRun: undefined });
		expect(dispatch.required).toEqual([]);
		expect(dispatch.inherited).toEqual([]);
		expect(dispatch.deferred.map((goal) => goal.goalId)).toEqual(["absent", "missing"]);
		expect(dispatch.deferred.map((goal) => goal.target)).toEqual(["absent.md", "missing.md"]);
		for (const goal of dispatch.deferred) expect(goal.reason).toContain("nothing to judge");
	});

	it("does not re-dispatch a goal whose settlement already answers the same bytes and instruction", async () => {
		const root = await temporaryFixtureRoot();
		const dogRoot = dogRootFor(root);
		const plan = agenticPlan(GOAL_ID, { input: capturedObject("leaf.md", "# artifact\n") });
		const compiled = compiledFixture({ [GOAL_ID]: plan });
		const request = requestFor(plan, dogRoot);
		await writeSettlement(request.settlementPath, {
			state: "pass",
			requestId: request.requestId,
			goalId: GOAL_ID,
			instructionHash: request.instructionHash,
			inputSha256: request.inputSha256,
		});
		expect((await planDispatch({ compiled, dogRoot, priorRun: undefined })).required).toEqual([]);

		// A settlement that judged different bytes is not an answer to this judgment.
		await writeSettlement(request.settlementPath, {
			state: "pass",
			requestId: request.requestId,
			goalId: GOAL_ID,
			instructionHash: request.instructionHash,
			inputSha256: "f".repeat(64),
		});
		expect(
			(await planDispatch({ compiled, dogRoot, priorRun: undefined })).required.map((goal) => goal.goalId),
		).toEqual([GOAL_ID]);
	});

	it("inherits a goal the prior run anchored to the same object and judgment", async () => {
		const root = await temporaryFixtureRoot();
		const dogRoot = dogRootFor(root);
		const input = capturedObject("leaf.md", "# artifact\n");
		const plan = agenticPlan(GOAL_ID, { input });
		const compiled = compiledFixture({ [GOAL_ID]: plan });
		const verification: VerificationRecord = {
			schemaVersion: "0.1",
			runId: "run-0",
			graphId: "demo",
			graphDigest: GRAPH_DIGEST,
			goalId: GOAL_ID,
			judgment: plan.judgment,
			passed: true,
			at: "2026-09-16T00:00:00.000Z",
		};
		const anchor = sha256Json({ object: input.digest, judgment: plan.judgment });

		const anchored = runFixture({
			gmDigests: { [GOAL_ID]: anchor },
			goals: { [GOAL_ID]: { state: "success", verification } },
		});
		const inherited = await planDispatch({ compiled, dogRoot, priorRun: anchored });
		expect(inherited.inherited).toEqual([GOAL_ID]);
		expect(inherited.required).toEqual([]);
		expect(inherited.deferred).toEqual([]);

		// The same anchor without a recorded verdict proves nothing: re-judge.
		const unproven = runFixture({ gmDigests: { [GOAL_ID]: anchor }, goals: { [GOAL_ID]: { state: "running" } } });
		expect((await planDispatch({ compiled, dogRoot, priorRun: unproven })).required.map((goal) => goal.goalId)).toEqual(
			[GOAL_ID],
		);

		// A different anchor means the object or the judgment changed.
		const diverged = runFixture({
			gmDigests: { [GOAL_ID]: sha256Json({ object: `sha256:${"9".repeat(64)}`, judgment: plan.judgment }) },
			goals: { [GOAL_ID]: { state: "success", verification } },
		});
		expect((await planDispatch({ compiled, dogRoot, priorRun: diverged })).required.map((goal) => goal.goalId)).toEqual(
			[GOAL_ID],
		);
	});

	it("mirrors the anchor the engine itself records for a settled run", async () => {
		const root = await temporaryFixtureRoot();
		await writeFile(join(root, "artifact.md"), "# verified by the dispatched verifier\n");
		const dogRoot = dogRootFor(root);
		const repository = new DogRepository(dogRoot);
		await repository.initialize();
		const engine = new DogEngine({
			config: mkConfig(root, join(root, "scripts")),
			repository,
			now: () => new Date("2026-09-17T00:00:00.000Z"),
			nextRunId: () => "run-1",
		});
		engine.setKernels(undefined, stubAgentic("pass"));
		const compiled = await engine.create(
			graphFixture(
				{
					root: compositeNode({ op: "ref", id: GOAL_ID }, { target: "artifact.md" }),
					[GOAL_ID]: leafNode({ target: "artifact.md", verifier: { mode: "agentic", instruction: INSTRUCTION } }),
				},
				[{ parent: "root", child: GOAL_ID, required: true, failure: "fatal" }],
				"demo",
			),
			{ captureBaseDir: root },
		);
		const run = await engine.run(compiled.input.id);
		expect(run.rootState).toBe("success");
		expect(run.goals[GOAL_ID]?.verification).toBeDefined();

		const priorRun = await repository.loadRun(run.runId);
		const dispatch = await planDispatch({ compiled, dogRoot, priorRun });
		expect(dispatch.inherited).toEqual([GOAL_ID]);
		expect(dispatch.required).toEqual([]);
	});
});

describe("materializing a captured object", () => {
	it("writes a file capture back byte-for-byte instead of handing over the live tree", async () => {
		const root = await temporaryFixtureRoot();
		const dogRoot = dogRootFor(root);
		const repository = new DogRepository(dogRoot);
		await repository.initialize();
		const captured = Buffer.from("# captured artifact\n");
		const sha256 = createHash("sha256").update(captured).digest("hex");
		const input: CapturedInput = {
			path: "nested/artifact.md",
			digest: `sha256:${sha256}`,
			exists: true,
			byteLength: captured.byteLength,
			sha256,
		};
		await repository.putSandboxFile(input, captured);
		// The live tree moves on after the capture; the verifier must not see this.
		await mkdir(join(root, "nested"), { recursive: true });
		await writeFile(join(root, "nested", "artifact.md"), "# live tree, edited after capture\n");

		const commands: string[] = [];
		const request = buildDispatchRequest({
			dogRoot,
			graphDigest: GRAPH_DIGEST,
			goalId: GOAL_ID,
			target: "nested/artifact.md",
			instruction: INSTRUCTION,
			inputSha256: sha256,
			captured: input,
		});
		const object = await materializeObject({
			repository,
			pi: fakePi(async (command) => {
				commands.push(command);
				return { stdout: "", stderr: "", code: 0, killed: false };
			}),
			request,
			cwd: root,
		});
		expect(object).toStrictEqual({
			path: join(dispatchDirectory(dogRoot), request.requestId, "object", "nested", "artifact.md"),
			kind: "file",
		});
		expect(await readFile(object!.path, "utf8")).toBe("# captured artifact\n");
		expect(commands).toEqual([]);
	});

	it("extracts a packed capture so the verifier reads exactly the captured tree", async () => {
		const fixture = await packedFixture();
		const object = await materializeObject({
			repository: fixture.repository,
			pi: fakePi(spawnRealTar),
			request: fixture.request,
			cwd: fixture.cwd,
		});
		expect(object).toStrictEqual({
			path: join(dispatchDirectory(dogRootFor(fixture.cwd)), fixture.request.requestId, "object", "reports"),
			kind: "directory",
		});
		expect(await readFile(join(object!.path, "summary.md"), "utf8")).toBe("# captured summary\n");
		expect(await readFile(join(object!.path, "nested.txt"), "utf8")).toBe("captured nested\n");
	});

	it("reports no frozen object when extraction fails", async () => {
		const fixture = await packedFixture();
		const object = await materializeObject({
			repository: fixture.repository,
			pi: fakePi(async () => ({ stdout: "", stderr: "tar: broken archive", code: 2, killed: false })),
			request: fixture.request,
			cwd: fixture.cwd,
		});
		expect(object).toBeUndefined();
	});
});

interface PackedFixture {
	readonly request: DispatchRequest;
	readonly repository: DogRepository;
	readonly cwd: string;
}

/** One packed capture: a `.tar` of `reports/` held by the repository, with the live tree diverged. */
async function packedFixture(): Promise<PackedFixture> {
	const root = await temporaryFixtureRoot();
	const source = join(root, "source");
	await mkdir(join(source, "reports"), { recursive: true });
	await writeFile(join(source, "reports", "summary.md"), "# captured summary\n");
	await writeFile(join(source, "reports", "nested.txt"), "captured nested\n");
	const archive = execFileSync("tar", ["-C", source, "-cf", "-", "reports"]);
	const sha256 = createHash("sha256").update(archive).digest("hex");
	const input: CapturedInput = {
		path: "reports",
		digest: `sha256:${sha256}`,
		exists: true,
		byteLength: archive.byteLength,
		sha256,
		packed: true,
	};
	const dogRoot = dogRootFor(root);
	const repository = new DogRepository(dogRoot);
	await repository.initialize();
	await repository.putSandboxFile(input, archive);
	// Diverged after capture, like the file case.
	await writeFile(join(source, "reports", "summary.md"), "# edited after capture\n");
	const request = buildDispatchRequest({
		dogRoot,
		graphDigest: GRAPH_DIGEST,
		goalId: GOAL_ID,
		target: "reports",
		instruction: INSTRUCTION,
		inputSha256: sha256,
		captured: input,
	});
	return { request, repository, cwd: root };
}
