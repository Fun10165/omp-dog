/** What each verifier session is told: the frozen object, the instruction, and the delivery contract. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { VERDICT_TOOL_NAME } from "./config.ts";

/** Repository root of this project (`omp/` sits directly under it). */
export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Persona appended to a verifier session's system prompt. */
export const VERIFIER_SYSTEM_PROMPT_FILE = join(PROJECT_ROOT, "prompts", "verifier.md");

export function readVerifierSystemPrompt(path: string = VERIFIER_SYSTEM_PROMPT_FILE): string {
	return readFileSync(path, "utf8");
}

export interface BriefOptions {
	readonly goalId: string;
	readonly title: string;
	readonly instruction: string;
	/** Path of the object relative to the session's working directory. */
	readonly objectPath: string;
	readonly objectBytes?: number;
	readonly objectSha256?: string;
	/** True when the object is a directory unpacked from a captured archive. */
	readonly objectIsDirectory: boolean;
}

/** The exact assignment one verifier session receives. */
export function buildVerifierBrief(options: BriefOptions): string {
	const shape = options.objectIsDirectory ? "directory" : "file";
	const lines = [
		`You are the verifier for DoG goal "${options.goalId}" (${options.title}).`,
		"",
		`Object: the ${shape} \`${options.objectPath}\` in your working directory. Judge those bytes and nothing else.`,
		...(options.objectBytes === undefined ? [] : [`Size: ${options.objectBytes} bytes.`]),
		...(options.objectSha256 === undefined ? [] : [`sha256: ${options.objectSha256}`]),
		options.objectIsDirectory
			? "That directory is the frozen capture; its contents are complete and final."
			: "That file is the frozen capture; it is complete and final.",
		"",
		"Instruction (the only standard you judge by):",
		options.instruction,
		"",
		"Gather the evidence you need with your own judgment; there is no fixed evidence format.",
		`When you are done, call the \`${VERDICT_TOOL_NAME}\` tool exactly once with your verdict and the evidence, then stop.`,
		'A verdict you cannot honestly reach is "inconclusive" — never guess a pass.',
	].join("\n");
	return lines;
}
