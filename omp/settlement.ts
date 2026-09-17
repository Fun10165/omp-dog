/**
 * Deferred agentic judgment: the OMP port's replacement for the DSH verifier
 * subagent lifecycle.
 *
 * The engine still judges through exactly two kernels. The programmatic kernel
 * runs a script inline. The agentic kernel cannot start a worker (OMP exposes
 * no extension API for that), so the caller dispatches a read-only verifier
 * through the native `task` tool, the verifier writes one settlement file, and
 * the kernel later reads it back.
 *
 * A settlement is bound to the judgment it answers: the graph revision, the
 * goal, the instruction hash, and the digest of the captured bytes the
 * verifier actually judged. Bytes and identity must both still match when the
 * kernel reads it — a stale verdict can never pass, and a settlement for a
 * different instruction can never be reused.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Json } from "../core/json.ts";
import { isJsonValue, type CapturedInput, type JsonValue } from "../core/model.ts";

export const SETTLEMENT_SCHEMA_VERSION = "0.1";

export interface SettlementRecord {
	readonly schemaVersion: string;
	readonly requestId: string;
	readonly graphDigest: string;
	readonly goalId: string;
	readonly instructionHash: string;
	readonly inputSha256: string;
	readonly state: "pass" | "fail" | "inconclusive";
	readonly evidence?: JsonValue;
	readonly reason?: string;
	readonly verifierAgent?: string;
	readonly settledAt: string;
}

/** One goal that needs a dispatched verifier before the engine can judge it. */
export interface DispatchRequest {
	readonly requestId: string;
	readonly graphDigest: string;
	readonly goalId: string;
	readonly target: string;
	readonly instruction: string;
	readonly instructionHash: string;
	readonly inputSha256: string;
	/** The captured object itself: the verifier judges this, never the live tree. */
	readonly captured: CapturedInput;
	readonly packed: boolean;
	/** Materialized frozen copy the verifier reads; filled in when the brief is written. */
	readonly objectPath?: string;
	readonly objectKind?: "file" | "directory";
	readonly settlementPath: string;
	readonly requestPath: string;
}

export function instructionHashOf(instruction: string): string {
	return `sha256:${sha256Json({ instruction })}`;
}

export function dispatchDirectory(dogRoot: string): string {
	return join(dogRoot, "dispatches");
}

function requestIdOf(parts: {
	readonly graphDigest: string;
	readonly goalId: string;
	readonly instructionHash: string;
	readonly inputSha256: string;
}): string {
	return sha256Json(parts);
}

/** Build the dispatch record for one goal; the ID is derived, never random. */
export function buildDispatchRequest(options: {
	readonly dogRoot: string;
	readonly graphDigest: string;
	readonly goalId: string;
	readonly target: string;
	readonly instruction: string;
	readonly inputSha256: string;
	readonly captured: CapturedInput;
}): DispatchRequest {
	const instructionHash = instructionHashOf(options.instruction);
	const requestId = requestIdOf({
		graphDigest: options.graphDigest,
		goalId: options.goalId,
		instructionHash,
		inputSha256: options.inputSha256,
	});
	const directory = dispatchDirectory(options.dogRoot);
	return {
		requestId,
		graphDigest: options.graphDigest,
		goalId: options.goalId,
		target: options.target,
		instruction: options.instruction,
		instructionHash,
		inputSha256: options.inputSha256,
		captured: options.captured,
		packed: options.captured.packed === true,
		settlementPath: join(directory, `${requestId}.settlement.json`),
		requestPath: join(directory, `${requestId}.request.json`),
	};
}

/**
 * Persist the request so the settlement has a durable counterpart.
 *
 * Written once per judgment: its mtime is when this judgment was first handed
 * out, and the kernel refuses any settlement older than it.
 */
export async function writeDispatchRequest(request: DispatchRequest): Promise<void> {
	await mkdir(dirname(request.requestPath), { recursive: true });
	await writeFile(request.requestPath, `${JSON.stringify(request, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch(
		(error: unknown) => {
			if (!isAlreadyExists(error)) throw error;
		},
	);
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

/** mtime in epoch millis, or undefined when the path does not exist. */
export async function modifiedAtMs(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return undefined;
	}
}

/** Read one settlement, fail-closed on shape: anything unparsable reads as absent. */
export async function readSettlement(path: string): Promise<SettlementRecord | undefined> {
	let source: string;
	try {
		source = await readFile(path, "utf8");
	} catch {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(source);
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const state = record.state;
	if (state !== "pass" && state !== "fail" && state !== "inconclusive") return undefined;
	if (typeof record.inputSha256 !== "string" || typeof record.instructionHash !== "string") return undefined;
	if (typeof record.requestId !== "string" || typeof record.goalId !== "string") return undefined;
	return {
		schemaVersion: typeof record.schemaVersion === "string" ? record.schemaVersion : SETTLEMENT_SCHEMA_VERSION,
		requestId: record.requestId,
		graphDigest: typeof record.graphDigest === "string" ? record.graphDigest : "",
		goalId: record.goalId,
		instructionHash: record.instructionHash,
		inputSha256: record.inputSha256,
		state,
		...(isJsonValue(record.evidence) ? { evidence: record.evidence } : {}),
		...(typeof record.reason === "string" ? { reason: record.reason } : {}),
		...(typeof record.verifierAgent === "string" ? { verifierAgent: record.verifierAgent } : {}),
		settledAt: typeof record.settledAt === "string" ? record.settledAt : "",
	};
}

/** Digest the bytes a verifier was handed, so freshness is checked against content. */
export async function sha256OfFile(path: string): Promise<string | undefined> {
	try {
		return createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
	} catch {
		return undefined;
	}
}

/** Why a settlement on disk does not answer the judgment it was looked up for. */
export type SettlementRejection =
	| "absent"
	| "unparsable"
	| "different-bytes"
	| "different-instruction"
	| "predates-request";

export type SettlementResolution =
	| { readonly ok: true; readonly record: SettlementRecord }
	| {
			readonly ok: false;
			readonly reason: SettlementRejection;
			readonly settled?: string;
			readonly current?: string;
	  };

/**
 * The single rule for "does this settlement answer this judgment".
 *
 * The dispatch pre-flight and the agentic kernel must reach the same verdict: if
 * the pre-flight reports a goal as settled, the kernel has to accept that
 * settlement, and if the kernel would reject it the pre-flight has to ask for a
 * fresh dispatch. Two copies of this rule drifted apart once already, and the
 * symptom was a goal that could never leave `needs_human`: the pre-flight kept
 * reporting nothing to dispatch while the kernel kept refusing to judge.
 *
 * A settlement counts only when it binds the same bytes and the same instruction
 * and was written after the request that asked for it. That request is written
 * once, so its mtime is when the judgment was first handed out; a settlement
 * older than it cannot be an answer to it.
 */
export async function resolveSettlement(options: {
	readonly settlementPath: string;
	readonly requestPath: string;
	readonly inputSha256: string;
	readonly instructionHash: string;
}): Promise<SettlementResolution> {
	const record = await readSettlement(options.settlementPath);
	if (record === undefined) {
		const present = (await modifiedAtMs(options.settlementPath)) !== undefined;
		return { ok: false, reason: present ? "unparsable" : "absent" };
	}
	if (record.inputSha256 !== options.inputSha256) {
		return { ok: false, reason: "different-bytes", settled: record.inputSha256, current: options.inputSha256 };
	}
	if (record.instructionHash !== options.instructionHash) {
		return { ok: false, reason: "different-instruction" };
	}
	const dispatchedAt = await modifiedAtMs(options.requestPath);
	const settledAt = await modifiedAtMs(options.settlementPath);
	if (dispatchedAt !== undefined && settledAt !== undefined && settledAt < dispatchedAt) {
		return { ok: false, reason: "predates-request" };
	}
	return { ok: true, record };
}
