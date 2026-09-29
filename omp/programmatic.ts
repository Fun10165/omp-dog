/** Programmatic kernel: a host-registered script judged the frozen object. */

import { execFileSync } from "node:child_process";
import { resolveScriptPath } from "../core/engine.ts";
import { isJsonValue, type JsonValue } from "../core/model.ts";
import type { ProgrammaticRunner, Verdict } from "../core/verifiers.ts";

const SCRIPT_TIMEOUT_MS = 900_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** Parse one script's stdout into a verdict; every unknown shape is inconclusive. */
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

function inconclusive(evidence: Record<string, JsonValue>, reason: string): Verdict {
	return { state: "inconclusive", evidence, reason };
}

export function createProgrammaticRunner(scriptsDirectory: string): ProgrammaticRunner {
	return async (script, inputPath) => {
		let path: string;
		try {
			path = resolveScriptPath(scriptsDirectory, script);
		} catch (error) {
			return inconclusive(
				{ error: error instanceof Error ? error.message : String(error) },
				"script not in the library",
			);
		}
		try {
			const stdout = execFileSync(path, [inputPath], {
				encoding: "utf8",
				timeout: SCRIPT_TIMEOUT_MS,
				maxBuffer: MAX_OUTPUT_BYTES,
			});
			return parseVerdict(stdout);
		} catch (error) {
			return inconclusive({ error: error instanceof Error ? error.message : String(error) }, "script execution failed");
		}
	};
}
