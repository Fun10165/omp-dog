/**
 * Verifier sessions run with a read-only tool face (`read`, `grep`, `glob`,
 * `find`), so every MCP server the host has configured is connection and
 * process overhead with no possible use. OMP has no command-line switch for
 * that: a session always discovers MCP. The one lever is config precedence —
 * a project-scoped entry with `enabled: false` suppresses the same-named
 * server from every other source — so each verifier workspace gets its own
 * `.omp/mcp.json` that switches off everything this machine defines.
 *
 * Only OMP-native sources are read: the active profile's user file (or the
 * default user file), plus the project files the workspace itself carries.
 * Servers that exist purely in another tool's config (`.claude/`, `.cursor/`,
 * …) stay unsuppressed; they are not this repository's to enumerate.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "../core/model.ts";

/** Project-scoped MCP config, relative to a session's working directory. */
export const PROJECT_MCP_CONFIG = join(".omp", "mcp.json");

/** Standalone fallback MCP files OMP also reads from a project root. */
const FALLBACK_MCP_CONFIGS = ["mcp.json", ".mcp.json"] as const;

export interface VerifierMcpConfigOptions {
	/** Session working directory; the suppression file is written under it. */
	readonly workspace: string;
	/** Home directory holding `~/.omp`; injected in tests. */
	readonly homeDirectory?: string;
}

/**
 * Switch off every MCP server this machine defines, for one verifier
 * workspace. Returns the path written, or `undefined` when neither the machine
 * nor the workspace declares a server.
 */
export async function writeVerifierMcpConfig(options: VerifierMcpConfigOptions): Promise<string | undefined> {
	const home = options.homeDirectory ?? homedir();
	const profile = process.env.OMP_PROFILE ?? process.env.PI_PROFILE;
	const projectConfig = join(options.workspace, PROJECT_MCP_CONFIG);
	const sources = [
		profile === undefined || profile.trim().length === 0
			? join(home, ".omp", "agent", "mcp.json")
			: join(home, ".omp", "profiles", profile.trim(), "agent", "mcp.json"),
		...FALLBACK_MCP_CONFIGS.map((name) => join(options.workspace, name)),
		projectConfig,
	];
	// Later sources win: the workspace's own definition of a server is the one
	// the session would have used, so it is the one carried into the override.
	const servers: Record<string, Record<string, unknown>> = {};
	let workspaceDocument: Record<string, unknown> | undefined;
	for (const path of sources) {
		const document = await readJsonIfPresent(path);
		if (document === undefined) continue;
		const declared = document.mcpServers;
		if (declared !== undefined && !isRecord(declared)) {
			throw new Error(`MCP config ${path} field mcpServers must be an object`);
		}
		for (const [name, definition] of Object.entries(isRecord(declared) ? declared : {})) {
			const previous = servers[name];
			servers[name] = {
				...(isRecord(previous) ? previous : {}),
				...(isRecord(definition) ? definition : {}),
			};
		}
		if (path === projectConfig) workspaceDocument = document;
	}
	if (Object.keys(servers).length === 0) return undefined;
	for (const name of Object.keys(servers)) servers[name] = { ...servers[name], enabled: false };
	await mkdir(dirname(projectConfig), { recursive: true });
	await writeFile(
		projectConfig,
		`${JSON.stringify({ ...workspaceDocument, mcpServers: servers }, undefined, "\t")}\n`,
		"utf8",
	);
	return projectConfig;
}

/** Read one config, or `undefined` when it does not exist. Malformed JSON is an error. */
async function readJsonIfPresent(path: string): Promise<Record<string, unknown> | undefined> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`MCP config ${path} is not valid JSON: ${message}`);
	}
	if (!isRecord(parsed)) throw new Error(`MCP config ${path} must be a JSON object`);
	return parsed;
}
