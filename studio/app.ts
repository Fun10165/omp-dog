/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * The studio page: a Drawflow canvas bound to one DoG graph file.
 *
 * The page owns the view only. What the wires mean, how a completion expression
 * is derived, and which edits must be refused live in `dogflow.ts`; validation
 * and writing live in the server, which reuses the engine's own validator.
 *
 * Drawflow owns positions and wires; the page owns the node's fields in its own
 * store, so a value typed in the inspector is never read back out of the DOM.
 * Canvas nodes stay compact (id, title, a preview of the judgment) so a whole
 * graph fits on screen; every editable field lives in the inspector.
 */

import Drawflow from "drawflow";
import {
	autoLayout,
	CanvasError,
	CONTAINS,
	DEPENDS,
	DERIVED,
	fromCanvas,
	layoutOf,
	toCanvas,
	type Canvas,
	type CanvasEdge,
	type CanvasMeta,
	type CanvasNode,
	type Kind,
} from "./dogflow.ts";

/** Every field of one node, as strings: the inspector's own model. */
interface NodeFields {
	id: string;
	title: string;
	constraint: string;
	targetkind: string;
	target: string;
	verifiermode: string;
	instruction: string;
	script: string;
	required: string;
	failure: string;
	degradeto: string;
	completion: string;
}

type FieldName = keyof NodeFields;
type InspectorField = Exclude<FieldName, "id">;

const INSPECTOR_FIELDS: readonly InspectorField[] = [
	"title",
	"targetkind",
	"constraint",
	"target",
	"verifiermode",
	"script",
	"instruction",
	"required",
	"failure",
	"degradeto",
	"completion",
];

interface StudioState {
	loaded: Canvas | undefined;
	dirty: boolean;
	/** Drawflow node id (as a string) of the selected node. */
	selected: string | undefined;
	/** Drawflow node id -> every field of that node. */
	fields: Record<string, NodeFields>;
}

const state: StudioState = { loaded: undefined, dirty: false, selected: undefined, fields: {} };

const canvas = document.getElementById("drawflow") as HTMLElement;
const status = document.getElementById("status") as HTMLElement;
const problems = document.getElementById("problems") as HTMLElement;
const graphPath = document.getElementById("graph-path") as HTMLElement;
const inspector = document.getElementById("inspector") as HTMLElement;
const inspectorHead = document.getElementById("inspector-head") as HTMLElement;
const inspectorHint = document.getElementById("inspector-hint") as HTMLElement;

const inputs: Partial<Record<InspectorField, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>> = {};
for (const element of inspector.querySelectorAll<HTMLElement>("[data-field]")) {
	const name = element.dataset.field as InspectorField | undefined;
	if (name !== undefined) inputs[name] = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}

const editor = new Drawflow(canvas);
editor.reroute = false;
editor.zoom_min = 0.2;
editor.start();

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"]/gu,
		(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character] ?? character,
	);
}

function nodeHtml(kind: Kind, id: string, title: string): string {
	return `<div class="dog-node">
	<div class="dog-head">
		<span class="dog-kind">${kind === "composite" ? "组合" : "叶子"}</span>
		<input class="dog-id" spellcheck="false" value="${escapeHtml(id)}" />
	</div>
	<input class="dog-title" value="${escapeHtml(title)}" />
	<div class="dog-preview"></div>
</div>`;
}

function nodeElement(key: string): HTMLElement | null {
	return document.querySelector(`#node-${key}`);
}

function previewOf(fields: NodeFields, kind: Kind): string {
	if (fields.verifiermode === "programmatic" && fields.script.trim().length > 0) return `脚本 ${fields.script.trim()}`;
	const instruction = fields.instruction.trim().replace(/\s+/gu, " ");
	if (instruction.length > 0) return instruction.length > 72 ? `${instruction.slice(0, 72)}…` : instruction;
	return kind === "composite" ? "（组合：由子节点与完成表达式决定）" : "";
}

function paintNode(key: string, kind: Kind): void {
	const fields = state.fields[key];
	const element = nodeElement(key);
	if (fields === undefined || element === null) return;
	const preview = element.querySelector(".dog-preview");
	if (preview !== null) preview.textContent = previewOf(fields, kind);
	const idInput = element.querySelector<HTMLInputElement>(".dog-id");
	if (idInput !== null && idInput.value !== fields.id) idInput.value = fields.id;
	const titleInput = element.querySelector<HTMLInputElement>(".dog-title");
	if (titleInput !== null && titleInput.value !== fields.title) titleInput.value = fields.title;
}

function kindOfKey(key: string): Kind {
	const data = editor.export().drawflow?.Home?.data ?? {};
	return data[key]?.name === "composite" ? "composite" : "leaf";
}

function toggleConditional(): void {
	const programmatic = inputs.verifiermode?.value === "programmatic";
	const degrade = inputs.failure?.value === "degrade";
	if (inputs.instruction !== undefined) inputs.instruction.style.display = programmatic ? "none" : "";
	if (inputs.script !== undefined) inputs.script.style.display = programmatic ? "" : "none";
	if (inputs.degradeto !== undefined) inputs.degradeto.style.display = degrade ? "" : "none";
}

function fillInspector(): void {
	const key = state.selected;
	const fields = key === undefined ? undefined : state.fields[key];
	const disabled = fields === undefined;
	for (const name of INSPECTOR_FIELDS) {
		const element = inputs[name];
		if (element === undefined) continue;
		element.disabled = disabled;
		const value = fields?.[name] ?? "";
		if (element.value !== value) element.value = value;
	}
	if (fields === undefined) {
		inspectorHead.textContent = "未选中节点";
		inspectorHint.textContent = "点画布上的节点来编辑它的字段；拖动右侧的圆点连线（上：包含，下：依赖）。";
	} else {
		inspectorHead.textContent = `${fields.id} · ${kindOfKey(key ?? "") === "composite" ? "组合" : "叶子"}`;
		inspectorHint.textContent = "拖动节点右侧上方的蓝点＝包含（父→子）；下方的橙点＝依赖（先→后）。";
	}
	toggleConditional();
}

/** Drawflow renders one connection element per wire; class it by the port it left. */
function decorateConnections(): void {
	for (const element of canvas.querySelectorAll(".connection")) {
		const depends = element.classList.contains("output_2") || element.classList.contains("input_2");
		element.classList.toggle("dog-depends", depends);
		element.classList.toggle("dog-contains", !depends);
	}
}

/** Zoom and pan so the whole graph fits the viewport; `minZoom` keeps it readable. */
function fitView(minZoom: number): void {
	const data = editor.export().drawflow?.Home?.data ?? {};
	const boxes = Object.keys(data).map((key) => {
		const element = nodeElement(key);
		return {
			x: data[key].pos_x,
			y: data[key].pos_y,
			width: element?.offsetWidth ?? 260,
			height: element?.offsetHeight ?? 90,
		};
	});
	if (boxes.length === 0) return;
	const minX = Math.min(...boxes.map((box) => box.x));
	const minY = Math.min(...boxes.map((box) => box.y));
	const maxX = Math.max(...boxes.map((box) => box.x + box.width));
	const maxY = Math.max(...boxes.map((box) => box.y + box.height));
	const viewport = canvas.getBoundingClientRect();
	const padding = 30;
	const zoom = Math.max(
		minZoom,
		Math.min(1, (viewport.width - padding * 2) / (maxX - minX), (viewport.height - padding * 2) / (maxY - minY)),
	);
	editor.zoom = zoom;
	editor.zoom_last_value = zoom;
	editor.canvas_x = padding - minX * zoom;
	editor.canvas_y = padding - minY * zoom;
	editor.zoom_refresh();
}

function render(edited: Canvas): void {
	editor.clear();
	state.fields = {};
	state.selected = undefined;
	const drawflowIds: Record<string, string | number> = {};
	for (const node of edited.nodes) {
		const key = editor.addNode(
			node.kind,
			1,
			2,
			node.x,
			node.y,
			`dog-${node.kind}`,
			{},
			nodeHtml(node.kind, node.id, node.title),
			false,
		);
		const id = String(key);
		drawflowIds[node.id] = key;
		state.fields[id] = {
			id: node.id,
			title: node.title,
			constraint: node.constraint,
			targetkind: node.targetkind,
			target: node.target,
			verifiermode: node.verifiermode,
			instruction: node.instruction,
			script: node.script,
			required: node.required ? "true" : "false",
			failure: node.failure,
			degradeto: node.degradeto,
			completion: node.completion,
		};
		paintNode(id, node.kind);
	}
	for (const edge of edited.edges) {
		const from = drawflowIds[edge.from];
		const to = drawflowIds[edge.to];
		if (from === undefined || to === undefined) continue;
		editor.addConnection(from, to, edge.relation === CONTAINS ? "output_1" : "output_2", "input_1");
	}
	decorateConnections();
	fillInspector();
}

/** The canvas as the bridge sees it: the field store plus Drawflow's wires and positions. */
function collect(): Canvas {
	const data = editor.export().drawflow?.Home?.data ?? {};
	const nodes: CanvasNode[] = [];
	for (const key of Object.keys(data)) {
		const fields = state.fields[key];
		if (fields === undefined) continue;
		const failure = fields.failure;
		nodes.push({
			id: fields.id,
			kind: data[key].name === "composite" ? "composite" : "leaf",
			title: fields.title,
			constraint: fields.constraint === "soft" ? "soft" : "hard",
			targetkind: fields.targetkind === "git" ? "git" : "path",
			target: fields.target,
			verifiermode: fields.verifiermode === "programmatic" ? "programmatic" : "agentic",
			instruction: fields.instruction,
			script: fields.script,
			required: fields.required !== "false",
			failure: failure === "tolerable" || failure === "degrade" ? failure : "fatal",
			degradeto: fields.degradeto,
			completion: fields.completion,
			x: data[key].pos_x,
			y: data[key].pos_y,
		});
	}
	nodes.sort((left, right) => left.y - right.y || left.x - right.x);
	const edges: CanvasEdge[] = [];
	for (const key of Object.keys(data)) {
		for (const port of Object.keys(data[key].outputs ?? {})) {
			const relation = port === "output_2" ? DEPENDS : CONTAINS;
			for (const connection of data[key].outputs[port]?.connections ?? []) {
				const from = state.fields[key]?.id;
				const to = state.fields[String(connection.node)]?.id;
				if (from === undefined || to === undefined) continue;
				edges.push({ from, to, relation });
			}
		}
	}
	return { nodes, edges, meta: meta() };
}

function meta(): CanvasMeta {
	const loaded = state.loaded;
	return {
		schemaVersion: loaded?.meta.schemaVersion ?? "0.9",
		graphId: loaded?.meta.graphId ?? "",
		root: loaded?.meta.root ?? "",
		...(loaded?.meta.schema === undefined ? {} : { schema: loaded.meta.schema }),
		...(loaded?.meta.background === undefined ? {} : { background: loaded.meta.background }),
		nodeOrder: loaded?.meta.nodeOrder ?? [],
		dependencyData: loaded?.meta.dependencyData ?? {},
	};
}

function show(messages: readonly string[], note: string): void {
	status.textContent = note;
	problems.innerHTML = "";
	for (const message of messages) {
		const item = document.createElement("li");
		item.textContent = message;
		problems.append(item);
	}
}

function serialize(document: Record<string, unknown>): string {
	return `${JSON.stringify(document, null, "\t")}\n`;
}

function placed(edited: Canvas, layout: Layout): Canvas {
	return { ...edited, nodes: edited.nodes.map((node) => ({ ...node, ...layout[node.id] })) };
}

type Layout = Readonly<Record<string, { readonly x: number; readonly y: number }>>;

/** Rebuild the canvas from the file on disk, discarding unsaved edits. */
async function reload(): Promise<void> {
	const response = await fetch("/api/graph");
	if (!response.ok) {
		show([`读取失败: ${response.statusText}`], "读取失败");
		return;
	}
	const payload = (await response.json()) as { path: string; text: string; layout: Layout | null };
	graphPath.textContent = payload.path;
	const parsed = JSON.parse(payload.text) as Record<string, unknown>;
	const saved: Layout = payload.layout ?? {};
	const withoutPositions = toCanvas(parsed, {});
	const automatic = autoLayout(withoutPositions);
	const layout: Layout = Object.fromEntries(
		withoutPositions.nodes.map((node) => [node.id, saved[node.id] ?? automatic[node.id] ?? { x: 60, y: 60 }]),
	);
	state.loaded = toCanvas(parsed, layout);
	state.dirty = false;
	render(placed(state.loaded, layout));
	fitView(0.6);
	show([], "已载入 · 点「适配窗口」看全图，滚轮缩放，空白处拖动平移");
}

async function currentDocument(): Promise<Record<string, unknown> | undefined> {
	try {
		return fromCanvas(collect());
	} catch (error) {
		if (error instanceof CanvasError) show(error.problems, "画布上有问题，尚未保存");
		else show([error instanceof Error ? error.message : String(error)], "画布上有问题，尚未保存");
		return undefined;
	}
}

async function save(): Promise<void> {
	const document_ = await currentDocument();
	if (document_ === undefined) return;
	const response = await fetch("/api/graph", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: serialize(document_), layout: layoutOf(collect()) }),
	});
	const payload = (await response.json()) as {
		ok: boolean;
		problems?: readonly string[];
		warnings?: readonly string[];
		backup?: string;
		pruned?: number;
	};
	if (!payload.ok) {
		show(payload.problems ?? ["保存被拒绝"], "保存被拒绝（图未通过校验，文件未改动）");
		return;
	}
	state.dirty = false;
	const notes = [...(payload.warnings ?? [])];
	if (payload.backup !== undefined) notes.push(`备份: ${payload.backup}`);
	if (payload.pruned !== undefined) notes.push(`已清理 ${payload.pruned} 个旧备份（只保留最近 5 个）`);
	show(notes, "已保存");
}

async function validateOnly(): Promise<void> {
	const document_ = await currentDocument();
	if (document_ === undefined) return;
	const response = await fetch("/api/validate", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: serialize(document_) }),
	});
	const payload = (await response.json()) as {
		valid: boolean;
		errors?: readonly string[];
		warnings?: readonly string[];
	};
	show([...(payload.errors ?? []), ...(payload.warnings ?? [])], payload.valid ? "校验通过" : "校验未通过");
}

function addNode(kind: Kind): void {
	const data = editor.export().drawflow?.Home?.data ?? {};
	const keys = Object.keys(data);
	const positions = keys.map((key) => ({ x: data[key].pos_x, y: data[key].pos_y }));
	const x = positions.length === 0 ? 60 : Math.min(...positions.map((position) => position.x));
	const y = positions.length === 0 ? 60 : Math.max(...positions.map((position) => position.y)) + 160;
	const id = `${kind === "composite" ? "group" : "leaf"}-${keys.length + 1}`;
	const key = String(editor.addNode(kind, 1, 2, x, y, `dog-${kind}`, {}, nodeHtml(kind, id, ""), false));
	state.fields[key] = {
		id,
		title: "",
		constraint: "hard",
		targetkind: "path",
		target: "",
		verifiermode: "agentic",
		instruction: "",
		script: "",
		required: "true",
		failure: "fatal",
		degradeto: "",
		completion: DERIVED,
	};
	state.dirty = true;
	state.selected = key;
	paintNode(key, kind);
	fillInspector();
}

async function main(): Promise<void> {
	document.getElementById("save")?.addEventListener("click", () => void save());
	document.getElementById("validate")?.addEventListener("click", () => void validateOnly());
	document.getElementById("reload")?.addEventListener("click", () => {
		if (state.dirty && !window.confirm("画布上有未保存的改动，确定丢弃？")) return;
		void reload();
	});
	document.getElementById("add-leaf")?.addEventListener("click", () => addNode("leaf"));
	document.getElementById("add-composite")?.addEventListener("click", () => addNode("composite"));
	document.getElementById("fit")?.addEventListener("click", () => fitView(0.2));
	document.getElementById("delete")?.addEventListener("click", () => {
		if (state.selected === undefined) return;
		editor.removeNodeId(state.selected);
		delete state.fields[state.selected];
		state.selected = undefined;
		state.dirty = true;
		decorateConnections();
		fillInspector();
	});
	document.getElementById("relayout")?.addEventListener("click", () => {
		const edited = collect();
		render(placed(edited, autoLayout(edited)));
		fitView(0.6);
		state.dirty = true;
	});

	inspector.addEventListener("input", (event) => {
		const target = event.target as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) | null;
		const name = target?.dataset.field as InspectorField | undefined;
		const key = state.selected;
		if (target === null || name === undefined || key === undefined) return;
		const fields = state.fields[key];
		if (fields === undefined) return;
		fields[name] = target.value;
		state.dirty = true;
		if (name === "verifiermode" || name === "failure") toggleConditional();
		if (name === "title") {
			const titleInput = nodeElement(key)?.querySelector<HTMLInputElement>(".dog-title");
			if (titleInput !== null && titleInput !== undefined) titleInput.value = target.value;
		}
		if (name === "instruction" || name === "script" || name === "verifiermode") paintNode(key, kindOfKey(key));
	});

	canvas.addEventListener("input", (event) => {
		const target = event.target as HTMLInputElement | null;
		if (target === null) return;
		const element = target.closest(".drawflow-node");
		if (element === null) return;
		const key = element.id.replace("node-", "");
		const fields = state.fields[key];
		if (fields === undefined) return;
		if (target.classList.contains("dog-id")) fields.id = target.value;
		else if (target.classList.contains("dog-title")) fields.title = target.value;
		else return;
		state.dirty = true;
		if (key === state.selected) fillInspector();
	});

	editor.on("nodeSelected", (id: string | number) => {
		state.selected = String(id);
		fillInspector();
	});
	editor.on("nodeUnselected", () => {
		state.selected = undefined;
		fillInspector();
	});
	editor.on("connectionCreated", () => {
		state.dirty = true;
		decorateConnections();
	});
	editor.on("connectionRemoved", () => {
		state.dirty = true;
		decorateConnections();
	});
	editor.on("connectionCancel", decorateConnections);
	editor.on("import", decorateConnections);
	window.addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			void save();
		}
	});
	await reload();
	fillInspector();
	show([], "已载入");
}

void main();
