/**
 * Host session: a real OMP session whose DoG tools are served over RPC by this
 * process — no extension, no plugin install, no OMP source change.
 *
 * The host owns the terminal: it streams assistant text and tool activity, and
 * serves `dog_validate` / `dog_create` / `dog_run` / `dog_status` as host tools.
 */

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
	RpcSession,
	type HostToolCall,
	type HostToolContext,
	type HostToolDefinition,
	type HostToolOutcome,
	type RpcFrame,
} from "./rpc.ts";
import { buildReport, compiledSummary } from "./report.ts";
import { createDogRuntime, type DogRuntime } from "./runtime.ts";

export interface HostSessionOptions {
	readonly projectDir: string;
	readonly ompBin: string;
	readonly concurrency: number;
	readonly model?: string;
	readonly thinking?: string;
	readonly verifierTimeoutMs?: number;
	/** Extra arguments for the main session (everything after `--`). */
	readonly ompArgs?: readonly string[];
	readonly input?: Readable;
	readonly output?: Writable;
}

export async function runHostSession(options: HostSessionOptions): Promise<number> {
	const out = options.output ?? process.stdout;
	const runtime = createDogRuntime({
		projectDir: options.projectDir,
		ompBin: options.ompBin,
		concurrency: options.concurrency,
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.thinking === undefined ? {} : { thinking: options.thinking }),
		...(options.verifierTimeoutMs === undefined ? {} : { verifierTimeoutMs: options.verifierTimeoutMs }),
	});
	const session = await RpcSession.start({
		command: [
			options.ompBin,
			"--mode",
			"rpc",
			"--cwd",
			options.projectDir,
			...(options.model === undefined ? [] : ["--model", options.model]),
			...(options.thinking === undefined ? [] : ["--thinking", options.thinking]),
			...(options.ompArgs ?? []),
		],
		cwd: options.projectDir,
		onEvent: (frame) => renderFrame(frame, out),
	});
	await session.registerHostTools(dogToolDefinitions(), (call, context) => handleDogTool(runtime, call, context));
	const onInterrupt = (): void => {
		void session.abort();
	};
	process.on("SIGINT", onInterrupt);
	out.write("\nDoG host session — dog_validate / dog_create / dog_run / dog_status are live. Ctrl-D exits.\n› ");
	const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity });
	try {
		for await (const line of lines) {
			const message = line.trim();
			if (message.length === 0) {
				out.write("› ");
				continue;
			}
			await session.prompt(message);
		}
	} finally {
		process.off("SIGINT", onInterrupt);
		lines.close();
		await session.close();
	}
	return 0;
}

/** Stream one frame to the terminal: text deltas verbatim, everything else compact. */
function renderFrame(frame: RpcFrame, out: Writable): void {
	switch (frame.type) {
		case "message_update": {
			const event = frame.assistantMessageEvent as { type?: string; delta?: string } | undefined;
			if (event?.type === "text_delta" && typeof event.delta === "string") out.write(event.delta);
			return;
		}
		case "tool_execution_start":
			out.write(`\n⏺ ${String(frame.toolName ?? "tool")} ${compactJson(frame.args)}\n`);
			return;
		case "prompt_result": {
			const status = String(frame.status ?? "completed");
			if (status !== "completed") out.write(`\n[${status}]\n`);
			out.write("\n› ");
			return;
		}
		case "extension_error":
			out.write(`\n[extension error] ${String(frame.error ?? "")}\n› `);
			return;
		case "notice":
			out.write(`\n[notice] ${compactJson(frame)}\n› `);
			return;
		case "session_exit":
			out.write("\n[session closed]\n");
			return;
		default:
			return;
	}
}

function compactJson(value: unknown): string {
	const text = JSON.stringify(value ?? null);
	if (text === undefined) return "";
	return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

const GRAPH_PARAMETER = {
	description:
		'Complete DoG graph object using schemaVersion "0.9" (a JSON-encoded string of the same object is also accepted).',
};

function dogToolDefinitions(): readonly HostToolDefinition[] {
	const object = (properties: Record<string, unknown>, required: readonly string[]): Record<string, unknown> => ({
		type: "object",
		properties,
		required: [...required],
		additionalProperties: false,
	});
	return [
		{
			name: "dog_validate",
			label: "DoG validate",
			description: "Statically validate a DoG graph. Writes nothing: no capture, no run, no file changes.",
			parameters: object({ graph: GRAPH_PARAMETER }, ["graph"]),
			loadMode: "essential",
		},
		{
			name: "dog_create",
			label: "DoG create",
			description:
				"Compile a valid DoG graph and freeze every verifier target as immutable bytes. Returns the graphId later runs use.",
			parameters: object({ graph: GRAPH_PARAMETER }, ["graph"]),
			loadMode: "essential",
		},
		{
			name: "dog_run",
			label: "DoG run",
			description:
				"Judge the latest revision of a graph: reuse unchanged verdicts, run scripts inline, dispatch one verifier session per agentic goal, then settle the root. Returns the run report.",
			parameters: object({ graphId: { type: "string", description: "Graph ID returned by dog_create." } }, ["graphId"]),
			loadMode: "essential",
		},
		{
			name: "dog_status",
			label: "DoG status",
			description: "Read one run record: per-goal state, evidence, and which verifier session judged it.",
			parameters: object({ runId: { type: "string", description: "Run ID returned by dog_run." } }, ["runId"]),
			loadMode: "essential",
		},
	];
}

async function handleDogTool(
	runtime: DogRuntime,
	call: HostToolCall,
	context: HostToolContext,
): Promise<HostToolOutcome> {
	switch (call.toolName) {
		case "dog_validate":
			return { text: JSON.stringify(runtime.engine.validate(coerceGraphArgument(call.arguments.graph)), null, 2) };
		case "dog_create": {
			const compiled = await runtime.engine.create(coerceGraphArgument(call.arguments.graph), {
				captureBaseDir: runtime.projectDir,
			});
			return { text: JSON.stringify(compiledSummary(compiled), null, 2) };
		}
		case "dog_run": {
			const run = await runtime.engine.run(String(call.arguments.graphId ?? ""), {
				signal: context.signal,
				onProgress: (progress) => context.update(progressLine(progress.goals)),
			});
			return { text: JSON.stringify(buildReport(run), null, 2) };
		}
		case "dog_status":
			return {
				text: JSON.stringify(buildReport(await runtime.engine.status(String(call.arguments.runId ?? ""))), null, 2),
			};
		default:
			return { text: `unknown DoG tool ${call.toolName}`, isError: true };
	}
}

function progressLine(goals: Readonly<Record<string, { readonly state: string }>>): string {
	return Object.entries(goals)
		.sort((left, right) => left[0].localeCompare(right[0]))
		.map(([goalId, result]) => `${goalId}=${result.state}`)
		.join(" ");
}

/** Accept a graph handed over as JSON text as well as an object. */
function coerceGraphArgument(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		throw new Error(
			`graph was a string but not valid JSON: ${value.slice(0, 60)}${value.length > 60 ? "…" : ""} — pass the graph as an object.`,
		);
	}
}
