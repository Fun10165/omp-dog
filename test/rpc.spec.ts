/** The RPC client against a stand-in server: framing, correlation, host tools, prompts. */

import { chmod, readFile, realpath, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcSession, type HostToolCall, type RpcFrame } from "../omp/rpc.ts";
import { temporaryRoot } from "./helpers.ts";

const FAKE_OMP = fileURLToPath(new URL("./fixtures/fake-omp.mjs", import.meta.url));
const roots: string[] = [];
const openSessions: RpcSession[] = [];

async function fakeSession(env: Readonly<Record<string, string>> = {}): Promise<{ session: RpcSession; root: string }> {
	const root = await temporaryRoot();
	roots.push(root);
	await chmod(FAKE_OMP, 0o755);
	const session = await RpcSession.start({
		command: [FAKE_OMP, "--mode", "rpc"],
		cwd: root,
		env,
		startupTimeoutMs: 15_000,
	});
	openSessions.push(session);
	return { session, root };
}

afterEach(async () => {
	await Promise.all(openSessions.splice(0).map((session) => session.close()));
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("rpc session", () => {
	it("correlates responses by id and forwards frames to subscribers", async () => {
		const { session } = await fakeSession();
		const frames: RpcFrame[] = [];
		const unsubscribe = session.on("response", (frame) => frames.push(frame));
		await expect(session.request("get_state")).resolves.toEqual({});
		unsubscribe();
		expect(frames.map((frame) => frame.command)).toEqual(["get_state"]);
		expect(session.pid).toBeGreaterThan(0);
	});

	it("round-trips a host tool call and completes the prompt", async () => {
		const { session } = await fakeSession({ FAKE_VERDICT: '{"verdict":"pass","evidence":{"bytes":12}}' });
		const calls: HostToolCall[] = [];
		const updates: string[] = [];
		let answered: (() => void) | undefined;
		const called = new Promise<void>((resolve) => {
			answered = resolve;
		});
		await session.registerHostTools(
			[
				{
					name: "dog_submit_verdict",
					description: "submit a verdict",
					parameters: { type: "object", properties: {}, additionalProperties: false },
					loadMode: "essential",
				},
			],
			async (call, context) => {
				calls.push(call);
				context.update("recording");
				updates.push("recording");
				answered?.();
				return { text: "recorded" };
			},
		);
		const settled = session.prompt("judge the object");
		await called;
		expect(calls[0]?.toolName).toBe("dog_submit_verdict");
		expect(calls[0]?.arguments).toEqual({ verdict: "pass", evidence: { bytes: 12 } });
		expect(updates).toEqual(["recording"]);
		const result = await settled;
		expect(result.type).toBe("prompt_result");
	});

	it("rejects a command that never answers", async () => {
		const { session } = await fakeSession({ FAKE_IGNORE: "get_state" });
		await expect(session.request("get_state", {}, { timeoutMs: 100 })).rejects.toThrow(/timed out/);
	});

	it("records the argv and working directory it was started with", async () => {
		const recordRoot = await temporaryRoot();
		roots.push(recordRoot);
		const record = join(recordRoot, "record.json");
		const { session, root } = await fakeSession({ FAKE_RECORD: record });
		await session.close();
		const written = JSON.parse(await readFile(record, "utf8")) as { argv: string[]; cwd: string };
		expect(written.argv).toEqual(["--mode", "rpc"]);
		expect(written.cwd).toBe(await realpath(root));
	});
});
