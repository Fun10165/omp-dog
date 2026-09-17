/**
 * The two judgment kernels on OMP.
 *
 * Programmatic: run the registered script with the captured object path — the
 * same contract the DSH deployment used, now through `pi.exec`.
 *
 * Agentic: read back the settlement an already-dispatched read-only verifier
 * wrote. The kernel never starts a worker (OMP gives extensions no such API)
 * and never accepts a verdict it cannot bind to the bytes on disk.
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolveScriptPath } from "../core/engine.ts";
import { sha256Json } from "../core/json.ts";
import { isJsonValue } from "../core/model.ts";
import type { AgenticRunner, ProgrammaticRunner, Verdict } from "../core/verifiers.ts";
import {
	dispatchDirectory,
	instructionHashOf,
	resolveSettlement,
	sha256OfFile,
	type SettlementResolution,
} from "./settlement.ts";

const SCRIPT_TIMEOUT_MS = 900_000;
const STDERR_TAIL = 2_000;

/** Every non-pass path is built here, so "evidence is JSON, state is inconclusive" holds by construction. */
function inconclusive(evidence: Record<string, string | number | boolean>, reason: string): Verdict {
	return { state: "inconclusive", evidence, reason };
}

/** Parse one programmatic script's stdout into a verdict. */
export function parseVerdict(stdout: string): Verdict {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		return inconclusive({ parseError: "script output was not JSON" }, "script output was not JSON");
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return inconclusive({ parseError: "script output was not an object" }, "script output was not an object");
	}
	const record = value as Record<string, unknown>;
	const verdict = record.verdict;
	if (verdict !== "pass" && verdict !== "fail" && verdict !== "inconclusive") {
		return inconclusive({ parseError: "invalid verdict" }, "script returned an invalid verdict");
	}
	return {
		state: verdict,
		evidence: isJsonValue(record.evidence) ? record.evidence : { outcome: "no evidence supplied by script" },
	};
}

export function createProgrammaticRunner(pi: ExtensionAPI, scriptsDirectory: string): ProgrammaticRunner {
	return async (script, inputPath, env) => {
		let scriptPath: string;
		try {
			scriptPath = resolveScriptPath(scriptsDirectory, script);
		} catch (error) {
			return inconclusive({ error: messageOf(error) }, "registered script could not be resolved");
		}
		const result = await pi.exec(scriptPath, [inputPath], {
			...(env.signal === undefined ? {} : { signal: env.signal }),
			timeout: SCRIPT_TIMEOUT_MS,
		});
		if (result.killed) {
			return inconclusive({ error: "script interrupted" }, "script execution was interrupted");
		}
		if (result.code !== 0) {
			return inconclusive(
				{ code: result.code, stderr: result.stderr.slice(-STDERR_TAIL) },
				`script exited with code ${result.code}`,
			);
		}
		return parseVerdict(result.stdout);
	};
}

export interface AgenticRunnerOptions {
	/** Project-scoped DoG root (settlements live under `<dogRoot>/dispatches`). */
	readonly dogRoot: string;
	/** Graph revision each live run was started against. */
	readonly graphDigestFor: (runId: string) => string | undefined;
}

/**
 * Resolve one agentic judgment from a dispatched verifier's settlement file.
 *
 * Every failure path is `inconclusive`, never `pass`: a missing verifier, a
 * settlement for another instruction, a verdict whose captured digest no longer
 * matches the bytes in the workspace, or one written before it was dispatched
 * all fail closed.
 */
export function createAgenticRunner(options: AgenticRunnerOptions): AgenticRunner {
	const directory = dispatchDirectory(options.dogRoot);
	return async (instruction, _workspace, inputPath, env) => {
		const { goalId, runId } = env;
		if (goalId === undefined) {
			return inconclusive(
				{ outcome: "agentic kernel invoked without a goal" },
				"agentic kernel invoked without a goal",
			);
		}
		const graphDigest = runId === undefined ? undefined : options.graphDigestFor(runId);
		if (graphDigest === undefined) {
			return inconclusive({ outcome: "run is not bound to a graph revision" }, "run is not bound to a graph revision");
		}
		const inputSha256 = await sha256OfFile(inputPath);
		if (inputSha256 === undefined) {
			return inconclusive(
				{ outcome: "captured object is unavailable", path: inputPath },
				"captured object is unavailable to the verifier",
			);
		}
		const instructionHash = instructionHashOf(instruction);
		const requestId = sha256Json({ graphDigest, goalId, instructionHash, inputSha256 });
		const settlementPath = join(directory, `${requestId}.settlement.json`);
		// The same rule the dispatch pre-flight applies: if this rejects, the plan
		// asks for a fresh dispatch instead of a verdict, so the two never disagree.
		const resolution = await resolveSettlement({
			settlementPath,
			requestPath: join(directory, `${requestId}.request.json`),
			inputSha256,
			instructionHash,
		});
		if (!resolution.ok) {
			const rejected = settlementRejection(resolution, { requestId, inputSha256 });
			return inconclusive(rejected.evidence, rejected.reason);
		}
		const record = resolution.record;
		return {
			state: record.state,
			evidence: record.evidence ?? {
				outcome: record.state,
				...(record.verifierAgent === undefined ? {} : { verifierAgent: record.verifierAgent }),
				...(record.reason === undefined ? {} : { reason: record.reason }),
			},
			...(record.reason === undefined ? {} : { reason: record.reason }),
		};
	};
}

/** Diagnostics for a rejected settlement, kept apart from the rule that rejected it. */
function settlementRejection(
	rejection: Extract<SettlementResolution, { readonly ok: false }>,
	context: { readonly requestId: string; readonly inputSha256: string },
): { readonly evidence: Record<string, string | number | boolean>; readonly reason: string } {
	switch (rejection.reason) {
		case "absent":
			return {
				evidence: { outcome: "verifier has not settled this goal", requestId: context.requestId },
				reason: "no verifier settlement exists for this judgment",
			};
		case "unparsable":
			return {
				evidence: { outcome: "settlement is not a usable record", requestId: context.requestId },
				reason: "the settlement file could not be read as a verdict",
			};
		case "different-bytes":
			return {
				evidence: {
					outcome: "settlement judged different bytes",
					settled: rejection.settled ?? "",
					current: rejection.current ?? context.inputSha256,
				},
				reason: "settlement is stale: the captured object changed after it was judged",
			};
		case "different-instruction":
			return {
				evidence: { outcome: "settlement answered a different instruction" },
				reason: "settlement is not for this instruction",
			};
		case "predates-request":
			return {
				evidence: { outcome: "settlement predates its dispatch request" },
				reason: "settlement was not written in response to the dispatched verification",
			};
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
