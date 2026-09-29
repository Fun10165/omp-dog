#!/usr/bin/env bun
/**
 * `bun studio/server.ts <graph-file>` — the visual studio for one DoG graph.
 *
 * The server owns the two things the page must not: it validates a save with the
 * engine's own validator (the same code path `create` and the host tool
 * `dog_validate` use), and it writes the file only when that validation passes,
 * leaving a timestamped backup behind. The page is a Drawflow canvas whose
 * meaning lives in `dogflow.ts`; the browser bundle is built from `app.ts` on
 * request, so there is no build step to run.
 *
 * Binds to 127.0.0.1 and only ever writes the one graph file it was started
 * with, plus that file's layout sidecar.
 */

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolveOmpBin } from "../omp/config.ts";
import { createDogRuntime } from "../omp/runtime.ts";

const STUDIO_DIR = import.meta.dir;

const usage = `用法: bun studio/server.ts <graph-file> [--port 4173] [--no-open]

  <graph-file>  要编辑的 DoG 图（JSON）。每次保存都会先用引擎的校验器验证，
                通过才写盘，并留下 <file>.bak.<时间戳> 备份。
  --port <n>    监听端口（默认 4173，只绑 127.0.0.1）。
  --no-open     不自动打开浏览器。`;

const [target, ...rest] = process.argv.slice(2);
if (target === undefined || target.startsWith("--")) {
	process.stderr.write(`${usage}\n`);
	process.exit(2);
}

const graphPath = resolve(target);
if (!existsSync(graphPath)) {
	process.stderr.write(`找不到图文件: ${graphPath}\n`);
	process.exit(2);
}
const layoutPath = `${graphPath}.layout.json`;

const portFlag = rest.indexOf("--port");
const port = portFlag >= 0 ? Number(rest[portFlag + 1]) : 4173;
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
	process.stderr.write(`--port 需要一个 1-65535 的整数\n`);
	process.exit(2);
}
const open = !rest.includes("--no-open");

const runtime = createDogRuntime({ projectDir: process.cwd(), ompBin: resolveOmpBin(), concurrency: 2 });

interface Validation {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly warnings: readonly string[];
}

function validateText(text: string): Validation {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		return {
			valid: false,
			errors: [`不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`],
			warnings: [],
		};
	}
	return runtime.engine.validate(value);
}

/** How many timestamped backups to keep per graph; older ones are pruned after a write. */
const KEEP_BACKUPS = 5;

const BACKUP_STAMP = /^\d{8}T\d{6}(-\d+)?$/u;

/** Order backups by their own stamp, then by the collision index — never by raw name. */
function backupOrder(left: string, right: string): number {
	const parse = (name: string): { stamp: string; index: number } => {
		const match = /(\d{8}T\d{6})(?:-(\d+))?$/u.exec(name);
		return { stamp: match?.[1] ?? "", index: Number(match?.[2] ?? 0) };
	};
	const a = parse(left);
	const b = parse(right);
	if (a.stamp !== b.stamp) return a.stamp < b.stamp ? -1 : 1;
	return a.index - b.index;
}

/** Drop this graph's own oldest backups, leaving the newest `KEEP_BACKUPS`. */
function pruneBackups(path: string): number {
	const directory = dirname(path);
	const prefix = `${basename(path)}.bak.`;
	const mine = readdirSync(directory)
		.filter((name) => name.startsWith(prefix) && BACKUP_STAMP.test(name.slice(prefix.length)))
		.sort(backupOrder);
	const stale = mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS));
	for (const name of stale) rmSync(join(directory, name), { force: true });
	return stale.length;
}

/** A copy of what is on disk before it is overwritten, named by the local clock. */
function backup(path: string, current: string, next: string): { path: string; pruned: number } | undefined {
	if (current === next) return undefined;
	const now = new Date();
	const pad = (value: number): string => String(value).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const directory = dirname(path);
	const prefix = `${basename(path)}.bak.${stamp}`;
	// Names inside one second must stay ordered and never be reused, so a pruned
	// name can never come back looking newest.
	const mine = readdirSync(directory).filter((name) => name === prefix || name.startsWith(`${prefix}-`));
	const index = mine.reduce(
		(highest, name) => Math.max(highest, name === prefix ? 0 : Number(name.slice(prefix.length + 1)) || 0),
		0,
	);
	const target = join(directory, `${prefix}${mine.length === 0 ? "" : `-${index + 1}`}`);
	writeFileSync(target, current, "utf8");
	return { path: target, pruned: pruneBackups(path) };
}

async function json(body: unknown, status = 200): Promise<Response> {
	return new Response(JSON.stringify(body, null, 2), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

async function buildPage(): Promise<Response> {
	const built = await Bun.build({ entrypoints: [join(STUDIO_DIR, "app.ts")], target: "browser", minify: false });
	if (!built.success) {
		const logs = built.logs.map((log) => log.message).join("\n");
		return new Response(`bundle failed:\n${logs}`, {
			status: 500,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}
	const artifact = built.outputs[0];
	if (artifact === undefined) return new Response("bundle produced no output", { status: 500 });
	return new Response(await artifact.arrayBuffer(), { headers: { "content-type": "text/javascript; charset=utf-8" } });
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/") {
			return new Response(Bun.file(join(STUDIO_DIR, "index.html")), {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}
		if (url.pathname === "/app.js") return buildPage();
		if (url.pathname === "/vendor/drawflow.min.css") {
			return new Response(Bun.file(join(STUDIO_DIR, "..", "node_modules", "drawflow", "dist", "drawflow.min.css")), {
				headers: { "content-type": "text/css; charset=utf-8" },
			});
		}
		if (url.pathname === "/api/graph" && request.method === "GET") {
			const layout = existsSync(layoutPath) ? (JSON.parse(readFileSync(layoutPath, "utf8")) as unknown) : null;
			return json({ path: graphPath, text: readFileSync(graphPath, "utf8"), layout });
		}
		if (url.pathname === "/api/validate" && request.method === "POST") {
			const body = (await request.json()) as { text?: string };
			return json(validateText(String(body.text ?? "")));
		}
		if (url.pathname === "/api/graph" && request.method === "PUT") {
			const body = (await request.json()) as { text?: string; layout?: unknown };
			const text = String(body.text ?? "");
			const report = validateText(text);
			if (!report.valid) {
				return json({ ok: false, problems: report.errors, warnings: report.warnings });
			}
			const current = readFileSync(graphPath, "utf8");
			const created = backup(graphPath, current, text);
			writeFileSync(graphPath, text, "utf8");
			if (body.layout !== undefined && typeof body.layout === "object" && body.layout !== null) {
				writeFileSync(layoutPath, `${JSON.stringify(body.layout, null, "\t")}\n`, "utf8");
			}
			return json({
				ok: true,
				warnings: report.warnings,
				...(created === undefined
					? {}
					: { backup: created.path, ...(created.pruned === 0 ? {} : { pruned: created.pruned }) }),
			});
		}
		return new Response("not found", { status: 404 });
	},
});

process.stdout.write(`DoG 图编辑器: http://127.0.0.1:${server.port}/  (${graphPath})\n`);
process.stdout.write(`保存前会用引擎校验器验证；不通过不写盘。Ctrl-C 退出。\n`);
if (open && process.platform === "darwin") Bun.spawn(["open", `http://127.0.0.1:${server.port}/`]);
