/** Freezing one object: content identity, clone placement, integrity, and the copy fallback. */

import { mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { AcceptancePlan, TargetSpec } from "../core/model.ts";
import { DogRepository, captureTarget, cloneOrCopyFile, resolveWorkspacePath } from "../core/storage.ts";
import { temporaryRoot } from "./helpers.ts";

const roots: string[] = [];

/** Shorthand for the common target form in these tests. */
const pathTarget = (path: string): TargetSpec => ({ kind: "path", path });

async function scratch(): Promise<string> {
	const root = await temporaryRoot();
	roots.push(root);
	await mkdir(join(root, "store"), { recursive: true });
	return root;
}

/** The one stored tree of a fixture, found by listing rather than by re-deriving the key. */
async function storedTreeFile(root: string, inner: string): Promise<string> {
	const entries = await readdir(join(root, "store", "captures"));
	const directory = entries.find((name) => name.startsWith("tree_") || name.startsWith("git_"));
	if (directory === undefined) throw new Error("no stored tree in this fixture");
	return join(root, "store", "captures", directory, "tree", inner);
}

/** The manifest of the one stored tree in a fixture. */
async function storedManifest(root: string): Promise<string> {
	const entries = await readdir(join(root, "store", "captures"));
	const directory = entries.find((name) => name.startsWith("tree_") || name.startsWith("git_"));
	if (directory === undefined) throw new Error("no stored tree in this fixture");
	return join(root, "store", "captures", directory, "manifest.json");
}

function planFor(input: AcceptancePlan["input"], objectPath = "artifact.txt"): AcceptancePlan {
	return {
		goalId: "leaf",
		verifier: { mode: "programmatic", script: "file-non-empty" },
		judgment: { mode: "programmatic", script: "file-non-empty", scriptDigest: "sha256:stub" },
		target: { kind: "path", path: objectPath },
		objectPath,
		...(input === undefined ? {} : { input }),
	};
}

afterEach(async () => {
	delete process.env.OMP_DOG_NO_COW;
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("capture", () => {
	it("freezes a file under its content digest and materializes the same bytes", async () => {
		const root = await scratch();
		const content = "smoke artifact\n";
		await writeFile(join(root, "artifact.txt"), content);
		const repository = new DogRepository(join(root, "store"));

		const { input } = await captureTarget([root], pathTarget("artifact.txt"), 1024, repository);
		expect(input.exists).toBe(true);
		expect(input.packed).toBeUndefined();
		expect(input.byteLength).toBe(Buffer.byteLength(content));
		expect(input.sha256).toBe(createHash("sha256").update(content).digest("hex"));

		const prepared = await repository.prepareVerification("run-1", "leaf", planFor(input));
		expect(await readFile(prepared.objectPath, "utf8")).toBe(content);
		expect(prepared.inputPath).toBe(prepared.objectPath);
	});

	it("re-freezes a changed object under its new digest", async () => {
		const root = await scratch();
		await writeFile(join(root, "artifact.txt"), "first\n");
		const repository = new DogRepository(join(root, "store"));
		const { input: first } = await captureTarget([root], pathTarget("artifact.txt"), 1024, repository);

		// Same path, new content: the digest is recomputed, so a verdict bound to
		// the old bytes can never be inherited for the new ones.
		await writeFile(join(root, "artifact.txt"), "second\n");
		const { input: second } = await captureTarget([root], pathTarget("artifact.txt"), 1024, repository);
		expect(second.sha256).not.toBe(first.sha256);
		expect(second.sha256).toBe(createHash("sha256").update("second\n").digest("hex"));
	});

	it("rejects a capture whose stored bytes no longer match the manifest", async () => {
		const root = await scratch();
		await writeFile(join(root, "artifact.txt"), "honest bytes\n");
		const repository = new DogRepository(join(root, "store"));
		const { input } = await captureTarget([root], pathTarget("artifact.txt"), 1024, repository);

		const [blob] = (await readdir(join(root, "store", "captures"))).filter((name) => name.endsWith(".bin"));
		await writeFile(join(root, "store", "captures", String(blob)), "forged bytes\n");

		await expect(repository.verifyCapture(input)).rejects.toThrow(/integrity mismatch/);
		await expect(repository.prepareVerification("run-1", "leaf", planFor(input))).rejects.toThrow(/integrity mismatch/);
	});

	it("settles an absent target as missing without inventing bytes", async () => {
		const root = await scratch();
		const repository = new DogRepository(join(root, "store"));
		const { input } = await captureTarget([root], pathTarget("absent.txt"), 1024, repository);
		expect(input.exists).toBe(false);
		expect(input.digest.startsWith("missing:")).toBe(true);
		expect(input.byteLength).toBe(0);

		const prepared = await repository.prepareVerification("run-1", "leaf", planFor(input));
		await expect(stat(prepared.objectPath)).rejects.toThrow();
	});

	it("refuses an absolute path and an escape", async () => {
		const root = await scratch();
		await expect(resolveWorkspacePath(root, "/etc/hosts")).rejects.toThrow(/must be relative/);
		await expect(resolveWorkspacePath(root, "../outside.txt")).rejects.toThrow(/escapes/);
	});

	it("clones when the filesystem can, copies when told not to, and replaces in place", async () => {
		const root = await scratch();
		const source = join(root, "source.bin");
		const destination = join(root, "copied.bin");
		await writeFile(source, "payload\n");

		const cloned = await cloneOrCopyFile(source, destination);
		expect(await readFile(destination, "utf8")).toBe("payload\n");
		if (process.platform === "darwin") expect(cloned).toBe("clone");

		// The same capture runs again on every create: overwriting an existing
		// destination must work, and clonefile's EEXIST must not leak out.
		const again = await cloneOrCopyFile(source, destination);
		expect(await readFile(destination, "utf8")).toBe("payload\n");
		if (process.platform === "darwin") expect(again).toBe("clone");

		process.env.OMP_DOG_NO_COW = "1";
		const copied = await cloneOrCopyFile(source, destination);
		expect(copied).toBe("copy");
		expect(await readFile(destination, "utf8")).toBe("payload\n");
	});

	it("freezes a directory target as a tree and hands the verifier that tree", async () => {
		const root = await scratch();
		await mkdir(join(root, "bundle", "nested"), { recursive: true });
		await writeFile(join(root, "bundle", "nested", "inside.md"), "hello\n");
		const repository = new DogRepository(join(root, "store"));
		const { input } = await captureTarget([root], pathTarget("bundle"), 1_048_576, repository);
		expect(input.form).toBe("tree");
		expect(input.packed).toBe(true);
		expect(input.digest.startsWith("tree:")).toBe(true);
		expect(input.byteLength).toBe(6);

		const prepared = await repository.prepareVerification("run-1", "leaf", planFor(input, "bundle"));
		// A tree capture is handed over as the directory itself, in both kernels.
		expect(prepared.inputPath).toBe(prepared.objectPath);
		expect((await stat(prepared.objectPath)).isDirectory()).toBe(true);
		expect(await readFile(join(prepared.objectPath, "nested", "inside.md"), "utf8")).toBe("hello\n");
	});

	it("keys a tree by its contents, not by file metadata", async () => {
		const root = await scratch();
		await mkdir(join(root, "bundle"), { recursive: true });
		const file = join(root, "bundle", "inside.md");
		await writeFile(file, "hello\n");
		const repository = new DogRepository(join(root, "store"));
		const { input: first } = await captureTarget([root], pathTarget("bundle"), 1_048_576, repository);

		// Touching a file is not a change of the object: a `.tar` would move here.
		const touched = new Date(Date.now() + 60_000);
		await utimes(file, touched, touched);
		const { input: second } = await captureTarget([root], pathTarget("bundle"), 1_048_576, repository);
		expect(second.digest).toBe(first.digest);

		await writeFile(file, "goodbye\n");
		const { input: third } = await captureTarget([root], pathTarget("bundle"), 1_048_576, repository);
		expect(third.digest).not.toBe(first.digest);
	});

	it("reuses an already frozen tree instead of cloning it again", async () => {
		const root = await scratch();
		await mkdir(join(root, "bundle"), { recursive: true });
		await writeFile(join(root, "bundle", "inside.md"), "hello\n");
		const repository = new DogRepository(join(root, "store"));
		await captureTarget([root], pathTarget("bundle"), 1_048_576, repository);
		const stored = await storedTreeFile(root, "inside.md");
		const before = (await stat(stored)).mtimeMs;

		await captureTarget([root], pathTarget("bundle"), 1_048_576, repository);
		expect((await stat(stored)).mtimeMs).toBe(before);
	});

	it("refuses a stored tree whose bytes no longer match the manifest", async () => {
		const root = await scratch();
		await mkdir(join(root, "bundle"), { recursive: true });
		await writeFile(join(root, "bundle", "inside.md"), "honest\n");
		const repository = new DogRepository(join(root, "store"));
		const { input } = await captureTarget([root], pathTarget("bundle"), 1_048_576, repository);

		await writeFile(await storedTreeFile(root, "inside.md"), "forged\n");
		await expect(repository.verifyCapture(input)).rejects.toThrow(/integrity mismatch/);
		await expect(repository.prepareVerification("run-1", "leaf", planFor(input, "bundle"))).rejects.toThrow(
			/integrity mismatch/,
		);
	});

	it("refuses a tree that carries a symbolic link", async () => {
		const root = await scratch();
		await mkdir(join(root, "bundle"), { recursive: true });
		await writeFile(join(root, "outside.txt"), "secret\n");
		await symlink(join(root, "outside.txt"), join(root, "bundle", "link.txt"));
		const repository = new DogRepository(join(root, "store"));
		await expect(captureTarget([root], pathTarget("bundle"), 1_048_576, repository)).rejects.toThrow(/symbolic link/);
	});

	/** A throwaway repository with one commit; identity comes from the environment, not user config. */
	async function gitFixture(): Promise<{ root: string; commit: string }> {
		const root = await scratch();
		const git = (args: readonly string[]): string =>
			execFileSync("git", [...args], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "DoG",
					GIT_AUTHOR_EMAIL: "dog@example.com",
					GIT_COMMITTER_NAME: "DoG",
					GIT_COMMITTER_EMAIL: "dog@example.com",
				},
			});
		git(["init", "-q"]);
		await mkdir(join(root, "src"), { recursive: true });
		await writeFile(join(root, "src", "index.ts"), "export const x = 1;\n");
		await writeFile(join(root, "README.md"), "# demo\n");
		git(["add", "-A"]);
		git(["commit", "-q", "-m", "initial"]);
		return { root, commit: git(["rev-parse", "HEAD"]).trim() };
	}

	it("freezes the tree at a commit, not the working tree", async () => {
		const { root, commit } = await gitFixture();
		const repository = new DogRepository(join(root, "store"));
		const { input } = await captureTarget([root], { kind: "git", ref: "HEAD" }, 1_048_576, repository);

		expect(input.form).toBe("git");
		expect(input.digest).toBe(`git:${commit}`);
		expect(input.git).toEqual({ ref: "HEAD", commit, path: "" });
		expect(input.byteLength).toBe(Buffer.byteLength("export const x = 1;\n") + Buffer.byteLength("# demo\n"));

		// An uncommitted edit in the live tree is not part of the object.
		await writeFile(join(root, "README.md"), "# edited but not committed\n");
		const prepared = await repository.prepareVerification("run-1", "leaf", planFor(input, input.path));
		expect(await readFile(join(prepared.objectPath, "README.md"), "utf8")).toBe("# demo\n");
		const manifest = JSON.parse(await readFile(await storedManifest(root), "utf8")) as {
			kind: string;
			files: Array<{ path: string }>;
		};
		expect(manifest.kind).toBe("git");
		expect(manifest.files.map((file) => file.path).sort()).toEqual(["README.md", "src/index.ts"]);
	});

	it("captures a subtree of a commit", async () => {
		const { root, commit } = await gitFixture();
		const repository = new DogRepository(join(root, "store"));
		const { input } = await captureTarget([root], { kind: "git", ref: "HEAD", path: "src" }, 1_048_576, repository);

		expect(input.digest).toBe(`git:${commit}:src`);
		expect(input.path).toBe("src");
		const prepared = await repository.prepareVerification("run-1", "leaf", planFor(input, input.path));
		expect(await readFile(join(prepared.objectPath, "index.ts"), "utf8")).toBe("export const x = 1;\n");
		await expect(readFile(join(prepared.objectPath, "README.md"), "utf8")).rejects.toThrow();
	});

	it("moves the git identity when the commit moves, and not before", async () => {
		const { root } = await gitFixture();
		const repository = new DogRepository(join(root, "store"));
		const { input: first } = await captureTarget([root], { kind: "git", ref: "HEAD" }, 1_048_576, repository);

		await writeFile(join(root, "README.md"), "# uncommitted\n");
		const { input: second } = await captureTarget([root], { kind: "git", ref: "HEAD" }, 1_048_576, repository);
		expect(second.digest).toBe(first.digest);

		execFileSync(
			"git",
			["-c", "user.email=dog@example.com", "-c", "user.name=DoG", "commit", "-q", "-a", "-m", "edit"],
			{ cwd: root, stdio: "pipe" },
		);
		const { input: third } = await captureTarget([root], { kind: "git", ref: "HEAD" }, 1_048_576, repository);
		expect(third.digest).not.toBe(first.digest);
		expect(third.digest.startsWith("git:")).toBe(true);
	});

	it("settles an unresolvable ref as missing and refuses a non-repository", async () => {
		const { root } = await gitFixture();
		const repository = new DogRepository(join(root, "store"));
		const { input } = await captureTarget([root], { kind: "git", ref: "v99-no-such-tag" }, 1_048_576, repository);
		expect(input.exists).toBe(false);
		expect(input.form).toBe("git");
		expect(input.digest.startsWith("missing:")).toBe(true);

		const loose = await scratch();
		await expect(
			captureTarget([loose], { kind: "git", ref: "HEAD" }, 1_048_576, new DogRepository(join(loose, "store"))),
		).rejects.toThrow(/no git repository/);
	});

	it("refuses a stored git tree whose bytes no longer match the manifest", async () => {
		const { root } = await gitFixture();
		const repository = new DogRepository(join(root, "store"));
		const { input } = await captureTarget([root], { kind: "git", ref: "HEAD" }, 1_048_576, repository);

		await writeFile(await storedTreeFile(root, "README.md"), "forged\n");
		await expect(repository.verifyCapture(input)).rejects.toThrow(/integrity mismatch/);
	});

	it("still materializes a legacy tar capture", async () => {
		const root = await scratch();
		await mkdir(join(root, "bundle"), { recursive: true });
		await writeFile(join(root, "bundle", "inside.md"), "hello\n");
		const repository = new DogRepository(join(root, "store"));
		const bytes = execFileSync("tar", ["-C", root, "-cf", "-", "bundle"]);
		const input = {
			path: "bundle",
			digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
			exists: true,
			byteLength: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			packed: true,
		} as const;
		await repository.putCapture(input, bytes);

		const prepared = await repository.prepareVerification("run-1", "leaf", planFor(input, "bundle"));
		expect(prepared.inputPath.endsWith(".tar")).toBe(true);
		expect(await readFile(join(prepared.objectPath, "inside.md"), "utf8")).toBe("hello\n");
	});
});
