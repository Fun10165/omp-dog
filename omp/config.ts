/** Deployment surface: where DoG state lives, which OMP binary to drive, what a verifier may use. */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DogConfig } from "../core/model.ts";

/** Read-only built-in tools a verifier session starts with. */
export const VERIFIER_TOOLS = ["read", "grep", "glob", "find"] as const;

/** The one tool a verifier session calls to hand its verdict back over RPC. */
export const VERDICT_TOOL_NAME = "dog_submit_verdict";

/** Project-scoped DoG root: state travels with the repository it describes. */
export function dogRootFor(projectDir: string): string {
	return join(projectDir, ".omp", "dog");
}

/** `--omp`, then `OMP_BIN`, then `omp` from PATH. */
export function resolveOmpBin(explicit?: string): string {
	if (explicit !== undefined && explicit.length > 0) return explicit;
	const fromEnv = process.env.OMP_BIN;
	return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : "omp";
}

export function engineConfigFor(options: {
	readonly projectDir: string;
	readonly scriptsDirectory: string;
	readonly concurrency: number;
	readonly maxSandboxBytes?: number;
	readonly allowPartialRoot?: boolean;
}): DogConfig {
	return {
		storageDirectory: join(".omp", "dog"),
		workspaceRoot: join(dogRootFor(options.projectDir), "workspace"),
		scriptsDirectory: options.scriptsDirectory,
		maxGraphNodes: 256,
		maxExpressionNodes: 512,
		maxExpressionDepth: 64,
		maxSandboxBytes: options.maxSandboxBytes ?? 67_108_864,
		allowPartialRoot: options.allowPartialRoot ?? false,
		maxConcurrentVerifications: options.concurrency,
	};
}

/** Newest session transcript in one directory, for the run's evidence ledger. */
export async function newestSessionFile(directory: string): Promise<string | undefined> {
	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch {
		return undefined;
	}
	const candidates: Array<{ path: string; modified: number }> = [];
	for (const name of entries) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(directory, name);
		const metadata = await stat(path).catch(() => undefined);
		if (metadata !== undefined && metadata.isFile()) candidates.push({ path, modified: metadata.mtimeMs });
	}
	candidates.sort((left, right) => right.modified - left.modified);
	return candidates[0]?.path;
}
