/** Frozen captures, immutable graph revisions, run records, and per-verification objects. */

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256Json } from "./json.ts";
import { withFileLock } from "./lockfile.ts";
import {
	DOG_SCHEMA_VERSION,
	type AcceptancePlan,
	type BackgroundSpec,
	type CapturedInput,
	type CompiledGraph,
	type DogRun,
	type FrozenBackground,
	type FrozenDocument,
	type TargetSpec,
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
				...(compiled.background === undefined ? {} : { background: compiled.background }),
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
			background?: FrozenBackground;
		}>(join(this.rootPath, "graphs", `${index.graphDigest}.json`));
		if (sha256Json({ input: record.input, acceptancePlans: record.acceptancePlans }) !== index.graphDigest) {
			throw new Error(`invalid persisted graph record ${index.graphDigest}`);
		}
		// Revisions compiled before targets became a union carry a bare string; the
		// object path is then the string itself. Revisions compiled before the rename
		// call an agentic standard `instruction`; the plan's `judgment` (the anchor)
		// is unaffected, so an unchanged goal text keeps inheriting.
		const acceptancePlans: Record<string, AcceptancePlan> = {};
		for (const [goalId, plan] of Object.entries(record.acceptancePlans)) {
			const target = plan.target as unknown;
			const verifier = plan.verifier as unknown as
				| { readonly mode?: string; readonly instruction?: string }
				| undefined;
			const renamed =
				verifier !== undefined && verifier.mode === "agentic" && typeof verifier.instruction === "string"
					? { ...plan, verifier: { mode: "agentic" as const, goal: verifier.instruction } }
					: plan;
			acceptancePlans[goalId] =
				typeof target === "string"
					? { ...renamed, target: { kind: "path", path: target }, objectPath: target }
					: renamed;
		}
		return {
			input: record.input,
			graphDigest: record.graphDigest,
			acceptancePlans,
			...(record.background === undefined ? {} : { background: record.background }),
		};
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

	/** Store one captured file by cloning it: a large object is never buffered or rewritten. */
	async putCaptureFromFile(input: CapturedInput, sourcePath: string): Promise<void> {
		await this.initialize();
		const key = capturedKey(input.digest);
		await cloneOrCopyFile(sourcePath, join(this.rootPath, "captures", `${key}.bin`));
		await atomicWriteJson(join(this.rootPath, "captures", `${key}.json`), input);
	}

	/** Store one captured tree by cloning it, keyed by its manifest digest. */
	async putCaptureTree(input: CapturedInput, sourceDir: string, manifest: TreeManifest): Promise<void> {
		await this.initialize();
		const key = capturedKey(input.digest);
		const directory = join(this.rootPath, "captures", key);
		const stored = await stat(join(directory, "manifest.json")).catch(() => undefined);
		if (stored === undefined) {
			await rm(directory, { recursive: true, force: true });
			await cloneOrCopyTree(sourceDir, join(directory, "tree"));
			await atomicWriteJson(join(directory, "manifest.json"), manifest);
		}
		// The input record is rewritten even when the tree is already frozen: the
		// bytes are identical, but the provenance (which ref resolved to it) is not.
		await atomicWriteJson(join(this.rootPath, "captures", `${key}.json`), input);
	}

	/** Re-hash one captured input against what was recorded for it. */
	async verifyCapture(input: CapturedInput): Promise<void> {
		if (!input.exists) throw new Error(`captured input ${input.digest} represents a missing file`);
		const key = capturedKey(input.digest);
		const mismatch = `captured input integrity mismatch for ${input.digest}`;
		if (captureForm(input) === "tree" || captureForm(input) === "git") {
			const stored = await readTree(join(this.rootPath, "captures", key, "tree"), Number.MAX_SAFE_INTEGER);
			if (manifestDigest(stored) !== input.sha256) throw new Error(mismatch);
			return;
		}
		const path = join(this.rootPath, "captures", `${key}.bin`);
		const sha256 = await hashFile(path);
		if (sha256 !== input.sha256) throw new Error(mismatch);
		const metadata = await stat(path);
		if (metadata.size !== input.byteLength) throw new Error(mismatch);
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
		const inputPath = join(workspace, plan.objectPath);
		await mkdir(dirname(inputPath), { recursive: true });
		const input = plan.input;
		if (input === undefined || !input.exists) {
			return { directory, workspace, objectPath: inputPath, inputPath, sessionDirectory };
		}
		// Re-hash the stored object, then place it by clone: the verifier gets a
		// snapshot of exactly those bytes without a second full write of them.
		await this.verifyCapture(input);
		const key = capturedKey(input.digest);
		const form = captureForm(input);
		if (form === "tree" || form === "git") {
			await cloneOrCopyTree(join(this.rootPath, "captures", key, "tree"), inputPath);
			return { directory, workspace, objectPath: inputPath, inputPath, sessionDirectory };
		}
		const blob = join(this.rootPath, "captures", `${key}.bin`);
		if (form === "file") {
			await cloneOrCopyFile(blob, inputPath);
			return { directory, workspace, objectPath: inputPath, inputPath, sessionDirectory };
		}
		// Legacy capture: a `.tar` whose members are `<target>/…`, so it must be
		// unpacked into the workspace itself — unpacking into `inputPath` would
		// nest the tree twice.
		const archive = `${inputPath}.tar`;
		await cloneOrCopyFile(blob, archive);
		await mkdir(workspace, { recursive: true });
		execFileSync("tar", ["-xf", archive, "-C", workspace], { stdio: "pipe" });
		return { directory, workspace, objectPath: inputPath, inputPath: archive, sessionDirectory };
	}

	/** Remove one goal's verification directory (its evidence lives in the run record). */
	async dropVerification(runId: string, goalId: string): Promise<void> {
		await rm(this.verificationDirectory(runId, goalId), { recursive: true, force: true });
	}
}

/** The platform clone flag: APFS `clonefile` through `cp -c`, Linux reflink through `cp --reflink=always`. */
const CLONE_FLAG = process.platform === "darwin" ? "-c" : "--reflink=always";

/** Recursive forms of the same two mechanisms; the plain variants are the fallback. */
const CLONE_TREE_FLAGS = process.platform === "darwin" ? ["-cR"] : ["-a", "--reflink=always"];
const COPY_TREE_FLAGS = process.platform === "darwin" ? ["-R"] : ["-a"];

/**
 * Place `source` at `destination`, sharing data blocks with the source when the
 * filesystem and runtime can, and copying when they cannot — another volume,
 * another filesystem, a reflink-less kernel, or a runtime whose libuv has no
 * clone support.
 *
 * Two clone mechanisms, because neither one covers every runtime (measured on
 * macOS APFS, 300 MiB): Bun clones through every path, while Node 26 answers
 * `ENOSYS` to `COPYFILE_FICLONE_FORCE` and silently byte-copies for
 * `COPYFILE_FICLONE` — only `cp -c` still clones there. So: in-process first,
 * the platform tool second, an honest copy last.
 *
 * The copy goes through a temporary name because `clonefile` refuses an existing
 * destination, and the rename keeps the replacement atomic. `OMP_DOG_NO_COW=1`
 * skips both clone attempts.
 */
export async function cloneOrCopyFile(source: string, destination: string): Promise<"clone" | "copy"> {
	await mkdir(dirname(destination), { recursive: true });
	const temporary = `${destination}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
	if (process.env.OMP_DOG_NO_COW !== "1") {
		try {
			await copyFile(source, temporary, constants.COPYFILE_FICLONE_FORCE);
			await rename(temporary, destination);
			return "clone";
		} catch {
			await rm(temporary, { force: true }); // a refused clone leaves nothing behind
		}
		try {
			execFileSync("cp", [CLONE_FLAG, source, temporary], { stdio: "pipe" });
			await rename(temporary, destination);
			return "clone";
		} catch {
			await rm(temporary, { force: true });
		}
	}
	await copyFile(source, temporary);
	await rename(temporary, destination);
	return "copy";
}

/** SHA-256 of one file, streamed so a large object is never held in memory. */
async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

/** One regular file inside a captured tree. */
interface TreeFile {
	readonly path: string;
	readonly byteLength: number;
	readonly sha256: string;
}

/**
 * The frozen description of a captured tree. Its digest — sorted paths, sizes
 * and content hashes — is the object's identity, so unlike a `.tar` it does not
 * move when unrelated metadata (mtime, ownership, tar headers) changes.
 */
export interface TreeManifest {
	readonly schemaVersion: "0.1";
	readonly kind: "tree" | "git";
	readonly files: readonly TreeFile[];
	readonly totalBytes: number;
}

/** Walk a tree in a deterministic order; symlinks and special files are refused. */
async function readTree(rootDir: string, maxBytes: number, kind: "tree" | "git" = "tree"): Promise<TreeManifest> {
	const entries = await readdir(rootDir, { withFileTypes: true, recursive: true });
	const found = entries
		.filter((entry) => !entry.isDirectory())
		.map((entry) => {
			const absolute = join(entry.parentPath, entry.name);
			return { entry, absolute, path: relative(rootDir, absolute) };
		})
		.sort((left, right) => left.path.localeCompare(right.path));
	const files: TreeFile[] = [];
	let totalBytes = 0;
	for (const item of found) {
		if (item.entry.isSymbolicLink()) throw new Error(`target tree contains a symbolic link: ${item.path}`);
		if (!item.entry.isFile()) throw new Error(`target tree contains a non-regular file: ${item.path}`);
		const metadata = await stat(item.absolute);
		totalBytes += metadata.size;
		if (totalBytes > maxBytes) throw new Error(`target tree exceeds ${maxBytes} bytes`);
		files.push({ path: item.path, byteLength: metadata.size, sha256: await hashFile(item.absolute) });
	}
	return { schemaVersion: "0.1", kind, files, totalBytes };
}

/** The identity of a tree: its sorted file list, not its bytes on disk. */
function manifestDigest(manifest: TreeManifest): string {
	return sha256Json({ files: manifest.files, totalBytes: manifest.totalBytes });
}

/** How one capture is stored; records written before `form` existed are inferred. */
function captureForm(input: CapturedInput): "file" | "tree" | "git" | "tar" {
	if (input.form !== undefined) return input.form;
	return input.packed === true ? "tar" : "file";
}

/**
 * Place a directory tree at `destination`, cloning each file when the platform
 * can (`cp -cR` on APFS, `cp -a --reflink=always` elsewhere) and copying when it
 * cannot. Node's own clone flag has no recursive form, so this is a `cp` call —
 * verified against the platform's own behaviour rather than assumed.
 */
export async function cloneOrCopyTree(source: string, destination: string): Promise<"clone" | "copy"> {
	await rm(destination, { recursive: true, force: true });
	await mkdir(dirname(destination), { recursive: true });
	if (process.env.OMP_DOG_NO_COW !== "1") {
		try {
			execFileSync("cp", [...CLONE_TREE_FLAGS, source, destination], { stdio: "pipe" });
			return "clone";
		} catch {
			await rm(destination, { recursive: true, force: true });
		}
	}
	execFileSync("cp", [...COPY_TREE_FLAGS, source, destination], { stdio: "pipe" });
	return "copy";
}

/** Capture one directory: hash every file, then freeze the tree by cloning it. */
async function captureTree(
	absolutePath: string,
	target: string,
	maxBytes: number,
	repository: DogRepository,
): Promise<CapturedInputFile> {
	const manifest = await readTree(absolutePath, maxBytes);
	const digest = manifestDigest(manifest);
	const input: CapturedInput = {
		path: target,
		digest: `tree:${digest}`,
		exists: true,
		byteLength: manifest.totalBytes,
		sha256: digest,
		packed: true,
		form: "tree",
	};
	await repository.putCaptureTree(input, absolutePath, manifest);
	return { input };
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
 * Read one of the graph's background documents from the workspace. Unlike a
 * target it is not optional: a graph that names one and cannot find it is a
 * configuration error, because silently dropping it would weaken every judgment
 * in the graph.
 */
export async function readWorkspaceBackground(
	captureRoots: readonly string[],
	spec: BackgroundSpec,
	maxBytes: number,
): Promise<FrozenBackground> {
	const general =
		spec.general === undefined ? undefined : await readWorkspaceDocument(captureRoots, spec.general, maxBytes);
	const specific =
		spec.specific === undefined ? undefined : await readWorkspaceDocument(captureRoots, spec.specific, maxBytes);
	return { ...(general === undefined ? {} : { general }), ...(specific === undefined ? {} : { specific }) };
}

async function readWorkspaceDocument(
	captureRoots: readonly string[],
	path: string,
	maxBytes: number,
): Promise<FrozenDocument> {
	for (const root of captureRoots) {
		try {
			const absolute = await resolveWorkspacePath(root, path);
			const text = await readFile(absolute, "utf8");
			if (Buffer.byteLength(text, "utf8") > maxBytes) {
				throw new Error(`background ${path} exceeds ${maxBytes} bytes`);
			}
			return { path, sha256: sha256Json({ text }), text };
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
	}
	throw new Error(`background file not found: ${path}`);
}

/**
 * Capture one target: a workspace path (file, or directory frozen as a cloned
 * tree), or a git tree at a ref. Roots are tried in order; a non-missing error
 * (escape, wrong type, size) aborts immediately, while a path target absent from
 * every root settles as `missing`.
 */
export async function captureTarget(
	captureRoots: readonly string[],
	target: TargetSpec,
	maxBytes: number,
	repository: DogRepository,
): Promise<CapturedInputFile> {
	return target.kind === "git"
		? captureGitTarget(captureRoots, target, maxBytes, repository)
		: capturePathTarget(captureRoots, target.path, maxBytes, repository);
}

/** One git invocation, read-only, in one repository. Undefined when git refuses. */
function gitOutput(cwd: string, args: readonly string[]): string | undefined {
	try {
		const out = execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const text = out.trim();
		return text.length === 0 ? undefined : text;
	} catch {
		return undefined;
	}
}

/**
 * Freeze a committed tree. The ref is resolved to a commit first, so the object
 * is exactly those committed bytes — the working tree takes no part, and the
 * identity is the commit itself rather than a hash of a checkout.
 *
 * A ref that does not resolve settles `missing` (gate on a commit that does not
 * exist yet); a workspace that is not a git repository at all is a configuration
 * error and throws.
 */
async function captureGitTarget(
	captureRoots: readonly string[],
	target: Extract<TargetSpec, { kind: "git" }>,
	maxBytes: number,
	repository: DogRepository,
): Promise<CapturedInputFile> {
	let repositoryRoot: string | undefined;
	for (const root of captureRoots) {
		repositoryRoot = gitOutput(root, ["rev-parse", "--show-toplevel"]);
		if (repositoryRoot !== undefined) break;
	}
	if (repositoryRoot === undefined) {
		throw new Error(`no git repository under ${captureRoots.join(", ")} for target git:${target.ref}`);
	}
	const subpath = target.path ?? "";
	const objectPath = basename(subpath.length === 0 ? repositoryRoot : subpath);
	const commit = gitOutput(repositoryRoot, ["rev-parse", "--verify", "--quiet", `${target.ref}^{commit}`]);
	if (commit === undefined) {
		const input: CapturedInput = {
			path: objectPath,
			digest: `missing:${sha256Json({ git: target.ref, path: subpath })}`,
			exists: false,
			byteLength: 0,
			sha256: "",
			packed: true,
			form: "git",
		};
		await repository.putCapture(input, undefined);
		return { input };
	}
	const staging = join(repository.rootPath, "captures", `.staging-${process.pid}-${randomUUID().slice(0, 8)}`);
	const tree = join(staging, "tree");
	await mkdir(tree, { recursive: true });
	try {
		const archive = join(staging, "tree.tar");
		const spec = subpath.length === 0 ? commit : `${commit}:${subpath}`;
		execFileSync("git", ["-C", repositoryRoot, "archive", "--format=tar", `--output=${archive}`, spec], {
			stdio: "pipe",
		});
		execFileSync("tar", ["-xf", archive, "-C", tree], { stdio: "pipe" });
		const manifest = await readTree(tree, maxBytes, "git");
		const digest = manifestDigest(manifest);
		const input: CapturedInput = {
			path: objectPath,
			digest: `git:${commit}${subpath.length === 0 ? "" : `:${subpath}`}`,
			exists: true,
			byteLength: manifest.totalBytes,
			sha256: digest,
			packed: true,
			form: "git",
			git: { ref: target.ref, commit, path: subpath },
		};
		await repository.putCaptureTree(input, tree, manifest);
		return { input };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

async function capturePathTarget(
	captureRoots: readonly string[],
	target: string,
	maxBytes: number,
	repository: DogRepository,
): Promise<CapturedInputFile> {
	for (const root of captureRoots) {
		try {
			const absolutePath = await resolveWorkspacePath(root, target);
			const metadata = await stat(absolutePath);
			if (metadata.isFile()) {
				if (metadata.size > maxBytes) throw new Error(`target ${target} exceeds ${maxBytes} bytes`);
				const sha256 = await hashFile(absolutePath);
				const settled = await stat(absolutePath);
				if (settled.size !== metadata.size || settled.mtimeMs !== metadata.mtimeMs) {
					throw new Error(`target ${target} changed while it was being captured`);
				}
				const input: CapturedInput = {
					path: target,
					digest: `sha256:${sha256}`,
					exists: true,
					byteLength: metadata.size,
					sha256,
				};
				await repository.putCaptureFromFile(input, absolutePath);
				return { input };
			}
			if (!metadata.isDirectory()) throw new Error(`target ${target} is not a regular file or directory`);
			return await captureTree(absolutePath, target, maxBytes, repository);
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
