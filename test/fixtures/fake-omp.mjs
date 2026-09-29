#!/usr/bin/env node
/**
 * Minimal stand-in for `omp --mode rpc`, covering exactly the frames this
 * project's client uses: ready, set_host_tools, prompt, prompt_result,
 * host_tool_call, host_tool_result, abort.
 *
 * Knobs (environment):
 *   FAKE_RECORD        path to write {argv, cwd} into
 *   FAKE_VERDICT       JSON arguments the verifier "submits"
 *   FAKE_NO_VERDICT=1  finish the turn without submitting anything
 *   FAKE_TURN_MS       delay before the turn completes
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const recordPath = process.env.FAKE_RECORD;
if (recordPath !== undefined && recordPath.length > 0) {
	writeFileSync(recordPath, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
}

const verdictArguments = process.env.FAKE_VERDICT;
const submitNothing = process.env.FAKE_NO_VERDICT === "1";
const turnMs = Number(process.env.FAKE_TURN_MS ?? "0");
const ignoredCommand = process.env.FAKE_IGNORE ?? "";
const sessionDirectory = process.argv[process.argv.indexOf("--session-dir") + 1];
if (process.env.FAKE_WRITE_SESSION === "1" && sessionDirectory !== undefined) {
	mkdirSync(sessionDirectory, { recursive: true });
	writeFileSync(join(sessionDirectory, "fake-session.jsonl"), '{"type":"session"}\n');
}

function write(frame) {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function respond(id, command, data) {
	write({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
}

let promptId = null;
let buffer = "";

write({
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: 1048576,
	maxReassembledFrameBytes: 67108864,
});

function finishTurn() {
	if (promptId !== null)
		write({ type: "prompt_result", id: promptId, agentInvoked: true, status: "completed", sessionSettled: true });
	promptId = null;
}

function handle(frame) {
	if (ignoredCommand.length > 0 && frame.type === ignoredCommand) return;
	switch (frame.type) {
		case "set_host_tools":
			respond(frame.id, "set_host_tools", { toolNames: (frame.tools ?? []).map((tool) => tool.name) });
			return;
		case "prompt": {
			promptId = frame.id ?? null;
			respond(frame.id, "prompt", { agentInvoked: true });
			setTimeout(() => {
				if (submitNothing || verdictArguments === undefined) {
					finishTurn();
					return;
				}
				write({
					type: "host_tool_call",
					id: "host_1",
					toolCallId: "toolu_1",
					toolName: "dog_submit_verdict",
					arguments: JSON.parse(verdictArguments),
				});
			}, turnMs);
			return;
		}
		case "host_tool_result":
			setTimeout(finishTurn, turnMs);
			return;
		case "abort":
			respond(frame.id, "abort", {});
			finishTurn();
			return;
		default:
			respond(frame.id, frame.type, {});
	}
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		if (line.trim().length > 0) {
			try {
				handle(JSON.parse(line));
			} catch {
				write({ type: "response", command: "parse", success: false, error: "malformed frame" });
			}
		}
		newline = buffer.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));
