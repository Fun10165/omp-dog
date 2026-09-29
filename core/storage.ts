/** Frozen captures, immutable graph revisions, run records, and per-verification objects. */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256Json } from "./json.ts";
import { withFileLock } from "./lockfile.ts";
import {
	DOG_SCHEMA_VERSION,
	type AcceptancePlan,
	type CapturedInput,
	type CompiledGraph,
	type DogRun,
} from "./model.ts";

export interface CapturedInputFile {
	readonly input: CapturedInput;
}

/** Where one goal's verifier may look: the frozen object, plus room for its session. */
export interface VerificationWorkspace {
	readonly directory: string;
	readonly workspace: string;
	readonly objectPath: string;
	readonly inputPath: string;
	readonly sessionDirectory: string;
}

export class DogRepository {
	readonly rootPath: string;
	private readonly runMutationTails = new Map<string, Promise<void>>();

	constructor(rootPath: string) {
		this.rootPath = rootPath;
	}

	async initialize(): Promise<void> {
		await Promise.all([
			mkdir(join(this.rootPath, "graphs"), { recursive: true }),
			mkdir(join(this.rootPath, "graph-index"), { recursive: true }),
			mkdir(join(this.rootPath, "runs"), { recursive: true }),
			mkdir(join(this.rootPath, "captures"), { recursive: true }),
			mkdir(join(this.rootPath, "verifications"), { recursive: true }),
			mkdir(join(this.rootPath, "locks"), { recursive: true }),
		]);
	}

	// ---- graphs -------------------------------------------------------------

	/** Persist one immutable compiled graph revision and its ID index. */
	async saveGraph(compiled: CompiledGraph): Promise<void> {
		await this.initialize();
		await withFileLock(join(this.rootPath, "locks", `graph-${compiled.graphDigest}.lock`), async () => {
			await atomicWriteJson(join(this.rootPath, "graphs", `${compiled.graphDigest}.json`), {
				schemaVersion: DOG_SCHEMA_VERSION,
				graphDigest: compiled.graphDigest,
				input: compiled.input,
				acceptancePlans: compiled.acceptancePlans,
			});
			await atomicWriteJson(join(this.rootPath, "graph-index", `${safeKey(compiled.input.id)}.json`), {
				graphId: compiled.input.id,
				graphDigest: compiled.graphDigest,
			});
		});
	}

	/** Load the latest graph revision for a graph ID. */
	async loadGraph(graphId: string): Promise<CompiledGraph> {
		const index = await readJson<{ graphId: string; graphDigest: string }>(
			join(this.rootPath, "graph-index", `${safeKey(graphId)}.json`),
		);
		if (index.graphId !== graphId || !isDigest(index.graphDigest)) {
			throw new Error(`invalid graph index for ${graphId}`);
		}
		const record = await readJson<{
			schemaVersion: string;
			graphDigest: string;
			input: CompiledGraph["input"];
			acceptancePlans: Record<string, AcceptancePlan>;
		}>(join(this.rootPath, "graphs", `${index.graphDigest}.json`));
		if (sha256Json({ input: record.input, acceptancePlans: record.acceptancePlans }) !== index.graphDigest) {
			throw new Error(`invalid persisted graph record ${index.graphDigest}`);
		}
		return { input: record.input, graphDigest: record.graphDigest, acceptancePlans: record.acceptancePlans };
	}

	/** Enumerate immutable graph revisions, newest ID first. */
	async listGraphs(): Promise<readonly CompiledGraph[]> {
		await this.initialize();
		const entries = await readdir(join(this.rootPath, "graphs"), { withFileTypes: true });
		const graphs: CompiledGraph[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
			const digest = entry.name.slice(0, -".json".length);
			const record = await readJson<{
				graphDigest: string;
				input: CompiledGraph["input"];
				acceptancePlans: Record<string, AcceptancePlan>;
			}>(join(this.rootPath, "graphs", entry.name));
			graphs.push({
				input: record.input,
				graphDigest: record.graphDigest ?? digest,
				acceptancePlans: record.acceptancePlans,
			});
		}
		return graphs.sort((left, right) => left.input.id.localeCompare(right.input.id));
	}

	// ---- runs ---------------------------------------------------------------

	async saveRun(run: DogRun): Promise<void> {
		await this.initialize();
		await withFileLock(join(this.rootPath, "locks", `run-${safeKey(run.runId)}.lock`), () =>
			atomicWriteJson(join(this.rootPath, "runs", `${safeKey(run.runId)}.json`), run),
		);
	}

	/** Atomically read, transform, and replace one run record. */
	async updateRun(runId: string, update: (run: DogRun) => DogRun): Promise<DogRun> {
		const previous = this.runMutationTails.get(runId) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(
			() => gate,
			() => gate,
		);
		this.runMutationTails.set(runId, tail);
		await previous.catch(() => undefined);
		try {
			return await withFileLock(join(this.rootPath, "locks", `run-${safeKey(runId)}.lock`), async () => {
				const current = await this.loadRun(runId);
				const next = update(current);
				if (
					next.runId !== current.runId ||
					next.graphId !== current.graphId ||
					next.graphDigest !== current.graphDigest
				) {
					throw new Error(`run update cannot change identity for ${runId}`);
				}
				await atomicWriteJson(join(this.rootPath, "runs", `${safeKey(runId)}.json`), next);
				return next;
			});
		} finally {
			release();
			if (this.runMutationTails.get(runId) === tail) this.runMutationTails.delete(runId);
		}
	}

	async loadRun(runId: string): Promise<DogRun> {
		return readJson<DogRun>(join(this.rootPath, "runs", `${safeKey(runId)}.json`));
	}

	/** Enumerate persisted run records, newest update first. */
	async listRuns(): Promise<readonly DogRun[]> {
		await this.initialize();
		const entries = await readdir(join(this.rootPath, "runs"), { withFileTypes: true });
		const runs: DogRun[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			try {
				runs.push(await readJson<DogRun>(join(this.rootPath, "runs", entry.name)));
			} catch {
				continue;
			}
		}
		return runs.sort((left, right) => {
			const byTime = right.updatedAt.localeCompare(left.updatedAt);
			return byTime === 0 ? left.runId.localeCompare(right.runId) : byTime;
		});
	}

	/** The most recently updated terminal run of a graph: the inheritance source. */
	async loadLatestSettledRun(graphId: string): Promise<DogRun | undefined> {
		const runs = await this.listRuns();
		return runs.find((run) => run.graphId === graphId && run.state !== "running");
	}

	/** Mark every still-running record of one graph as superseded by a new run. */
	async supersedeRunningRuns(graphId: string, nextRunId: string, nowIso: string): Promise<void> {
		for (const prior of await this.listRuns()) {
			if (prior.graphId !== graphId || prior.state !== "running" || prior.runId === nextRunId) continue;
			await this.updateRun(prior.runId, (current) => ({
				...current,
				state: "cancelled",
				rootState: "cancelled",
				runtimeWarning: `superseded by run ${nextRunId}`,
				updatedAt: nowIso,
			}));
		}
	}

	// ---- captures -----------------------------------------------------------

	/** Store captured bytes and their manifest under content identity. */
	async putCapture(input: CapturedInput, bytes: Uint8Array | undefined): Promise<void> {
		await this.initialize();
		const key = capturedKey(input.digest);
		if (bytes !== undefined) await atomicWrite(join(this.rootPath, "captures", `${key}.bin`), bytes);
		await atomicWriteJson(join(this.rootPath, "captures", `${key}.json`), input);
	}

	/** Read and re-hash one captured input. */
	async readCapture(input: CapturedInput): Promise<Uint8Array> {
		if (!input.exists) throw new Error(`captured input ${input.digest} represents a missing file`);
		const bytes = await readFile(join(this.rootPath, "captures", `${capturedKey(input.digest)}.bin`));
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (digest !== input.sha256 || bytes.byteLength !== input.byteLength) {
			throw new Error(`captured input integrity mismatch for ${input.digest}`);
		}
		return bytes;
	}

	/** Directory holding one goal's frozen object and its verifier session. */
	verificationDirectory(runId: string, goalId: string): string {
		return join(this.rootPath, "verifications", safeKey(runId), safeKey(goalId));
	}

	/**
	 * The single place a verifier may look: the frozen bytes of one goal, written
	 * where the kernel can read them (a directory capture is also unpacked).
	 */
	async prepareVerification(runId: string, goalId: string, plan: AcceptancePlan): Promise<VerificationWorkspace> {
		const directory = this.verificationDirectory(runId, goalId);
		const workspace = join(directory, "object");
		const sessionDirectory = join(directory, "session");
		const inputPath = join(workspace, plan.target);
		await mkdir(dirname(inputPath), { recursive: true });
		const input = plan.input;
		if (input === undefined || !input.exists) {
			return { directory, workspace, objectPath: inputPath, inputPath, sessionDirectory };
		}
		const bytes = await this.readCapture(input);
		if (input.packed !== true) {
			await writeFile(inputPath, bytes);
			return { directory, workspace, objectPath: inputPath, inputPath, sessionDirectory };
		}
		const archive = `${inputPath}.tar`;
		await writeFile(archive, bytes);
		await mkdir(inputPath, { recursive: true });
		execFileSync("tar", ["-xf", archive, "-C", inputPath], { stdio: "pipe" });
		return { directory, workspace, objectPath: inputPath, inputPath: archive, sessionDirectory };
	}

	/** Remove one goal's verification directory (its evidence lives in the run record). */
	async dropVerification(runId: string, goalId: string): Promise<void> {
		await rm(this.verificationDirectory(runId, goalId), { recursive: true, force: true });
	}
}

/** Resolve one workspace-relative path to an absolute path, never accepting escapes. */
export async function resolveWorkspacePath(workspaceRoot: string, relPath: string): Promise<string> {
	if (!isAbsolute(workspaceRoot)) throw new Error("workspaceRoot must be absolute");
	if (relPath === "") throw new Error("empty workspace path has no single file to resolve");
	if (isAbsolute(relPath)) throw new Error("workspace path must be relative");
	const rootPath = resolve(workspaceRoot);
	const lexicalCandidate = resolve(rootPath, relPath);
	const lexicalRelative = relative(rootPath, lexicalCandidate);
	if (!isWithinRoot(lexicalRelative)) throw new Error(`workspace path ${relPath} escapes its configured root`);
	const rootStat = await stat(rootPath);
	if (!rootStat.isDirectory()) throw new Error(`workspace root ${workspaceRoot} is not a directory`);
	const canonicalRoot = await realpath(rootPath);
	return resolveBoundPath(canonicalRoot, lexicalRelative);
}

/**
 * Capture one target: a single file, or a directory packed into a .tar
 * (relative structure preserved). Roots are tried in order; a non-missing error
 * (escape, wrong type, size) aborts immediately, while a target absent from
 * every root settles as `missing`.
 */
export async function captureWorkspaceTarget(
	captureRoots: readonly string[],
	target: string,
	maxBytes: number,
	repository: DogRepository,
): Promise<CapturedInputFile> {
	for (const root of captureRoots) {
		try {
			const absolutePath = await resolveWorkspacePath(root, target);
			const metadata = await stat(absolutePath);
			let bytes: Uint8Array;
			let packed = false;
			if (metadata.isDirectory()) {
				assertTreeSafe(resolve(root), absolutePath);
				bytes = execFileSync("tar", ["-C", resolve(root), "-cf", "-", target], { maxBuffer: maxBytes * 4 });
				packed = true;
			} else if (metadata.isFile()) {
				bytes = await readFile(absolutePath);
			} else {
				throw new Error(`target ${target} is not a regular file or directory`);
			}
			if (bytes.byteLength > maxBytes) throw new Error(`target ${target} exceeds ${maxBytes} bytes`);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const input: CapturedInput = {
				path: target,
				digest: `sha256:${sha256}`,
				exists: true,
				byteLength: bytes.byteLength,
				sha256,
				...(packed ? { packed: true } : {}),
			};
			await repository.putCapture(input, bytes);
			return { input };
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}
	const input: CapturedInput = {
		path: target,
		digest: `missing:${sha256Json({ path: target })}`,
		exists: false,
		byteLength: 0,
		sha256: "",
	};
	await repository.putCapture(input, undefined);
	return { input };
}

/** Reject symbolic links anywhere in the tree before packing (tar would carry them over). */
function assertTreeSafe(rootPath: string, dirPath: string): void {
	for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
		const child = join(dirPath, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`target tree contains a symbolic link: ${relative(rootPath, child)}`);
		if (entry.isDirectory()) assertTreeSafe(rootPath, child);
	}
}

function capturedKey(digest: string): string {
	return digest.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}

function safeKey(value: string): string {
	return sha256Json(value);
}

function isWithinRoot(relativePath: string): boolean {
	return relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
}

async function resolveBoundPath(rootPath: string, relativePath: string): Promise<string> {
	const segments = relativePath.length === 0 ? [] : relativePath.split(sep);
	let current = rootPath;
	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		if (segment === undefined) continue;
		const candidate = join(current, segment);
		let metadata;
		try {
			metadata = await lstat(candidate);
		} catch (error) {
			if (!isMissing(error)) throw error;
			return join(current, ...segments.slice(index));
		}
		if (metadata.isSymbolicLink()) {
			try {
				current = await realpath(candidate);
			} catch (error) {
				if (isMissing(error)) throw new Error("workspace path contains a dangling symbolic link");
				throw error;
			}
		} else {
			current = candidate;
		}
		if (!isWithinRoot(relative(rootPath, current))) {
			throw new Error("workspace path escapes its configured root through a symbolic link");
		}
	}
	return current;
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await atomicWrite(path, `${canonicalJson(value)}\n`);
}

async function atomicWrite(path: string, value: string | Uint8Array): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	await writeFile(temporary, value);
	await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
