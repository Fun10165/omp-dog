/** OMP adapter: the status line, the widget body and the `/dog` run report. */

import { describe, expect, it } from "vitest";
import type { CompiledGraph, DogRun, GoalNodeInput, VerificationRecord, VerifierShape } from "../core/model.ts";
import { panelLines, runReport, statusText } from "../omp/panel.ts";

const GRAPH_DIGEST = "d".repeat(64);

function compiledFixture(entries: ReadonlyArray<readonly [string, string, VerifierShape | undefined]>): CompiledGraph {
	const nodes: Record<string, GoalNodeInput> = {};
	for (const [id, title, verifier] of entries) {
		nodes[id] = {
			kind: "leaf",
			title,
			constraint: "hard",
			target: `${id}.md`,
			...(verifier === undefined ? {} : { verifier }),
		};
	}
	return {
		input: { schemaVersion: "0.9", id: "demo", root: entries[0]?.[0] ?? "root", nodes, contains: [], dependsOn: [] },
		graphDigest: GRAPH_DIGEST,
		acceptancePlans: {},
	};
}

function runFixture(overrides: Partial<DogRun> = {}): DogRun {
	return {
		runId: "run-1",
		graphId: "demo",
		graphDigest: GRAPH_DIGEST,
		state: "completed",
		gmDigests: {},
		goals: {},
		createdAt: "2026-09-17T00:00:00.000Z",
		updatedAt: "2026-09-17T00:05:00.000Z",
		...overrides,
	};
}

const SCRIPT: VerifierShape = { mode: "programmatic", script: "file-non-empty" };
const AGENT: VerifierShape = { mode: "agentic", instruction: "judge it" };

describe("status line", () => {
	it("is absent before the first run, and falls back to the run state without a graph", () => {
		expect(statusText(undefined, undefined)).toBeUndefined();
		expect(statusText(runFixture({ state: "running", rootState: undefined }), undefined)).toBe("dog running");
		expect(statusText(runFixture({ rootState: "needs_replan" }), undefined)).toBe("dog needs_replan");
	});

	it("shows one glyph per goal in graph order, pending for goals the run never reached", () => {
		const compiled = compiledFixture([
			["a", "alpha", SCRIPT],
			["b", "beta", AGENT],
			["c", "gamma", undefined],
		]);
		const run = runFixture({
			rootState: "needs_replan",
			goals: { a: { state: "success" }, b: { state: "needs_human" } },
		});
		expect(statusText(run, compiled)).toBe("dog needs_replan ✓?·");
		expect(statusText(runFixture({ rootState: "failure", goals: { a: { state: "failure" } } }), compiled)).toBe(
			"dog failure ✗··",
		);
	});
});

describe("widget body", () => {
	it("announces the absence of a run", () => {
		expect(panelLines({ run: undefined, compiled: undefined })).toEqual(["dog: no run yet"]);
	});

	it("summarizes the run even without a graph", () => {
		const run = runFixture({ rootState: "success", goals: { a: { state: "success" } } });
		expect(panelLines({ run, compiled: undefined })).toEqual(["dog demo · success · 1✓"]);
	});

	it("lists each goal with its verifier kind and a bounded reason", () => {
		const compiled = compiledFixture([
			["a", "alpha", SCRIPT],
			["b", "beta", AGENT],
			["c", "gamma", undefined],
		]);
		const longReason = "x".repeat(80);
		const run = runFixture({
			rootState: "needs_replan",
			goals: {
				a: { state: "success" },
				b: { state: "failure", reason: longReason },
				c: { state: "needs_human" },
			},
		});
		const lines = panelLines({ run, compiled });
		expect(lines[0]).toBe("dog demo · needs_replan · 1✓ 1✗ 1?");
		expect(lines[1]).toBe("✓ a [script] alpha");
		expect(lines[2]).toBe(`✗ b [agent] beta — ${"x".repeat(48)}`);
		expect(lines[3]).toBe("? c [composite] gamma");
		expect(lines).toHaveLength(4);
	});

	it("elides goals past the limit and truncated titles", () => {
		const compiled = compiledFixture([
			["a", "a".repeat(40), SCRIPT],
			["b", "beta", AGENT],
			["c", "gamma", AGENT],
		]);
		const run = runFixture({ rootState: "partial_success", goals: { a: { state: "running" } } });
		const lines = panelLines({ run, compiled, limit: 2 });
		expect(lines).toHaveLength(4);
		expect(lines[0]).toBe("dog demo · partial_success · 1▶");
		expect(lines[1]).toBe(`▶ a [script] ${"a".repeat(32)}`);
		expect(lines[2]).toBe("· b [agent] beta");
		expect(lines[3]).toBe("… 1 more goals");
	});
});

describe("run report", () => {
	const verification: VerificationRecord = {
		schemaVersion: "0.1",
		runId: "run-1",
		graphId: "demo",
		graphDigest: GRAPH_DIGEST,
		goalId: "a",
		judgment: { mode: "programmatic", script: "file-non-empty", scriptDigest: `sha256:${"e".repeat(64)}` },
		passed: true,
		evidence: { checked: 3 },
		at: "2026-09-17T00:02:00.000Z",
	};

	it("reports the run header and only the optional lines the run carries", () => {
		const minimal = runReport({ run: runFixture({}), compiled: undefined }).split("\n");
		expect(minimal).toStrictEqual([
			"run      run-1",
			"graph    demo @ dddddddddddd",
			"state    completed",
			"created  2026-09-17T00:00:00.000Z",
			"updated  2026-09-17T00:05:00.000Z",
			"",
		]);

		const full = runReport({
			run: runFixture({
				rootState: "needs_replan",
				workspaceBaseDir: "/tmp/ws",
				runtimeWarning: "orphaned by restart",
			}),
			compiled: undefined,
		}).split("\n");
		expect(full.slice(0, 7)).toStrictEqual([
			"run      run-1",
			"graph    demo @ dddddddddddd",
			"state    needs_replan",
			"created  2026-09-17T00:00:00.000Z",
			"updated  2026-09-17T00:05:00.000Z",
			"base     /tmp/ws",
			"warning  orphaned by restart",
		]);
	});

	it("lists every goal with its title, evidence pointers and bounded evidence", () => {
		const compiled = compiledFixture([
			["a", "alpha", SCRIPT],
			["b", "beta", AGENT],
		]);
		const run = runFixture({
			rootState: "needs_replan",
			goals: {
				a: { state: "success", verification },
				b: { state: "inherited", inheritedFrom: "run-0", reason: "reused run-0 verification record" },
				c: { state: "pending" },
			},
		});
		const lines = runReport({ run, compiled }).split("\n");
		expect(lines).toContain("✓ a  success  (alpha)");
		expect(lines).toContain('    evidence: {"checked":3}');
		expect(lines).toContain("↺ b  inherited  (beta)");
		expect(lines).toContain("    reason: reused run-0 verification record");
		expect(lines).toContain("    inherited from: run-0");
		// No node in this revision: the goal is still reported, without a title.
		expect(lines).toContain("· c  pending");

		const longEvidence = runReport({
			run: runFixture({
				goals: { a: { state: "success", verification: { ...verification, evidence: "x".repeat(400) } } },
			}),
			compiled: undefined,
		}).split("\n");
		const evidenceLine = longEvidence.find((line) => line.startsWith("    evidence: "))!;
		expect(evidenceLine).toHaveLength("    evidence: ".length + 200);
	});
});
