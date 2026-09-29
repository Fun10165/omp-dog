/** Test fixtures: graph builders, kernel stubs, and an engine bound to a temporary store. */

import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DogEngine } from "../core/engine.ts";
import type { DogConfig, DogGraphInput, GoalNodeInput, TargetSpec, VerifierShape } from "../core/model.ts";
import { DogRepository } from "../core/storage.ts";
import type {
	AgenticRunner,
	ProgrammaticRunner,
	Verdict,
	VerifierExecutionEnv,
	VerifierTarget,
} from "../core/verifiers.ts";

export async function temporaryRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), "omp-dog-"));
}

/** Let a fixed amount of time pass (tests only). */
export function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Create a throwaway script library under the fixture root. */
export async function ensureScripts(root: string, names: readonly string[] = ["file-non-empty"]): Promise<void> {
	const scripts = join(root, "scripts");
	await mkdir(scripts, { recursive: true });
	for (const name of names) {
		const path = join(scripts, name);
		await writeFile(
			path,
			'#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ verdict: "pass", evidence: { script: true } }))\n',
		);
		await chmod(path, 0o755);
	}
}

export function mkConfig(root: string, scripts: string): DogConfig {
	return {
		workspaceRoot: root,
		scriptsDirectory: scripts,
		storageDirectory: "dog",
		maxGraphNodes: 64,
		maxExpressionNodes: 128,
		maxExpressionDepth: 16,
		maxSandboxBytes: 1024 * 1024,
		allowPartialRoot: false,
		maxConcurrentVerifications: 4,
	};
}

export function leafNode(
	overrides: Partial<{
		title: string;
		constraint: "hard" | "soft";
		target: string | TargetSpec;
		verifier: VerifierShape;
	}> = {},
): GoalNodeInput {
	const { target = "artifact.txt", ...rest } = overrides;
	return {
		kind: "leaf",
		title: "leaf",
		constraint: "hard",
		target: typeof target === "string" ? { kind: "path", path: target } : target,
		verifier: { mode: "programmatic", script: "file-non-empty" },
		...rest,
	} as GoalNodeInput;
}

export function compositeNode(
	completion: object,
	overrides: Partial<{
		title: string;
		constraint: "hard" | "soft";
		target: string | TargetSpec;
		verifier: VerifierShape;
	}> = {},
): GoalNodeInput {
	const { target = "artifact.txt", ...rest } = overrides;
	return {
		kind: "composite",
		title: "root",
		constraint: "hard",
		target: typeof target === "string" ? { kind: "path", path: target } : target,
		completion: completion as GoalNodeInput["completion"],
		...rest,
	} as GoalNodeInput;
}

export function graph(
	nodes: Record<string, GoalNodeInput>,
	contains: DogGraphInput["contains"],
	id = "demo",
): DogGraphInput {
	return { schemaVersion: "0.9", id, root: "root", nodes, contains, dependsOn: [] };
}

/** Fake programmatic kernel: succeeds without executing a real script. */
export function stubProgrammatic(
	verdict: Verdict = { state: "pass", evidence: { stubbed: true } },
): ProgrammaticRunner {
	return async () => verdict;
}

export function stubAgentic(verdict: Verdict = { state: "pass", evidence: { stubbed: true } }): AgenticRunner {
	return async () => verdict;
}

/** An agentic kernel that records every call and answers from the supplied table. */
export function recordingAgentic(answers: (target: VerifierTarget) => Verdict | Promise<Verdict>): {
	runner: AgenticRunner;
	calls: Array<{ target: VerifierTarget; goal: string; workspace: string; env: VerifierExecutionEnv }>;
} {
	const calls: Array<{ target: VerifierTarget; goal: string; workspace: string; env: VerifierExecutionEnv }> = [];
	const runner: AgenticRunner = async (goal, workspace, target, env) => {
		calls.push({ target, goal, workspace, env });
		return answers(target);
	};
	return { runner, calls };
}

export interface EngineFixture {
	readonly engine: DogEngine;
	readonly repository: DogRepository;
	readonly root: string;
}

export async function makeFixture(
	root: string,
	options: {
		readonly programmatic?: ProgrammaticRunner;
		readonly agentic?: AgenticRunner;
		readonly concurrency?: number;
		readonly now?: () => Date;
	} = {},
): Promise<EngineFixture> {
	const scripts = join(root, "scripts");
	const config = mkConfig(root, scripts);
	const repository = new DogRepository(join(root, ".omp", "dog"));
	const engine = new DogEngine({
		config,
		repository,
		programmatic: options.programmatic ?? stubProgrammatic(),
		agentic: options.agentic ?? stubAgentic(),
		concurrency: () => options.concurrency ?? config.maxConcurrentVerifications,
		...(options.now === undefined ? {} : { now: options.now }),
	});
	return { engine, repository, root };
}
