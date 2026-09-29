/** Freezing one object: content identity, clone placement, integrity, and the copy fallback. */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { AcceptancePlan } from "../core/model.ts";
import { DogRepository, cloneOrCopyFile, captureWorkspaceTarget, resolveWorkspacePath } from "../core/storage.ts";
import { temporaryRoot } from "./helpers.ts";

const roots: string[] = [];

async function scratch(): Promise<string> {
	const root = await temporaryRoot();
	roots.push(root);
	await mkdir(join(root, "store"), { recursive: true });
	return root;
}

function planFor(input: AcceptancePlan["input"], target = "artifact.txt"): AcceptancePlan {
	return {
		goalId: "leaf",
		verifier: { mode: "programmatic", script: "file-non-empty" },
		judgment: { mode: "programmatic", script: "file-non-empty", scriptDigest: "sha256:stub" },
		target,
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

		const { input } = await captureWorkspaceTarget([root], "artifact.txt", 1024, repository);
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
		const { input: first } = await captureWorkspaceTarget([root], "artifact.txt", 1024, repository);

		// Same path, new content: the digest is recomputed, so a verdict bound to
		// the old bytes can never be inherited for the new ones.
		await writeFile(join(root, "artifact.txt"), "second\n");
		const { input: second } = await captureWorkspaceTarget([root], "artifact.txt", 1024, repository);
		expect(second.sha256).not.toBe(first.sha256);
		expect(second.sha256).toBe(createHash("sha256").update("second\n").digest("hex"));
	});

	it("rejects a capture whose stored bytes no longer match the manifest", async () => {
		const root = await scratch();
		await writeFile(join(root, "artifact.txt"), "honest bytes\n");
		const repository = new DogRepository(join(root, "store"));
		const { input } = await captureWorkspaceTarget([root], "artifact.txt", 1024, repository);

		const [blob] = (await readdir(join(root, "store", "captures"))).filter((name) => name.endsWith(".bin"));
		await writeFile(join(root, "store", "captures", String(blob)), "forged bytes\n");

		await expect(repository.verifyCapture(input)).rejects.toThrow(/integrity mismatch/);
		await expect(repository.prepareVerification("run-1", "leaf", planFor(input))).rejects.toThrow(/integrity mismatch/);
	});

	it("settles an absent target as missing without inventing bytes", async () => {
		const root = await scratch();
		const repository = new DogRepository(join(root, "store"));
		const { input } = await captureWorkspaceTarget([root], "absent.txt", 1024, repository);
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

	it("clones when the filesystem can and copies when told not to", async () => {
		const root = await scratch();
		const source = join(root, "source.bin");
		await writeFile(source, "payload\n");

		const cloned = await cloneOrCopyFile(source, join(root, "cloned.bin"));
		expect(await readFile(join(root, "cloned.bin"), "utf8")).toBe("payload\n");
		if (process.platform === "darwin") expect(cloned).toBe("clone");

		process.env.OMP_DOG_NO_COW = "1";
		const copied = await cloneOrCopyFile(source, join(root, "copied.bin"));
		expect(copied).toBe("copy");
		expect(await readFile(join(root, "copied.bin"), "utf8")).toBe("payload\n");
	});

	it("packs a directory target and hands the verifier the unpacked tree", async () => {
		const root = await scratch();
		await mkdir(join(root, "bundle", "nested"), { recursive: true });
		await writeFile(join(root, "bundle", "nested", "inside.md"), "hello\n");
		const repository = new DogRepository(join(root, "store"));
		const { input } = await captureWorkspaceTarget([root], "bundle", 1_048_576, repository);
		expect(input.packed).toBe(true);

		const prepared = await repository.prepareVerification("run-1", "leaf", planFor(input, "bundle"));
		// The programmatic kernel gets the archive's path; the agentic kernel gets a
		// working directory in which the tree is already unpacked.
		expect(prepared.inputPath).toBe(`${prepared.objectPath}.tar`);
		expect(await readFile(join(prepared.objectPath, "nested", "inside.md"), "utf8")).toBe("hello\n");
	});
});
