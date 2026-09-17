/**
 * Adoption records: who a run's verdict came from.
 *
 * A DoG run's promise is that every goal has its own judge, but the engine's
 * `GoalResult` has no field for that — on DSH a live agent session was *bound* to
 * a goal (`goals[].agentSessions[]`), and OMP exposes no equivalent API, so the
 * port had no provenance at all: the run could say a goal passed but not who
 * judged it.
 *
 * This module closes that gap from the adapter's side. The moment the agentic
 * kernel accepts a settlement, the adoption is recorded next to the dispatches.
 *
 * The verifier field is **self-reported**: the settlement records the id the
 * subagent wrote for itself, and nothing authenticates it. This is provenance,
 * not identity — the same trust boundary the settlement carries (see README).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256Json } from "../core/json.ts";

export interface VerifierBinding {
	readonly runId: string;
	readonly goalId: string;
	readonly requestId: string;
	readonly settlementPath: string;
	readonly graphDigest: string;
	/** The verdict that was adopted. */
	readonly state: string;
	/** As reported by the settlement itself; not an authenticated identity. */
	readonly reportedVerifier?: string;
	readonly adoptedAt: string;
}

export function bindingDirectory(dogRoot: string): string {
	return join(dogRoot, "verifier-bindings");
}

/** Keyed like the engine's own records: a digest of the identity, not a path. */
function bindingPath(dogRoot: string, runId: string, goalId: string): string {
	return join(bindingDirectory(dogRoot), `${sha256Json({ runId, goalId })}.json`);
}

/** Record one adoption. Never overwrites an earlier adoption of the same goal. */
export async function writeVerifierBinding(dogRoot: string, binding: VerifierBinding): Promise<void> {
	await mkdir(bindingDirectory(dogRoot), { recursive: true });
	const path = bindingPath(dogRoot, binding.runId, binding.goalId);
	await writeFile(path, `${JSON.stringify(binding, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch(
		(error: unknown) => {
			if (!isAlreadyExists(error)) throw error;
		},
	);
}

/** Read the adoption record for one goal of one run, if the verdict was adopted. */
export async function readVerifierBinding(
	dogRoot: string,
	runId: string,
	goalId: string,
): Promise<VerifierBinding | undefined> {
	let source: string;
	try {
		source = await readFile(bindingPath(dogRoot, runId, goalId), "utf8");
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
	if (typeof record.runId !== "string" || typeof record.goalId !== "string") return undefined;
	if (typeof record.state !== "string" || typeof record.adoptedAt !== "string") return undefined;
	return {
		runId: record.runId,
		goalId: record.goalId,
		requestId: typeof record.requestId === "string" ? record.requestId : "",
		settlementPath: typeof record.settlementPath === "string" ? record.settlementPath : "",
		graphDigest: typeof record.graphDigest === "string" ? record.graphDigest : "",
		state: record.state,
		...(typeof record.reportedVerifier === "string" ? { reportedVerifier: record.reportedVerifier } : {}),
		adoptedAt: record.adoptedAt,
	};
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
