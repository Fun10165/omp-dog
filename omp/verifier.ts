/**
 * Agentic kernel: one `omp --mode rpc` verifier session per judgment.
 *
 * The session is spawned with a frozen tool face and a frozen system prompt, is
 * handed the brief, and hands its verdict back by calling the host tool
 * `dog_submit_verdict` — the information exchange is RPC in both directions.
 */

import { mkdir } from "node:fs/promises";
import { isJsonValue, type JsonValue } from "../core/model.ts";
import type { AgenticRunner, Verdict } from "../core/verifiers.ts";
import { buildVerifierBrief, readVerifierSystemPrompt } from "./brief.ts";
import { VERDICT_TOOL_NAME, VERIFIER_TOOLS, newestSessionFile } from "./config.ts";
import { RpcSession, type RpcFrame } from "./rpc.ts";

export interface VerifierKernelOptions {
	readonly ompBin: string;
	readonly systemPromptPath: string;
	/** Model for verifier sessions; omitted means the host's configured default. */
	readonly model?: string;
	readonly thinking?: string;
	/** Budget for one verdict. */
	readonly timeoutMs?: number;
	/** How long a finished turn may still produce a verdict before settling inconclusive. */
	readonly graceMs?: number;
	readonly sessionDirectory: (runId: string, goalId: string) => string;
	readonly onFrame?: (goalId: string, frame: RpcFrame) => void;
}

const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_GRACE_MS = 5_000;

export function createRpcAgenticRunner(options: VerifierKernelOptions): AgenticRunner {
	const systemPrompt = readVerifierSystemPrompt(options.systemPromptPath);
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
	return async (instruction, workspace, target, env) => {
		const sessionDirectory = options.sessionDirectory(env.runId, env.goalId);
		await mkdir(sessionDirectory, { recursive: true });
		const session = await RpcSession.start({
			command: [
				options.ompBin,
				"--mode",
				"rpc",
				"--no-ui",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--tools",
				VERIFIER_TOOLS.join(","),
				"--cwd",
				workspace,
				"--session-dir",
				sessionDirectory,
				"--append-system-prompt",
				systemPrompt,
				...(options.model === undefined ? [] : ["--model", options.model]),
				...(options.thinking === undefined ? [] : ["--thinking", options.thinking]),
			],
			cwd: workspace,
			onEvent: (frame) => options.onFrame?.(env.goalId, frame),
		});
		const submitted = Promise.withResolvers<Verdict>();
		await session.registerHostTools([verdictToolDefinition()], async (call) => {
			const parsed = verdictFromArguments(call.arguments);
			if (!parsed.ok) return { text: parsed.error, isError: true };
			submitted.resolve(parsed.verdict);
			return { text: "Verdict recorded. Stop now." };
		});
		const brief = buildVerifierBrief({
			goalId: target.goalId,
			title: target.title,
			instruction,
			objectPath: target.target,
			...(target.byteLength === undefined ? {} : { objectBytes: target.byteLength }),
			...(target.sha256 === undefined || target.sha256.length === 0 ? {} : { objectSha256: target.sha256 }),
			objectIsDirectory: target.isDirectory,
		});
		const turnFinished = session
			.request("prompt", { message: brief }, { timeoutMs: 60_000 })
			.then(() => session.waitForFrame((frame) => frame.type === "prompt_result", timeoutMs, "prompt_result"))
			.then(() => sleep(graceMs))
			.then(() => {
				throw new Error("verifier session finished without submitting a verdict");
			});
		const timedOut = Promise.withResolvers<Verdict>();
		const timer = setTimeout(
			() => timedOut.reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for a verdict`)),
			timeoutMs,
		);
		timer.unref();
		const aborted = Promise.withResolvers<Verdict>();
		if (env.signal?.aborted === true) aborted.reject(new Error("canceled"));
		else env.signal?.addEventListener("abort", () => aborted.reject(new Error("canceled")), { once: true });
		let verdict: Verdict;
		try {
			verdict = await Promise.race([submitted.promise, turnFinished, timedOut.promise, aborted.promise]);
		} catch (error) {
			verdict = { state: "inconclusive", evidence: { outcome: messageOf(error) }, reason: messageOf(error) };
		}
		clearTimeout(timer);
		await session.close();
		const sessionFile = await newestSessionFile(sessionDirectory);
		return { ...verdict, ...(sessionFile === undefined ? {} : { sessionFile }) };
	};
}

function verdictToolDefinition(): {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	loadMode: "essential";
} {
	return {
		name: VERDICT_TOOL_NAME,
		label: "Submit verdict",
		description:
			"Report the verdict for the object you were asked to judge. Call this exactly once, after you have gathered the evidence.",
		parameters: {
			type: "object",
			properties: {
				verdict: {
					type: "string",
					enum: ["pass", "fail", "inconclusive"],
					description:
						"pass: the instruction is satisfied. fail: it is violated. inconclusive: you cannot decide honestly.",
				},
				evidence: {
					description:
						"Evidence for the verdict, as JSON (an object when you have one: quotes, counts, paths, measurements).",
				},
				reason: { type: "string", description: "Optional one-line reason for the verdict." },
			},
			required: ["verdict", "evidence"],
			additionalProperties: false,
		},
		loadMode: "essential",
	};
}

type VerdictParse = { readonly ok: true; readonly verdict: Verdict } | { readonly ok: false; readonly error: string };

function verdictFromArguments(args: Record<string, unknown>): VerdictParse {
	const state = args.verdict;
	if (state !== "pass" && state !== "fail" && state !== "inconclusive") {
		return { ok: false, error: 'verdict must be "pass", "fail", or "inconclusive"' };
	}
	// A model that serializes its evidence into a JSON string still meant the
	// object inside; unwrap one level when that is what it is.
	let evidence: JsonValue = isJsonValue(args.evidence) ? args.evidence : {};
	if (typeof evidence === "string") {
		try {
			const parsed: unknown = JSON.parse(evidence);
			if (isJsonValue(parsed)) evidence = parsed;
		} catch {
			// keep the string: it is still evidence, just not structured
		}
	}
	const reason = typeof args.reason === "string" && args.reason.length > 0 ? args.reason : undefined;
	return { ok: true, verdict: { state, evidence, ...(reason === undefined ? {} : { reason }) } };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	timer.unref();
	return promise;
}
