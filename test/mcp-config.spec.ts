/** Verifier workspaces switch off the host's MCP servers; OMP has no CLI switch for that. */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeVerifierMcpConfig } from "../omp/mcp-config.ts";
import { temporaryRoot } from "./helpers.ts";

const roots: string[] = [];
const savedProfile = { OMP_PROFILE: process.env.OMP_PROFILE, PI_PROFILE: process.env.PI_PROFILE };

async function fixture(): Promise<{ home: string; workspace: string; userConfig: string }> {
	const root = await temporaryRoot();
	roots.push(root);
	const home = join(root, "home");
	const workspace = join(root, "workspace");
	await mkdir(join(home, ".omp", "agent"), { recursive: true });
	await mkdir(workspace, { recursive: true });
	delete process.env.OMP_PROFILE;
	delete process.env.PI_PROFILE;
	return { home, workspace, userConfig: join(home, ".omp", "agent", "mcp.json") };
}

afterEach(async () => {
	for (const [key, value] of Object.entries(savedProfile)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("verifier mcp suppression", () => {
	it("switches off every user-configured server in the workspace config", async () => {
		const { home, workspace, userConfig } = await fixture();
		await writeFile(
			userConfig,
			JSON.stringify({
				mcpServers: {
					"some-tool": { command: "npx", args: ["-y", "some-mcp"] },
					remote: { type: "http", url: "https://example.test/mcp", enabled: true },
				},
				disabledServers: ["already-off"],
			}),
			"utf8",
		);

		const written = await writeVerifierMcpConfig({ workspace, homeDirectory: home });

		expect(written).toBe(join(workspace, ".omp", "mcp.json"));
		const document = JSON.parse(await readFile(written!, "utf8")) as {
			mcpServers: Record<string, { enabled?: boolean; command?: string; url?: string }>;
		};
		expect(Object.keys(document.mcpServers).sort()).toEqual(["remote", "some-tool"]);
		expect(document.mcpServers["some-tool"]).toMatchObject({ enabled: false, command: "npx" });
		expect(document.mcpServers.remote).toMatchObject({ enabled: false, url: "https://example.test/mcp" });
	});

	it("reads the active profile's file instead of the default user file", async () => {
		const { home, workspace, userConfig } = await fixture();
		await writeFile(userConfig, JSON.stringify({ mcpServers: { defaultOnly: { command: "x" } } }), "utf8");
		const profileConfig = join(home, ".omp", "profiles", "verifier", "agent", "mcp.json");
		await mkdir(join(home, ".omp", "profiles", "verifier", "agent"), { recursive: true });
		await writeFile(profileConfig, JSON.stringify({ mcpServers: { profileOnly: { command: "y" } } }), "utf8");
		process.env.OMP_PROFILE = "verifier";

		const written = await writeVerifierMcpConfig({ workspace, homeDirectory: home });

		const document = JSON.parse(await readFile(written!, "utf8")) as { mcpServers: Record<string, unknown> };
		expect(Object.keys(document.mcpServers)).toEqual(["profileOnly"]);
	});

	it("merges the workspace's own config and keeps its other keys", async () => {
		const { home, workspace } = await fixture();
		const existing = join(workspace, ".omp", "mcp.json");
		await mkdir(join(workspace, ".omp"), { recursive: true });
		await writeFile(
			existing,
			JSON.stringify({
				$schema: "https://example.test/schema.json",
				mcpServers: { local: { command: "local-server" } },
				disabledServers: ["note"],
			}),
			"utf8",
		);

		const written = await writeVerifierMcpConfig({ workspace, homeDirectory: home });

		const document = JSON.parse(await readFile(written!, "utf8")) as {
			$schema: string;
			disabledServers: string[];
			mcpServers: Record<string, { enabled?: boolean }>;
		};
		expect(written).toBe(existing);
		expect(document.$schema).toBe("https://example.test/schema.json");
		expect(document.disabledServers).toEqual(["note"]);
		expect(document.mcpServers.local.enabled).toBe(false);
	});

	it("writes nothing when the machine and the workspace configure no servers", async () => {
		const { home, workspace } = await fixture();

		expect(await writeVerifierMcpConfig({ workspace, homeDirectory: home })).toBeUndefined();
	});

	it("rejects a malformed user config by path", async () => {
		const { home, workspace, userConfig } = await fixture();
		await writeFile(userConfig, "{ not json", "utf8");

		await expect(writeVerifierMcpConfig({ workspace, homeDirectory: home })).rejects.toThrow(userConfig);
	});
});
