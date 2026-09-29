/** The agentic kernel: one RPC verifier session per judgment, verdict by host tool. */

import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRpcAgenticRunner } from "../omp/verifier.ts";
import { VERIFIER_SYSTEM_PROMPT_FILE } from "../omp/brief.ts";
import type { AgenticRunner } from "../core/verifiers.ts";
import { temporaryRoot } from "./helpers.ts";

const FAKE_OMP = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));
const roots: string[] = [];

async function workspace(files: Record<string, string> = { "artifact.txt": "smoke artifact\n" }): Promise<string> {
	const root = await temporaryRoot();
	roots.push(root);
	await chmod(FAKE_OMP, 0o755);
	for (const [name, content] of Object.entries(files)) {
		await mkdir(join(root, name, ".."), { recursive: true });
		await writeFile(join(root, name), content);
	}
	return root;
}

function kernel(
	sessionRoot: string,
	env: Readonly<Record<string, string>>,
	overrides: { readonly timeoutMs?: number; readonly graceMs?: number } = {},
): AgenticRunner {
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	return createRpcAgenticRunner({
		ompBin: FAKE_OMP,
		systemPromptPath: VERIFIER_SYSTEM_PROMPT_FILE,
		sessionDirectory: (runId, goalId) => join(sessionRoot, runId, goalId),
		...overrides,
	});
}

afterEach(async () => {
	for (const key of ["FAKE_VERDICT", "FAKE_NO_VERDICT", "FAKE_RECORD", "FAKE_WRITE_SESSION", "FAKE_TURN_MS"]) {
		delete process.env[key];
	}
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("agentic kernel", () => {
	it("adopts the verdict a verifier session submits", async () => {
		const root = await workspace();
		const sessionRoot = join(root, "sessions");
		const runner = kernel(sessionRoot, {
			FAKE_VERDICT: '{"verdict":"fail","evidence":{"quote":"no such line"},"reason":"missing"}',
			FAKE_WRITE_SESSION: "1",
		});
		const verdict = await runner(
			"the file must contain the exact line: smoke artifact",
			root,
			{
				goalId: "leaf",
				title: "leaf title",
				target: "artifact.txt",
				isDirectory: false,
				byteLength: 15,
				sha256: "abc",
			},
			{ runId: "run-1", goalId: "leaf" },
		);
		expect(verdict.state).toBe("fail");
		expect(verdict.reason).toBe("missing");
		expect(verdict.evidence).toEqual({ quote: "no such line" });
		expect(verdict.sessionFile).toBe(join(sessionRoot, "run-1", "leaf", "fake-session.jsonl"));
	});

	it("passes the frozen object, the background, and the goal in the brief", async () => {
		const root = await workspace();
		const sessionRoot = join(root, "sessions");
		const record = join(root, "record.json");
		const runner = kernel(sessionRoot, {
			FAKE_VERDICT: '{"verdict":"pass","evidence":{}}',
			FAKE_RECORD: record,
		});
		await runner(
			"the file must contain the exact line: smoke artifact",
			root,
			{
				goalId: "leaf",
				title: "smoke leaf",
				target: "artifact.txt",
				isDirectory: false,
				background: {
					general: "# DoG\n\nDoG turns a non-formal goal into verified subgoals.",
					specific: "# This submission\n\nWe are judging the graph that gates report.md.",
				},
			},
			{ runId: "run-2", goalId: "leaf" },
		);
		const written = JSON.parse(await readFile(record, "utf8")) as { argv: string[]; cwd: string; prompt: string };
		expect(written.cwd).toBe(await realpath(root));
		for (const flag of ["--no-extensions", "--no-skills", "--no-ui"]) expect(written.argv).toContain(flag);
		expect(written.argv[written.argv.indexOf("--tools") + 1]).toBe("read,grep,glob,find");
		expect(written.argv[written.argv.indexOf("--session-dir") + 1]).toBe(join(sessionRoot, "run-2", "leaf"));
		const systemPrompt = written.argv[written.argv.indexOf("--append-system-prompt") + 1];
		expect(systemPrompt).toContain("DoG verifier");
		// The background precedes the goal, in tier order, and the goal survives verbatim.
		expect(written.prompt).toContain("DoG turns a non-formal goal into verified subgoals.");
		expect(written.prompt).toContain("We are judging the graph that gates report.md.");
		const generalAt = written.prompt.indexOf("the judgment contract every verifier works under");
		const specificAt = written.prompt.indexOf("what this submission is");
		const goalAt = written.prompt.indexOf("Goal (the only standard");
		// Both labels must actually be present: an absent label would make a bare
		// `indexOf` comparison pass by accident and hide a broken brief.
		expect(generalAt).toBeGreaterThanOrEqual(0);
		expect(specificAt).toBeGreaterThanOrEqual(0);
		expect(goalAt).toBeGreaterThanOrEqual(0);
		expect(generalAt).toBeLessThan(specificAt);
		expect(specificAt).toBeLessThan(goalAt);
	});

	it("settles inconclusive when a finished session never submits a verdict", async () => {
		const root = await workspace();
		const runner = kernel(join(root, "sessions"), { FAKE_NO_VERDICT: "1" }, { graceMs: 50 });
		const verdict = await runner(
			"judge it",
			root,
			{
				goalId: "leaf",
				title: "leaf",
				target: "artifact.txt",
				isDirectory: false,
			},
			{ runId: "run-3", goalId: "leaf" },
		);
		expect(verdict.state).toBe("inconclusive");
		expect(verdict.reason).toMatch(/without submitting/);
	});

	it("settles inconclusive when the verdict budget runs out", async () => {
		const root = await workspace();
		const runner = kernel(join(root, "sessions"), { FAKE_NO_VERDICT: "1", FAKE_TURN_MS: "60000" }, { timeoutMs: 200 });
		const started = Date.now();
		const verdict = await runner(
			"judge it",
			root,
			{
				goalId: "leaf",
				title: "leaf",
				target: "artifact.txt",
				isDirectory: false,
			},
			{ runId: "run-4", goalId: "leaf" },
		);
		expect(verdict.state).toBe("inconclusive");
		expect(verdict.reason).toMatch(/timed out/);
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
