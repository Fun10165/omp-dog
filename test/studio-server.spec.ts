/**
 * The studio server's two invariants, over a real HTTP round trip:
 * a save the engine's validator accepts is written (with a backup), and a save
 * it rejects leaves the file byte-identical.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { temporaryRoot } from "./helpers.ts";

const PORT = 4600 + Math.floor(Math.random() * 300);

/** A minimal valid graph: one hard root over one leaf. */
function graphText(): string {
	return `${JSON.stringify(
		{
			schemaVersion: "0.9",
			id: "studio-demo",
			root: "root",
			nodes: {
				root: {
					kind: "composite",
					title: "根",
					constraint: "hard",
					target: "report.md",
					completion: { op: "all", items: [{ op: "ref", id: "leaf" }] },
				},
				leaf: {
					kind: "leaf",
					title: "叶子",
					constraint: "hard",
					target: "report.md",
					verifier: { mode: "agentic", instruction: "看它" },
				},
			},
			contains: [{ parent: "root", child: "leaf", required: true, failure: "fatal" }],
			dependsOn: [],
		},
		null,
		"\t",
	)}\n`;
}

async function waitForPort(url: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const response = await fetch(url);
			if (response.ok) return;
		} catch {
			// not listening yet
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 100);
		await promise;
	}
	throw new Error(`studio server never answered on ${url}`);
}

describe("the studio server", () => {
	it("writes a save the validator accepts, and refuses one it rejects", async () => {
		const root = await temporaryRoot();
		const graphPath = join(root, "demo.graph.json");
		writeFileSync(graphPath, graphText(), "utf8");
		const server = spawn(
			"bun",
			[join(import.meta.dirname, "..", "studio", "server.ts"), graphPath, "--port", String(PORT), "--no-open"],
			{
				stdio: "ignore",
			},
		);
		try {
			const url = `http://127.0.0.1:${PORT}`;
			await waitForPort(`${url}/api/graph`);

			const loaded = (await (await fetch(`${url}/api/graph`)).json()) as {
				path: string;
				text: string;
				layout: unknown;
			};
			expect(loaded.text).toBe(graphText());

			// A rejected save: the leaf loses its target, which the engine refuses.
			const broken = JSON.parse(graphText()) as { nodes: { leaf: { target: string } } };
			broken.nodes.leaf.target = "   ";
			const refused = (await (
				await fetch(`${url}/api/graph`, { method: "PUT", body: JSON.stringify({ text: JSON.stringify(broken) }) })
			).json()) as { ok: boolean; problems: readonly string[] };
			expect(refused.ok).toBe(false);
			expect(refused.problems.join("\n")).toMatch(/target/u);
			expect(readFileSync(graphPath, "utf8")).toBe(graphText());

			// An accepted save: the validator passes, the file changes, a backup appears.
			const edited = JSON.parse(graphText()) as { nodes: { leaf: { title: string } } };
			edited.nodes.leaf.title = "改过的叶子";
			const saved = (await (
				await fetch(`${url}/api/graph`, {
					method: "PUT",
					body: JSON.stringify({ text: JSON.stringify(edited), layout: { leaf: { x: 10, y: 20 } } }),
				})
			).json()) as { ok: boolean; backup?: string };
			expect(saved.ok).toBe(true);
			expect(saved.backup).toBeDefined();
			expect(JSON.parse(readFileSync(graphPath, "utf8"))).toMatchObject({ nodes: { leaf: { title: "改过的叶子" } } });
			expect(readdirSync(root).some((name) => name.includes(".bak."))).toBe(true);
			expect(JSON.parse(readFileSync(`${graphPath}.layout.json`, "utf8"))).toEqual({ leaf: { x: 10, y: 20 } });

			// A save that changes nothing writes no second backup.
			const again = (await (
				await fetch(`${url}/api/graph`, {
					method: "PUT",
					body: JSON.stringify({ text: readFileSync(graphPath, "utf8") }),
				})
			).json()) as { ok: boolean; backup?: string };
			expect(again.ok).toBe(true);
			expect(again.backup).toBeUndefined();
			expect(existsSync(graphPath)).toBe(true);
		} finally {
			server.kill();
		}
	}, 30_000);
});
