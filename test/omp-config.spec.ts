/** OMP deployment surface: where a project's DoG state lives and which script library it runs. */

import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { DogEngine, resolveScriptPath } from "../core/engine.ts";
import { DogRepository } from "../core/storage.ts";
import { EXTENSION_ROOT, dogRootFor, resolveDogConfig } from "../omp/config.ts";

const CWD = "/Users/example/project";

describe("resolveDogConfig", () => {
	it("derives every path from the invoking project, never from a global agent directory", () => {
		const config = resolveDogConfig(CWD);
		expect(dogRootFor(CWD)).toBe(join(CWD, ".omp", "dog"));
		expect(config.workspaceRoot).toBe(join(CWD, ".omp", "dog", "workspace"));
		expect(isAbsolute(config.workspaceRoot)).toBe(true);
		const insideProject = relative(CWD, config.workspaceRoot);
		expect(isAbsolute(insideProject)).toBe(false);
		expect(insideProject.startsWith("..")).toBe(false);
		// A different project gets its own tree.
		expect(resolveDogConfig("/tmp/another-project").workspaceRoot).toBe(
			join("/tmp/another-project", ".omp", "dog", "workspace"),
		);
	});

	it("keeps storageDirectory relative and traversal-free, inside the same tree as the workspace", () => {
		const config = resolveDogConfig(CWD);
		expect(isAbsolute(config.storageDirectory)).toBe(false);
		expect(config.storageDirectory.split(sep)).not.toContain("..");
		expect(join(CWD, config.storageDirectory)).toBe(dogRootFor(CWD));
		// Captures and workspaces must live under one DoG root.
		expect(dirname(config.workspaceRoot)).toBe(join(CWD, config.storageDirectory));
	});

	it("points the script library at the executable scripts shipped inside the extension", () => {
		const config = resolveDogConfig(CWD);
		expect(isAbsolute(config.scriptsDirectory)).toBe(true);
		expect(relative(EXTENSION_ROOT, config.scriptsDirectory)).toBe("scripts");
		for (const script of ["file-non-empty", "slop-phrases"]) {
			const resolved = resolveScriptPath(config.scriptsDirectory, script);
			expect(existsSync(resolved), script).toBe(true);
			// The kernels hand the path straight to `exec`, so it must be runnable.
			expect(statSync(resolved).mode & 0o111, script).toBeGreaterThan(0);
		}
		expect(() => resolveScriptPath(config.scriptsDirectory, "not-registered")).toThrow();
	});

	it("resolves a configuration the engine accepts", () => {
		const cwd = join(tmpdir(), "dog-config-project");
		const config = resolveDogConfig(cwd);
		expect(() => new DogEngine({ config, repository: new DogRepository(dogRootFor(cwd)) })).not.toThrow();
	});
});
