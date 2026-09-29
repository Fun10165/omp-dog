/** Engine semantics: compilation, capture, both kernels, composition, inheritance, cancellation. */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DogValidationError } from "../core/graph.ts";
import type { AgenticRunner, ProgrammaticRunner, Verdict } from "../core/verifiers.ts";
import {
	compositeNode,
	ensureScripts,
	graph,
	leafNode,
	makeFixture,
	recordingAgentic,
	sleep,
	stubProgrammatic,
	temporaryRoot,
} from "./helpers.ts";

const roots: string[] = [];

async function fixtureRoot(): Promise<string> {
	const root = await temporaryRoot();
	roots.push(root);
	await ensureScripts(root);
	await writeFile(join(root, "artifact.txt"), "smoke artifact\n");
	return root;
}

/** A programmatic kernel that answers per goal: `fail` for the listed goals. */
function perGoal(failing: readonly string[], otherwise: "pass" | "fail" = "pass"): ProgrammaticRunner {
	return async (_script, _inputPath, env) => ({
		state: failing.includes(env.goalId) ? "fail" : otherwise,
		evidence: { goal: env.goalId },
	});
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("engine", () => {
	it("compiles a graph and freezes each verifier target", async () => {
		const root = await fixtureRoot();
		const { engine } = await makeFixture(root);
		const compiled = await engine.create(
			graph({ root: compositeNode({ op: "all", items: [{ op: "ref", id: "leaf" }] }), leaf: leafNode() }, [
				{ parent: "root", child: "leaf", required: true, failure: "fatal" },
			]),
			{ captureBaseDir: root },
		);
		expect(compiled.graphDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(compiled.acceptancePlans.leaf?.input?.exists).toBe(true);
		expect(compiled.acceptancePlans.leaf?.input?.sha256).toMatch(/^[a-f0-9]{64}$/);
		await expect(engine.status("missing")).rejects.toThrow();
	});

	it("reports every structural error at once", async () => {
		const root = await fixtureRoot();
		const { engine } = await makeFixture(root);
		const broken = {
			schemaVersion: "0.9",
			id: "broken",
			root: "nope",
			nodes: { leaf: { kind: "leaf", title: "x", constraint: "hard", target: "artifact.txt" } },
			contains: [],
			dependsOn: [{ source: "leaf", target: "leaf" }],
		};
		const report = engine.validate(broken);
		expect(report.valid).toBe(false);
		expect(report.errors.join("\n")).toContain("leaf requires verifier");
		expect(report.errors.join("\n")).toContain("self-dependency");
		expect(report.errors.join("\n")).toContain("unknown node");
		await expect(engine.create(broken)).rejects.toBeInstanceOf(DogValidationError);
	});

	it("packages a directory target and hands the unpacked tree to the verifier", async () => {
		const root = await fixtureRoot();
		await mkdir(join(root, "bundle"));
		await writeFile(join(root, "bundle", "inside.md"), "hello\n");
		const { runner, calls } = recordingAgentic(() => ({ state: "pass", evidence: {} }));
		const fixture = await makeFixture(root, { agentic: runner });
		const compiled = await fixture.engine.create(
			graph(
				{
					root: compositeNode({ op: "all", items: [{ op: "ref", id: "leaf" }] }),
					leaf: leafNode({ target: "bundle", verifier: { mode: "agentic", goal: "is it there" } }),
				},
				[{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
			),
			{ captureBaseDir: root },
		);
		expect(compiled.acceptancePlans.leaf?.input?.packed).toBe(true);
		const run = await fixture.engine.run(compiled.input.id);
		expect(run.rootState).toBe("success");
		expect(calls[0]?.target.isDirectory).toBe(true);
		expect(calls[0]?.target.byteLength).toBe(compiled.acceptancePlans.leaf?.input?.byteLength);
	});

	it("maps the three verdicts onto goal states, root included", async () => {
		const root = await fixtureRoot();
		const failing = await makeFixture(root, { programmatic: perGoal([], "fail") });
		const failingGraph = await failing.engine.create(
			graph(
				{ root: compositeNode({ op: "all", items: [{ op: "ref", id: "leaf" }] }), leaf: leafNode() },
				[{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
				"failing",
			),
			{ captureBaseDir: root },
		);
		const failed = await failing.engine.run(failingGraph.input.id);
		expect(failed.goals.leaf?.state).toBe("failure");
		expect(failed.goals.root?.state).toBe("failure");
		expect(failed.rootState).toBe("failure");

		const inconclusive = await makeFixture(root, { programmatic: perGoal([], "pass") });
		const inconclusiveGraph = await inconclusive.engine.create(
			graph(
				{ root: compositeNode({ op: "all", items: [{ op: "ref", id: "leaf" }] }), leaf: leafNode() },
				[{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
				"inconclusive-demo",
			),
			{ captureBaseDir: root },
		);
		const settled = await inconclusive.engine.run(inconclusiveGraph.input.id);
		expect(settled.rootState).toBe("success");
	});

	it("reports needs_replan when a required relation cannot be decided", async () => {
		const root = await fixtureRoot();
		const fixture = await makeFixture(root, {
			programmatic: async () => ({ state: "inconclusive", evidence: {} }),
		});
		const compiled = await fixture.engine.create(
			graph(
				{ root: compositeNode({ op: "all", items: [{ op: "ref", id: "leaf" }] }), leaf: leafNode() },
				[{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
				"inconclusive-root",
			),
			{ captureBaseDir: root },
		);
		const run = await fixture.engine.run(compiled.input.id);
		expect(run.goals.leaf?.state).toBe("needs_human");
		expect(run.rootState).toBe("needs_replan");
	});

	it("tolerates a tolerable failure, and degrades to a substitute", async () => {
		const root = await fixtureRoot();
		const tolerated = await makeFixture(root, { programmatic: perGoal(["risky"]) });
		const toleratedGraph = await tolerated.engine.create(
			graph(
				{
					root: compositeNode({
						op: "all",
						items: [
							{ op: "ref", id: "risky" },
							{ op: "ref", id: "safe" },
						],
					}),
					risky: leafNode({ title: "risky" }),
					safe: leafNode({ title: "safe" }),
				},
				[
					{ parent: "root", child: "risky", required: true, failure: "tolerable" },
					{ parent: "root", child: "safe", required: true, failure: "fatal" },
				],
				"tolerated",
			),
			{ captureBaseDir: root },
		);
		const toleratedRun = await tolerated.engine.run(toleratedGraph.input.id);
		expect(toleratedRun.goals.risky?.state).toBe("failure");
		expect(toleratedRun.goals.root?.state).toBe("partial");
		expect(toleratedRun.rootState).toBe("failure");

		const degraded = await makeFixture(root, { programmatic: perGoal(["risky"]) });
		const degradedGraph = await degraded.engine.create(
			graph(
				{
					root: compositeNode({
						op: "all",
						items: [
							{ op: "ref", id: "risky" },
							{ op: "ref", id: "safe" },
						],
					}),
					risky: leafNode({ title: "risky" }),
					safe: leafNode({ title: "safe" }),
				},
				[
					{ parent: "root", child: "risky", required: true, failure: "degrade", degradeTo: "safe" },
					{ parent: "root", child: "safe", required: true, failure: "fatal" },
				],
				"degraded",
			),
			{ captureBaseDir: root },
		);
		const degradedRun = await degraded.engine.run(degradedGraph.input.id);
		expect(degradedRun.goals.risky?.state).toBe("failure");
		expect(degradedRun.goals.safe?.state).toBe("success");
		expect(degradedRun.goals.root?.state).toBe("success");
		expect(degradedRun.rootState).toBe("success");
	});

	it("lets a whole-object assertion demote a settled composite", async () => {
		const root = await fixtureRoot();
		const { runner, calls } = recordingAgentic((target): Verdict =>
			target.goalId === "root"
				? { state: "fail", evidence: { note: "does not hold together" } }
				: { state: "pass", evidence: {} },
		);
		const fixture = await makeFixture(root, { agentic: runner });
		const compiled = await fixture.engine.create(
			graph(
				{
					root: compositeNode(
						{ op: "all", items: [{ op: "ref", id: "leaf" }] },
						{
							verifier: { mode: "agentic", goal: "does the whole hold together" },
						},
					),
					leaf: leafNode({ verifier: { mode: "agentic", goal: "is the leaf fine" } }),
				},
				[{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
				"demoted",
			),
			{ captureBaseDir: root },
		);
		const run = await fixture.engine.run(compiled.input.id);
		expect(run.goals.leaf?.state).toBe("success");
		expect(run.goals.root?.state).toBe("failure");
		expect(run.goals.root?.reason).toContain("whole-object assertion failed");
		expect(calls.map((call) => call.target.goalId).sort()).toEqual(["leaf", "root"]);
	});

	it("skips the whole-object assertion when the subtree already failed", async () => {
		const root = await fixtureRoot();
		const { runner, calls } = recordingAgentic(() => ({ state: "pass", evidence: {} }));
		const fixture = await makeFixture(root, { agentic: runner });
		const compiled = await fixture.engine.create(
			graph(
				{
					root: compositeNode(
						{ op: "all", items: [{ op: "ref", id: "leaf" }] },
						{
							verifier: { mode: "agentic", goal: "does the whole hold together" },
						},
					),
					leaf: leafNode({ verifier: { mode: "agentic", goal: "is the leaf fine" } }),
				},
				[{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
				"skipped-assertion",
			),
			{ captureBaseDir: root },
		);
		const failing = await makeFixture(root, {
			agentic: async (_goal, _workspace, target) =>
				target.goalId === "leaf" ? { state: "fail", evidence: {} } : { state: "pass", evidence: {} },
		});
		const run = await failing.engine.run(compiled.input.id);
		expect(run.goals.root?.state).toBe("failure");
		expect(run.goals.root?.reason).toContain("leaf failed");
		expect(calls).toEqual([]);
	});

	it("inherits unchanged verdicts and re-runs when the object changes", async () => {
		const root = await fixtureRoot();
		const { runner, calls } = recordingAgentic(() => ({ state: "pass", evidence: { verdict: "pass" } }));
		const fixture = await makeFixture(root, { agentic: runner });
		const compiled = await fixture.engine.create(
			graph(
				{
					root: compositeNode({ op: "all", items: [{ op: "ref", id: "leaf" }] }),
					leaf: leafNode({ verifier: { mode: "agentic", goal: "is it there" } }),
				},
				[{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
				"inherited",
			),
			{ captureBaseDir: root },
		);
		const first = await fixture.engine.run(compiled.input.id);
		expect(first.goals.leaf?.state).toBe("success");
		const second = await fixture.engine.run(compiled.input.id);
		expect(second.goals.leaf?.state).toBe("inherited");
		expect(second.goals.leaf?.inheritedFrom).toBe(first.runId);
		expect(calls).toHaveLength(1);
		expect(second.rootState).toBe("success");

		await writeFile(join(root, "artifact.txt"), "changed artifact\n");
		const changed = await fixture.engine.create(
			graph(
				{
					root: compositeNode({ op: "all", items: [{ op: "ref", id: "leaf" }] }),
					leaf: leafNode({ verifier: { mode: "agentic", goal: "is it there" } }),
				},
				[{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
				"changed",
			),
			{ captureBaseDir: root },
		);
		const third = await fixture.engine.run(changed.input.id);
		expect(third.goals.leaf?.state).toBe("success");
		expect(calls).toHaveLength(2);
		expect(calls[1]?.target.sha256).not.toBe(calls[0]?.target.sha256);
	});

	it("holds a dependent goal until its dependency reaches a terminal state", async () => {
		const root = await fixtureRoot();
		const events: string[] = [];
		const agentic: AgenticRunner = async (_goal, _workspace, target) => {
			events.push(`start:${target.goalId}`);
			await sleep(10);
			events.push(`end:${target.goalId}`);
			return { state: "pass", evidence: {} };
		};
		const fixture = await makeFixture(root, { agentic });
		const compiled = await fixture.engine.create(
			{
				schemaVersion: "0.9",
				id: "gated",
				root: "root",
				nodes: {
					root: compositeNode({
						op: "all",
						items: [
							{ op: "ref", id: "a" },
							{ op: "ref", id: "b" },
						],
					}),
					a: leafNode({ title: "a", verifier: { mode: "agentic", goal: "judge a" } }),
					b: leafNode({ title: "b", verifier: { mode: "agentic", goal: "judge b" } }),
				},
				contains: [
					{ parent: "root", child: "a", required: true, failure: "fatal" },
					{ parent: "root", child: "b", required: true, failure: "fatal" },
				],
				dependsOn: [{ source: "b", target: "a" }],
			},
			{ captureBaseDir: root },
		);
		const run = await fixture.engine.run(compiled.input.id);
		expect(run.rootState).toBe("success");
		expect(events).toEqual(["start:a", "end:a", "start:b", "end:b"]);
	});

	it("bounds concurrent agentic verifications", async () => {
		const root = await fixtureRoot();
		let inFlight = 0;
		let peak = 0;
		const agentic: AgenticRunner = async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await sleep(15);
			inFlight -= 1;
			return { state: "pass", evidence: {} };
		};
		const fixture = await makeFixture(root, { agentic, concurrency: 2 });
		const compiled = await fixture.engine.create(
			graph(
				{
					root: compositeNode({
						op: "all",
						items: [
							{ op: "ref", id: "a" },
							{ op: "ref", id: "b" },
							{ op: "ref", id: "c" },
						],
					}),
					a: leafNode({ title: "a", verifier: { mode: "agentic", goal: "judge" } }),
					b: leafNode({ title: "b", verifier: { mode: "agentic", goal: "judge" } }),
					c: leafNode({ title: "c", verifier: { mode: "agentic", goal: "judge" } }),
				},
				[
					{ parent: "root", child: "a", required: true, failure: "fatal" },
					{ parent: "root", child: "b", required: true, failure: "fatal" },
					{ parent: "root", child: "c", required: true, failure: "fatal" },
				],
				"budget",
			),
			{ captureBaseDir: root },
		);
		const run = await fixture.engine.run(compiled.input.id);
		expect(run.rootState).toBe("success");
		expect(peak).toBe(2);
	});

	it("freezes both background tiers and folds them into the judgment identity", async () => {
		const root = await fixtureRoot();
		const generalPath = join(root, "general.md");
		const specificPath = join(root, "specific.md");
		await writeFile(generalPath, "# DoG\n\nDoG turns a non-formal goal into verified subgoals.\n");
		await writeFile(specificPath, "# This submission\n\nWe are judging the graph that gates report.md.\n");
		const { runner, calls } = recordingAgentic(() => ({ state: "pass", evidence: {} }));
		const fixture = await makeFixture(root, { agentic: runner });
		const withBackground = (id: string): Record<string, unknown> => ({
			...graph(
				{
					root: compositeNode({ op: "all", items: [{ op: "ref", id: "leaf" }] }),
					leaf: leafNode({ verifier: { mode: "agentic", goal: "judge the object" } }),
				},
				[{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
				id,
			),
			background: { general: "general.md", specific: "specific.md" },
		});

		const compiled = await fixture.engine.create(withBackground("with-background"), { captureBaseDir: root });
		expect(compiled.background?.general?.text).toContain("DoG turns a non-formal goal");
		expect(compiled.background?.specific?.text).toContain("We are judging the graph");
		expect(compiled.background?.general?.sha256).toMatch(/^[a-f0-9]{64}$/);

		const first = await fixture.engine.run(compiled.input.id);
		expect(first.goals.leaf?.state).toBe("success");
		expect(calls[0]?.target.background?.general).toContain("DoG turns a non-formal goal");
		expect(calls[0]?.target.background?.specific).toContain("We are judging the graph");

		// Same goal, same background: nothing to judge again.
		const second = await fixture.engine.run(compiled.input.id);
		expect(second.goals.leaf?.state).toBe("inherited");
		expect(calls).toHaveLength(1);

		// Either tier is part of the standard: editing the per-submission half re-judges too.
		await writeFile(specificPath, "# This submission\n\nWe are now judging something else.\n");
		const recompiled = await fixture.engine.create(withBackground("with-background"), { captureBaseDir: root });
		const third = await fixture.engine.run(recompiled.input.id);
		expect(third.goals.leaf?.state).toBe("success");
		expect(calls).toHaveLength(2);

		// A named background that is not there is a configuration error, not a silent drop.
		await expect(
			fixture.engine.create(
				{ ...withBackground("with-background"), background: { general: "absent.md" } },
				{ captureBaseDir: root },
			),
		).rejects.toThrow(/background file not found/);
		// Naming neither tier is a malformed background, not "no background".
		await expect(
			fixture.engine.create({ ...withBackground("with-background"), background: {} }, { captureBaseDir: root }),
		).rejects.toThrow(/must name general, specific, or both/);
	});

	it("cancels every unsettled goal and the run when the signal aborts", async () => {
		const root = await fixtureRoot();
		const fixture = await makeFixture(root, { programmatic: stubProgrammatic() });
		const compiled = await fixture.engine.create(
			graph(
				{ root: compositeNode({ op: "all", items: [{ op: "ref", id: "leaf" }] }), leaf: leafNode() },
				[{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
				"cancelled",
			),
			{ captureBaseDir: root },
		);
		const controller = new AbortController();
		controller.abort();
		const run = await fixture.engine.run(compiled.input.id, { signal: controller.signal });
		expect(run.state).toBe("cancelled");
		expect(run.rootState).toBe("cancelled");
		expect(run.goals.leaf?.state).toBe("cancelled");
		expect(run.goals.root?.state).toBe("cancelled");
	});
});
