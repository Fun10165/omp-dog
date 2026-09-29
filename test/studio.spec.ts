/** The studio's bridge: what the canvas means, and what a save must refuse. */

import { describe, expect, it } from "vitest";
import { parseGraph } from "../core/graph.ts";
import type { GraphLimits } from "../core/model.ts";
import { autoLayout, CanvasError, DERIVED, fromCanvas, layoutOf, toCanvas, type Canvas } from "../studio/dogflow.ts";

const LIMITS: GraphLimits = { maxGraphNodes: 256, maxExpressionNodes: 512, maxExpressionDepth: 64 };

/** A small valid graph: root composite over two leaves, one dependency. */
function sample(): Record<string, unknown> {
	return {
		schemaVersion: "0.9",
		id: "demo",
		root: "root",
		$schema: "../schema/dog-graph.schema.json",
		background: { general: "general.md", specific: "specific.md" },
		nodes: {
			root: {
				kind: "composite",
				title: "根",
				constraint: "hard",
				target: "report.md",
				completion: {
					op: "all",
					items: [
						{ op: "ref", id: "a" },
						{ op: "ref", id: "b" },
					],
				},
			},
			a: {
				kind: "leaf",
				title: "甲",
				constraint: "hard",
				target: "report.md",
				verifier: { mode: "agentic", goal: "看甲" },
			},
			b: {
				kind: "leaf",
				title: "乙",
				constraint: "hard",
				target: "report.md",
				verifier: { mode: "agentic", goal: "看乙" },
			},
		},
		contains: [
			{ parent: "root", child: "a", required: true, failure: "fatal" },
			{ parent: "root", child: "b", required: false, failure: "tolerable" },
		],
		dependsOn: [{ source: "b", target: "a", data: ["甲的结果"] }],
	};
}

describe("the canvas bridge", () => {
	it("round-trips a document through the canvas unchanged", () => {
		const original = sample();
		const canvas = toCanvas(original, {});
		expect(fromCanvas(canvas)).toEqual(original);
	});

	it("derives a composite's completion from its children in canvas order", () => {
		const canvas = toCanvas(sample(), {});
		const reordered: Canvas = {
			...canvas,
			nodes: [canvas.nodes[0]!, canvas.nodes[2]!, canvas.nodes[1]!],
		};
		const document = fromCanvas(reordered);
		expect(document.nodes).toMatchObject({
			root: {
				completion: {
					op: "all",
					items: [
						{ op: "ref", id: "b" },
						{ op: "ref", id: "a" },
					],
				},
			},
		});
		expect(parseGraph(document, LIMITS).root).toBe("root");
	});

	it("keeps an explicit completion override verbatim", () => {
		const canvas = toCanvas(sample(), {});
		const explicit: Canvas = {
			...canvas,
			nodes: canvas.nodes.map((node) =>
				node.id === "root"
					? {
							...node,
							completion: JSON.stringify({
								op: "any",
								items: [
									{ op: "ref", id: "a" },
									{ op: "ref", id: "b" },
								],
							}),
						}
					: node,
			),
		};
		expect(fromCanvas(explicit).nodes).toMatchObject({
			root: {
				completion: {
					op: "any",
					items: [
						{ op: "ref", id: "a" },
						{ op: "ref", id: "b" },
					],
				},
			},
		});
	});

	it("reports a composite with no children instead of writing an empty expression", () => {
		const canvas = toCanvas(sample(), {});
		const orphaned: Canvas = { ...canvas, edges: canvas.edges.filter((edge) => edge.to !== "a" && edge.to !== "b") };
		expect(() => fromCanvas(orphaned)).toThrow(CanvasError);
		expect(() => fromCanvas(orphaned)).toThrow(/没有任何子节点/u);
	});

	it("refuses two parents for one node, and an ambiguous root", () => {
		const canvas = toCanvas(sample(), {});
		const twoParents: Canvas = { ...canvas, edges: [...canvas.edges, { from: "a", to: "b", relation: "contains" }] };
		expect(() => fromCanvas(twoParents)).toThrow(/两个父节点/u);
		const noRoot: Canvas = {
			...canvas,
			edges: canvas.edges.map((edge) => ({ ...edge, relation: "depends" as const })),
		};
		expect(() => fromCanvas(noRoot)).toThrow(/根节点必须恰好一个/u);
	});

	it("carries a dependency's data across a save", () => {
		const document = fromCanvas(toCanvas(sample(), {}));
		expect(document.dependsOn).toEqual([{ source: "b", target: "a", data: ["甲的结果"] }]);
	});

	it("round-trips a git target in its compact spelling", () => {
		const original = sample();
		original.nodes = {
			...(original.nodes as Record<string, unknown>),
			a: {
				kind: "leaf",
				title: "甲",
				constraint: "hard",
				target: { kind: "git", ref: "HEAD", path: "docs" },
				verifier: { mode: "agentic", goal: "看甲" },
			},
		};
		const canvas = toCanvas(original, {});
		expect(canvas.nodes.find((node) => node.id === "a")).toMatchObject({ targetkind: "git", target: "HEAD:docs" });
		expect(fromCanvas(canvas)).toEqual(original);
	});

	it("lays out containment depth across and siblings down, deterministically", () => {
		const canvas = toCanvas(sample(), {});
		const first = autoLayout(canvas);
		expect(autoLayout(canvas)).toEqual(first);
		expect(first.root?.x).toBeLessThan(first.a?.x ?? 0);
		expect(first.a?.x).toBe(first.b?.x);
		expect(first.a?.y).not.toBe(first.b?.y);
		expect(layoutOf(toCanvas(sample(), first))).toEqual({
			root: { x: first.root?.x, y: first.root?.y },
			a: { x: first.a?.x, y: first.a?.y },
			b: { x: first.b?.x, y: first.b?.y },
		});
	});

	it("keeps a save byte-identical when nothing changed", () => {
		const document = sample();
		const text = `${JSON.stringify(document, null, "\t")}\n`;
		expect(`${JSON.stringify(fromCanvas(toCanvas(document)), null, "\t")}\n`).toBe(text);
	});

	it("writes node fields in the corpus order, completion before verifier", () => {
		const canvas = toCanvas(sample(), {});
		const withAssertion: Canvas = {
			...canvas,
			nodes: canvas.nodes.map((node) => (node.id === "root" ? { ...node, goal: "整体断言" } : node)),
		};
		const written = fromCanvas(withAssertion).nodes as Record<string, Record<string, unknown>>;
		expect(Object.keys(written.root ?? {})).toEqual([
			"kind",
			"title",
			"constraint",
			"target",
			"completion",
			"verifier",
		]);
	});

	it("accepts editor metadata at the root and keeps it out of the parsed graph", () => {
		const original = sample();
		const parsed = parseGraph(original, LIMITS);
		expect(parsed.id).toBe("demo");
		expect(Object.keys(parsed)).not.toContain("$schema");
	});

	it("keeps the author's node order and appends new nodes", () => {
		const canvas = toCanvas(sample(), {});
		const withNew: Canvas = {
			...canvas,
			nodes: [...canvas.nodes, { ...canvas.nodes[1]!, id: "c", title: "丙" }],
			edges: [...canvas.edges, { from: "root", to: "c", relation: "contains" as const }],
		};
		expect(Object.keys(fromCanvas(withNew).nodes as Record<string, unknown>)).toEqual(["root", "a", "b", "c"]);
	});

	it("derives nothing for a leaf, and refuses an empty target", () => {
		const canvas = toCanvas(sample(), {});
		const broken: Canvas = {
			...canvas,
			nodes: canvas.nodes.map((node) => (node.id === "a" ? { ...node, target: "  " } : node)),
		};
		expect(() => fromCanvas(broken)).toThrow(/目标（target）为空/u);
		expect(DERIVED).toBe("");
	});
});
