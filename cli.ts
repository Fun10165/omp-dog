#!/usr/bin/env node
/**
 * omp-dog — DoG (DAG of Goals) acceptance gates for OMP, as a plain program.
 *
 * Four commands, no plugin: `create` freezes a graph's targets, `run` judges
 * them (dispatching one `omp --mode rpc` verifier session per agentic goal),
 * `status` reads the ledger, and `host` starts an OMP session whose DoG tools
 * this process serves over RPC.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DogRun } from "./core/model.ts";
import type { DogRepository } from "./core/storage.ts";
import { resolveOmpBin } from "./omp/config.ts";
import { runHostSession } from "./omp/host.ts";
import { buildReport, compiledSummary } from "./omp/report.ts";
import { createDogRuntime } from "./omp/runtime.ts";

interface CliOptions {
	readonly project: string;
	readonly ompBin: string;
	readonly concurrency: number;
	readonly verifierTimeoutMs: number;
	readonly model?: string;
	readonly thinking?: string;
	readonly rest: readonly string[];
}

const USAGE = `omp-dog — DoG acceptance gates over OMP

Usage:
  omp-dog create <graph-file>          compile a graph and freeze its targets
  omp-dog run <graph-id>               judge the latest revision, print the report
  omp-dog status <run-id|graph-id>     read one run record
  omp-dog host                         start an OMP session whose DoG tools this process serves

Options:
  --project <dir>      project directory (default: the current directory)
  --omp <path>         omp executable (default: $OMP_BIN, then "omp")
  --model <model>      model for verifier sessions (and the host session)
  --thinking <level>   thinking level for verifier sessions
  --concurrency <n>    concurrent verifier sessions (default 4)
  --timeout <seconds>  budget for one verdict (default 900)
  --help, -h           this text

Everything after \`--\` is passed to the main session (host only).
Exit codes for run: 0 success/partial_success, 1 any other root state, 2 usage error.`;

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...args] = argv;
	if (command === undefined || command === "--help" || command === "-h" || command === "help") {
		process.stdout.write(`${USAGE}\n`);
		return command === undefined ? 2 : 0;
	}
	const parsed = parseArgs(args);
	if (parsed instanceof Error) {
		process.stderr.write(`${parsed.message}\n\n${USAGE}\n`);
		return 2;
	}
	const runtime = createDogRuntime({
		projectDir: parsed.project,
		ompBin: parsed.ompBin,
		concurrency: parsed.concurrency,
		verifierTimeoutMs: parsed.verifierTimeoutMs,
		...(parsed.model === undefined ? {} : { model: parsed.model }),
		...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
	});
	switch (command) {
		case "create": {
			const file = parsed.rest[0];
			if (file === undefined) return usageError("create needs a graph file");
			const compiled = await runtime.engine.create(readGraphFile(resolve(file)), {
				captureBaseDir: parsed.project,
			});
			process.stdout.write(`${JSON.stringify(compiledSummary(compiled), null, 2)}\n`);
			return 0;
		}
		case "run": {
			const graphId = parsed.rest[0];
			if (graphId === undefined) return usageError("run needs a graph ID");
			const controller = new AbortController();
			process.on("SIGINT", () => controller.abort());
			const showProgress = process.stderr.isTTY === true;
			const run = await runtime.engine.run(graphId, {
				signal: controller.signal,
				...(showProgress
					? { onProgress: (progress: DogRun) => process.stderr.write(`\r${progressLine(progress)}`) }
					: {}),
			});
			if (showProgress) process.stderr.write("\n");
			process.stdout.write(`${JSON.stringify(buildReport(run), null, 2)}\n`);
			return run.rootState === "success" || run.rootState === "partial_success" ? 0 : 1;
		}
		case "status": {
			const key = parsed.rest[0];
			if (key === undefined) return usageError("status needs a run ID or a graph ID");
			const run = await resolveRun(runtime.repository, key);
			if (run === undefined) {
				process.stderr.write(`no run or graph matches ${key}\n`);
				return 1;
			}
			process.stdout.write(`${JSON.stringify(buildReport(run), null, 2)}\n`);
			return 0;
		}
		case "host":
			return runHostSession({
				projectDir: parsed.project,
				ompBin: parsed.ompBin,
				concurrency: parsed.concurrency,
				verifierTimeoutMs: parsed.verifierTimeoutMs,
				...(parsed.model === undefined ? {} : { model: parsed.model }),
				...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
				ompArgs: parsed.rest,
			});
		default:
			return usageError(`unknown command ${command}`);
	}
}

function usageError(message: string): number {
	process.stderr.write(`${message}\n\n${USAGE}\n`);
	return 2;
}

function progressLine(run: DogRun): string {
	return Object.entries(run.goals)
		.sort((left, right) => left[0].localeCompare(right[0]))
		.map(([goalId, result]) => `${goalId}=${result.state}`)
		.join(" ");
}

/** A run ID wins over a graph ID; a graph ID resolves to its latest terminal run. */
async function resolveRun(repository: DogRepository, key: string): Promise<DogRun | undefined> {
	const direct = await repository.loadRun(key).catch(() => undefined);
	if (direct !== undefined) return direct;
	return repository.loadLatestSettledRun(key);
}

function readGraphFile(path: string): unknown {
	const text = readFileSync(path, "utf8");
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function parseArgs(args: readonly string[]): CliOptions | Error {
	let project = process.cwd();
	let ompBin: string | undefined;
	let model: string | undefined;
	let thinking: string | undefined;
	let concurrency = 4;
	let timeoutSeconds = 900;
	const rest: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const value = (): string => {
			const next = args[++index];
			if (next === undefined) throw new Error(`${arg} needs a value`);
			return next;
		};
		try {
			if (arg === "--") {
				rest.push(...args.slice(index + 1));
				break;
			}
			if (arg === "--project") project = resolve(value());
			else if (arg === "--omp") ompBin = value();
			else if (arg === "--model") model = value();
			else if (arg === "--thinking") thinking = value();
			else if (arg === "--concurrency") concurrency = positiveInteger(value(), "--concurrency");
			else if (arg === "--timeout") timeoutSeconds = positiveInteger(value(), "--timeout");
			else if (arg.startsWith("--")) return new Error(`unknown option ${arg}`);
			else rest.push(arg);
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
	}
	return {
		project,
		ompBin: resolveOmpBin(ompBin),
		concurrency,
		verifierTimeoutMs: timeoutSeconds * 1_000,
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		rest,
	};
}

function positiveInteger(value: string, flag: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
	return parsed;
}

try {
	const code = await main(process.argv.slice(2));
	process.exitCode = code;
} catch (error) {
	process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
