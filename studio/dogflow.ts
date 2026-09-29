/**
 * The bridge between a DoG graph document and the studio canvas.
 *
 * Pure functions: no Drawflow, no DOM, no file system. `toCanvas` turns a graph
 * into the nodes and edges the page draws; `fromCanvas` turns an edited canvas
 * back into a document, carrying over what the canvas does not model (the root
 * `$schema`, the two background tiers, a dependency edge's `data`, and the
 * author's own node order for the nodes that already existed).
 *
 * Two relations are drawn as wires:
 *   - a wire out of the 包含 port is containment (`parent -> child`);
 *   - a wire out of the 依赖 port is a dependency (`source -> target`).
 *
 * A composite's completion expression is *derived* from its children in canvas
 * order (top to bottom) unless the node carries an explicit override. The
 * derivation is what keeps the structure and the expression from drifting; the
 * override is the escape hatch for `any` / `not` / `atLeast` shapes.
 *
 * Canvas field names are exactly the `df-*` attribute names the page binds, so
 * there is no second naming layer to keep in sync.
 */

import { isRecord } from "../core/model.ts";

export const CONTAINS = "contains";
export const DEPENDS = "depends";

/** An empty completion means "derive `all(children)` from the canvas". */
export const DERIVED = "";

export type Relation = typeof CONTAINS | typeof DEPENDS;
export type Kind = "leaf" | "composite";
export type Failure = "fatal" | "tolerable" | "degrade";

export interface CanvasNode {
	readonly id: string;
	readonly kind: Kind;
	readonly title: string;
	readonly constraint: "hard" | "soft";
	readonly targetkind: "path" | "git";
	/** A workspace path, or `ref` / `ref:subpath` when `targetkind` is `git`. */
	readonly target: string;
	readonly verifiermode: "agentic" | "programmatic";
	readonly goal: string;
	readonly script: string;
	readonly required: boolean;
	readonly failure: Failure;
	readonly degradeto: string;
	/** Raw JSON of an explicit expression, or `DERIVED` to derive it. */
	readonly completion: string;
	readonly x: number;
	readonly y: number;
}

export interface CanvasEdge {
	readonly from: string;
	readonly to: string;
	readonly relation: Relation;
}

export interface CanvasMeta {
	readonly schemaVersion: string;
	readonly graphId: string;
	readonly root: string;
	readonly schema?: string;
	readonly background?: Record<string, unknown>;
	/** The document's own `nodes` key order, so a save does not reshuffle it. */
	readonly nodeOrder: readonly string[];
	/** `source\0target` -> the dependency edge's `data`, which the canvas cannot edit. */
	readonly dependencyData: Readonly<Record<string, unknown>>;
}

export interface Canvas {
	readonly nodes: readonly CanvasNode[];
	readonly edges: readonly CanvasEdge[];
	readonly meta: CanvasMeta;
}

export type Layout = Readonly<Record<string, { readonly x: number; readonly y: number }>>;

export type Document = Record<string, unknown>;

/** What the author must fix on the canvas; the engine judges the rest. */
export class CanvasError extends Error {
	readonly problems: readonly string[];

	constructor(problems: readonly string[]) {
		super(problems.join("\n"));
		this.name = "CanvasError";
		this.problems = problems;
	}
}

/** Missing text as the empty string, so every field reads the same way. */
function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function edgesOf(document: Document, field: "contains" | "dependsOn"): Array<Record<string, unknown>> {
	const list = document[field];
	return Array.isArray(list) ? list.filter(isRecord) : [];
}

function childrenOf(document: Document, parent: string): string[] {
	return edgesOf(document, "contains")
		.filter((edge) => edge.parent === parent)
		.map((edge) => String(edge.child));
}

/** `all(ref …)` when the expression is exactly that; undefined for any other shape. */
function plainAllRefs(completion: unknown): string[] | undefined {
	if (!isRecord(completion) || completion.op !== "all" || !Array.isArray(completion.items)) return undefined;
	const refs: string[] = [];
	for (const item of completion.items) {
		if (!isRecord(item) || item.op !== "ref" || typeof item.id !== "string") return undefined;
		refs.push(item.id);
	}
	return refs;
}

function sameRefs(left: readonly string[], right: readonly string[]): boolean {
	const seen = new Set(left);
	return seen.size === left.length && seen.size === right.length && right.every((id) => seen.has(id));
}

/** A target as the two fields the canvas edits. */
export function targetFields(target: unknown): { kind: "path" | "git"; value: string } {
	if (typeof target === "string") return { kind: "path", value: target };
	if (!isRecord(target)) return { kind: "path", value: "" };
	if (target.kind === "git") {
		const ref = text(target.ref);
		const subpath = text(target.path);
		return { kind: "git", value: subpath.length === 0 ? ref : `${ref}:${subpath}` };
	}
	return { kind: "path", value: text(target.path) };
}

/** The inverse: the two editable fields as the document's own spelling. */
export function targetValue(kind: "path" | "git", value: string): unknown {
	const trimmed = value.trim();
	if (kind !== "git") return trimmed;
	const separator = trimmed.indexOf(":");
	if (separator < 0) return { kind: "git", ref: trimmed };
	return { kind: "git", ref: trimmed.slice(0, separator), path: trimmed.slice(separator + 1) };
}

/** A graph document as canvas nodes and edges. `layout` supplies saved positions. */
export function toCanvas(document: Document, layout: Layout = {}): Canvas {
	const raw = isRecord(document.nodes) ? document.nodes : {};
	const containment = edgesOf(document, "contains");
	const nodes: CanvasNode[] = Object.keys(raw).map((id) => {
		const node = isRecord(raw[id]) ? raw[id] : {};
		const verifier = isRecord(node.verifier) ? node.verifier : {};
		const programmatic = verifier.mode === "programmatic";
		const edge = containment.find((candidate) => candidate.child === id);
		const target = targetFields(node.target);
		const position = layout[id];
		const refs = plainAllRefs(node.completion);
		const kind: Kind = node.kind === "composite" ? "composite" : "leaf";
		const derives =
			kind === "composite" &&
			(node.completion === undefined || (refs !== undefined && sameRefs(refs, childrenOf(document, id))));
		return {
			id,
			kind,
			title: text(node.title),
			constraint: node.constraint === "soft" ? "soft" : "hard",
			targetkind: target.kind,
			target: target.value,
			verifiermode: programmatic ? "programmatic" : "agentic",
			goal: programmatic ? "" : text(verifier.goal),
			script: programmatic ? text(verifier.script) : "",
			required: edge?.required !== false,
			failure: edge?.failure === "tolerable" || edge?.failure === "degrade" ? edge.failure : "fatal",
			degradeto: text(edge?.degradeTo),
			completion: derives ? DERIVED : JSON.stringify(node.completion),
			x: typeof position?.x === "number" ? position.x : 0,
			y: typeof position?.y === "number" ? position.y : 0,
		};
	});
	const edges: CanvasEdge[] = [
		...containment.map((edge) => ({
			from: String(edge.parent),
			to: String(edge.child),
			relation: CONTAINS as Relation,
		})),
		...edgesOf(document, "dependsOn").map((edge) => ({
			from: String(edge.source),
			to: String(edge.target),
			relation: DEPENDS as Relation,
		})),
	];
	const dependencyData: Record<string, unknown> = {};
	for (const edge of edgesOf(document, "dependsOn")) {
		if (edge.data !== undefined) dependencyData[`${String(edge.source)}\u0000${String(edge.target)}`] = edge.data;
	}
	return {
		nodes,
		edges,
		meta: {
			schemaVersion: text(document.schemaVersion) || "0.9",
			graphId: text(document.id),
			root: text(document.root),
			...(typeof document.$schema === "string" ? { schema: document.$schema } : {}),
			...(isRecord(document.background) ? { background: document.background } : {}),
			nodeOrder: Object.keys(raw),
			dependencyData,
		},
	};
}

/** The positions the canvas currently holds, for the layout sidecar. */
export function layoutOf(canvas: Canvas): Record<string, { x: number; y: number }> {
	const layout: Record<string, { x: number; y: number }> = {};
	for (const node of canvas.nodes) layout[node.id] = { x: Math.round(node.x), y: Math.round(node.y) };
	return layout;
}

/**
 * Positions for the nodes that have no saved one: containment depth across,
 * siblings down, in canvas order. Deterministic, so the same graph always lays
 * out the same way.
 */
export function autoLayout(canvas: Pick<Canvas, "nodes" | "edges">): Record<string, { x: number; y: number }> {
	const children = new Map<string, string[]>();
	for (const edge of canvas.edges) {
		if (edge.relation !== CONTAINS) continue;
		children.set(edge.from, [...(children.get(edge.from) ?? []), edge.to]);
	}
	const hasParent = new Set(canvas.edges.filter((edge) => edge.relation === CONTAINS).map((edge) => edge.to));
	const layout: Record<string, { x: number; y: number }> = {};
	let row = 0;
	const visit = (id: string, depth: number): void => {
		if (layout[id] !== undefined) return;
		layout[id] = { x: 60 + depth * 380, y: 40 + row * 112 };
		row += 1;
		for (const child of children.get(id) ?? []) visit(child, depth + 1);
	};
	for (const node of canvas.nodes) if (!hasParent.has(node.id)) visit(node.id, 0);
	for (const node of canvas.nodes) visit(node.id, 0);
	return layout;
}

function requiredText(value: string, what: string, problems: string[]): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) problems.push(what);
	return trimmed;
}

/** A leaf must carry a verifier; a composite may carry only a whole-object assertion. */
function verifierOf(node: CanvasNode, problems: string[]): Record<string, unknown> | undefined {
	const required = node.kind === "leaf";
	if (node.verifiermode === "programmatic") {
		const script = node.script.trim();
		if (script.length === 0) {
			if (required) problems.push(`${node.id}: 程序化验证缺少脚本名`);
			return undefined;
		}
		return { mode: "programmatic", script };
	}
	const goal = node.goal.trim();
	if (goal.length === 0) {
		if (required) problems.push(`${node.id}: 判据（goal）为空`);
		return undefined;
	}
	return { mode: "agentic", goal };
}

/** The containment edge a child sits on: its own required/failure/degradeTo fields. */
function containmentOf(child: CanvasNode, problems: string[]): Record<string, unknown> {
	const edge: Record<string, unknown> = { required: child.required !== false, failure: child.failure };
	if (child.failure === "degrade") {
		const target = requiredText(child.degradeto, `${child.id}: failure=degrade 需要填 degrade 目标`, problems);
		if (target.length > 0) edge.degradeTo = target;
	}
	return edge;
}

/**
 * An edited canvas as a graph document.
 *
 * Throws `CanvasError` listing everything the author must fix on the canvas
 * itself (empty or duplicate ids, a node with two parents, a composite with no
 * children, not exactly one root). Everything else — dangling references,
 * cycles, empty expressions — is the engine's call, and the caller validates
 * before writing.
 */
export function fromCanvas(canvas: Canvas): Document {
	const problems: string[] = [];
	const nodes = new Map<string, CanvasNode>();
	for (const [index, node] of canvas.nodes.entries()) {
		const id = node.id.trim();
		if (id.length === 0) problems.push(`第 ${index + 1} 个节点没有 id`);
		else if (nodes.has(id)) problems.push(`id 重复: ${id}`);
		else nodes.set(id, { ...node, id });
	}

	const contains: Array<Record<string, unknown>> = [];
	const dependencyEdges: Array<Record<string, unknown>> = [];
	const parentOf = new Map<string, string>();
	const childrenOfNode = new Map<string, string[]>();
	for (const edge of canvas.edges) {
		const from = edge.from.trim();
		const to = edge.to.trim();
		if (!nodes.has(from) || !nodes.has(to)) continue;
		if (edge.relation === DEPENDS) {
			dependencyEdges.push({ source: from, target: to });
			continue;
		}
		if (parentOf.has(to)) problems.push(`${to} 有两个父节点（包含边只能有一条进入）`);
		parentOf.set(to, from);
		childrenOfNode.set(from, [...(childrenOfNode.get(from) ?? []), to]);
		contains.push({ parent: from, child: to });
	}

	for (const node of nodes.values()) {
		const children = childrenOfNode.get(node.id) ?? [];
		if (node.kind === "composite" && children.length === 0) problems.push(`组合节点 ${node.id} 没有任何子节点`);
		if (node.kind === "leaf" && children.length > 0) problems.push(`叶子节点 ${node.id} 不能包含子节点`);
	}

	const roots = [...nodes.values()].filter((node) => !parentOf.has(node.id));
	if (roots.length !== 1) {
		const listed = roots.map((node) => node.id).join(", ");
		problems.push(
			`根节点必须恰好一个（按没有入边判断），当前有 ${roots.length} 个${listed.length === 0 ? "" : `: ${listed}`}`,
		);
	} else if (roots[0]?.constraint !== "hard") {
		problems.push(`根节点 ${roots[0].id} 必须是 hard 约束`);
	}
	if (problems.length > 0) throw new CanvasError(problems);

	const root = roots[0]?.id ?? "";
	const ordered = [
		...canvas.meta.nodeOrder.filter((id) => nodes.has(id)),
		...[...nodes.keys()].filter((id) => !canvas.meta.nodeOrder.includes(id)),
	];
	/** Canvas order (top to bottom) is the reading order the derived expression follows. */
	const visualOrder: Record<string, number> = {};
	let position = 0;
	for (const id of nodes.keys()) {
		visualOrder[id] = position;
		position += 1;
	}
	const built: Record<string, unknown> = {};
	for (const id of ordered) {
		const node = nodes.get(id);
		if (node === undefined) continue;
		const target = targetValue(node.targetkind, node.target);
		if (targetFields(target).value.trim().length === 0) problems.push(`${id}: 目标（target）为空`);
		const children =
			node.kind === "composite"
				? [...(childrenOfNode.get(id) ?? [])].sort(
						(left, right) => (visualOrder[left] ?? 0) - (visualOrder[right] ?? 0),
					)
				: [];
		let completion: unknown;
		if (node.kind === "composite") {
			if (node.completion === DERIVED) {
				completion = { op: "all", items: children.map((child) => ({ op: "ref", id: child })) };
			} else {
				try {
					completion = JSON.parse(node.completion) as unknown;
				} catch (error) {
					problems.push(`${id}: completion 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
				}
			}
		}
		const verifier = verifierOf(node, problems);
		// Field order matches the corpus (kind, title, constraint, target, completion, verifier)
		// so a save with no real change stays byte-identical.
		built[id] = {
			kind: node.kind,
			title: requiredText(node.title, `${id}: 标题为空`, problems),
			constraint: node.constraint,
			target,
			...(node.kind === "composite" ? { completion } : {}),
			...(verifier === undefined ? {} : { verifier }),
		};
	}
	for (const edge of contains) {
		const child = nodes.get(String(edge.child));
		if (child !== undefined) Object.assign(edge, containmentOf(child, problems));
	}
	const dependencies = dependencyEdges.map((edge) => {
		const data = canvas.meta.dependencyData[`${String(edge.source)}\u0000${String(edge.target)}`];
		return data === undefined ? edge : { ...edge, data };
	});
	if (problems.length > 0) throw new CanvasError(problems);

	// The containment array reads in canvas order, so it lines up with the derived
	// completion expressions instead of following wire-creation order.
	contains.sort((left, right) => {
		const parents = (visualOrder[String(left.parent)] ?? 0) - (visualOrder[String(right.parent)] ?? 0);
		return parents !== 0 ? parents : (visualOrder[String(left.child)] ?? 0) - (visualOrder[String(right.child)] ?? 0);
	});

	return {
		schemaVersion: canvas.meta.schemaVersion,
		id: canvas.meta.graphId,
		root,
		...(canvas.meta.schema === undefined ? {} : { $schema: canvas.meta.schema }),
		...(canvas.meta.background === undefined ? {} : { background: canvas.meta.background }),
		nodes: built,
		contains,
		dependsOn: dependencies,
	};
}
