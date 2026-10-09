/** Assembly: one store, one engine, and the two kernels bound to one project. */

import { join } from "node:path";
import { DogEngine } from "../core/engine.ts";
import { DogRepository } from "../core/storage.ts";
import { PROJECT_ROOT } from "./brief.ts";
import { VERIFIER_SYSTEM_PROMPT_FILE } from "./brief.ts";
import { dogRootFor, engineConfigFor } from "./config.ts";
import { createProgrammaticRunner } from "./programmatic.ts";
import type { RpcFrame } from "./rpc.ts";
import { createRpcAgenticRunner } from "./verifier.ts";

export interface DogRuntimeOptions {
	readonly projectDir: string;
	readonly ompBin: string;
	readonly concurrency: number;
	readonly model?: string;
	readonly thinking?: string;
	readonly verifierTimeoutMs?: number;
	/** Ceiling for one frozen target tree; bigger pipelines need more than the 64 MiB default. */
	readonly maxSandboxBytes?: number;
	/** One callback per verifier frame, for progress surfaces. */
	readonly onVerifierFrame?: (goalId: string, frame: RpcFrame) => void;
}

export interface DogRuntime {
	readonly projectDir: string;
	readonly repository: DogRepository;
	readonly engine: DogEngine;
}

/** The script library ships with this project. */
export const SCRIPT_LIBRARY = join(PROJECT_ROOT, "scripts");

export function createDogRuntime(options: DogRuntimeOptions): DogRuntime {
	const repository = new DogRepository(dogRootFor(options.projectDir));
	const agentic = createRpcAgenticRunner({
		ompBin: options.ompBin,
		systemPromptPath: VERIFIER_SYSTEM_PROMPT_FILE,
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.thinking === undefined ? {} : { thinking: options.thinking }),
		...(options.verifierTimeoutMs === undefined ? {} : { timeoutMs: options.verifierTimeoutMs }),
		sessionDirectory: (runId, goalId) => join(repository.verificationDirectory(runId, goalId), "session"),
		...(options.onVerifierFrame === undefined ? {} : { onFrame: options.onVerifierFrame }),
	});
	const engine = new DogEngine({
		config: engineConfigFor({
			projectDir: options.projectDir,
			scriptsDirectory: SCRIPT_LIBRARY,
			concurrency: options.concurrency,
			...(options.maxSandboxBytes === undefined ? {} : { maxSandboxBytes: options.maxSandboxBytes }),
		}),
		repository,
		programmatic: createProgrammaticRunner(SCRIPT_LIBRARY),
		agentic,
		concurrency: () => options.concurrency,
	});
	return { projectDir: options.projectDir, repository, engine };
}
