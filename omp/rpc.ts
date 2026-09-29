/**
 * Minimal OMP RPC client: spawn `omp --mode rpc`, speak newline-delimited JSON
 * over stdio, correlate responses by id, and answer host-tool callbacks.
 *
 * Only the surface this project needs is implemented — prompt lifecycle, host
 * tools, abort, and frame subscription. The wire contract is `omp://rpc.md`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface RpcFrame {
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface HostToolDefinition {
	readonly name: string;
	readonly label?: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;
	readonly loadMode?: "essential" | "discoverable";
	readonly hidden?: boolean;
}

export interface HostToolCall {
	readonly id: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly arguments: Record<string, unknown>;
}

export interface HostToolOutcome {
	readonly text: string;
	readonly isError?: boolean;
}

/** What a host tool may do while it runs: stream progress, and watch for cancellation. */
export interface HostToolContext {
	readonly update: (text: string) => void;
	readonly signal: AbortSignal;
}

export interface RpcSessionOptions {
	readonly command: readonly string[];
	readonly cwd: string;
	readonly env?: Readonly<Record<string, string>>;
	/** Every inbound frame, for streaming UIs. */
	readonly onEvent?: (frame: RpcFrame) => void;
	readonly onStderr?: (chunk: string) => void;
	/** Startup budget for the `ready` frame. */
	readonly startupTimeoutMs?: number;
}

interface PendingRequest {
	readonly command: string;
	readonly resolve: (data: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
}

type FrameHandler = (frame: RpcFrame) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class RpcSession {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly handlers = new Map<string, Set<FrameHandler>>();
	private buffer = "";
	private counter = 0;
	private closed: Error | undefined;
	private exitPromise: Promise<void>;

	private constructor(child: ChildProcessWithoutNullStreams, options: RpcSessionOptions) {
		this.child = child;
		this.child.stdout.setEncoding("utf8");
		this.child.stdout.on("data", (chunk: string) => this.consume(chunk, options));
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => options.onStderr?.(chunk));
		this.exitPromise = new Promise<void>((resolve) => {
			this.child.on("close", () => {
				this.closed = new Error("omp rpc session exited");
				for (const [, pending] of this.pending) {
					clearTimeout(pending.timer);
					pending.reject(this.closed);
				}
				this.pending.clear();
				this.emit({ type: "session_exit" });
				resolve();
			});
		});
	}

	/** Spawn one RPC session and wait for its `ready` frame. */
	static async start(options: RpcSessionOptions): Promise<RpcSession> {
		const [command, ...args] = options.command;
		if (command === undefined) throw new Error("RPC command must not be empty");
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		const session = new RpcSession(child, options);
		await session.waitForFrame((frame) => frame.type === "ready", options.startupTimeoutMs ?? 60_000, "ready frame");
		return session;
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	/** Subscribe to one inbound frame type; returns an unsubscribe function. */
	on(type: string, handler: FrameHandler): () => void {
		const set = this.handlers.get(type) ?? new Set<FrameHandler>();
		set.add(handler);
		this.handlers.set(type, set);
		return () => set.delete(handler);
	}

	/** Send one command and resolve with its response payload. */
	async request(
		command: string,
		payload: Readonly<Record<string, unknown>> = {},
		options: { readonly timeoutMs?: number } = {},
	): Promise<unknown> {
		return this.issue(command, payload, `req_${++this.counter}`, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
	}

	private issue(
		command: string,
		payload: Readonly<Record<string, unknown>>,
		id: string,
		timeoutMs: number,
	): Promise<unknown> {
		if (this.closed !== undefined) throw this.closed;
		const response = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`omp rpc command ${command} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timer.unref();
			this.pending.set(id, { command, resolve, reject, timer });
		});
		this.write({ id, type: command, ...payload });
		return response;
	}

	/** Resolve once a frame matching the predicate arrives. */
	waitForFrame(predicate: (frame: RpcFrame) => boolean, timeoutMs: number, label: string): Promise<RpcFrame> {
		return new Promise<RpcFrame>((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`timed out waiting for ${label}`));
			}, timeoutMs);
			timer.unref();
			const unsubscribe = this.onAny((frame) => {
				if (!predicate(frame)) return;
				clearTimeout(timer);
				unsubscribe();
				resolve(frame);
			});
		});
	}

	/** Subscribe to every frame; returns an unsubscribe function. */
	onAny(handler: FrameHandler): () => void {
		return this.on("*", handler);
	}

	/** Send one prompt and resolve when its work ends: `agentInvoked: false` completes on the response itself, otherwise the matching `prompt_result` frame. */
	async prompt(message: string, options: { readonly timeoutMs?: number } = {}): Promise<RpcFrame> {
		const id = `req_${++this.counter}`;
		const result = this.waitForFrame(
			(frame) => frame.type === "prompt_result" && frame.id === id,
			options.timeoutMs ?? 60 * 60_000,
			`prompt_result for ${id}`,
		);
		const response = (await this.issue("prompt", { message }, id, 60_000)) as { agentInvoked?: boolean } | undefined;
		if (response?.agentInvoked === false) return { type: "prompt_result", id, agentInvoked: false };
		return result;
	}

	async abort(): Promise<void> {
		await this.request("abort", {}, { timeoutMs: 30_000 }).catch(() => undefined);
	}

	/** Register host-owned tools; the handler answers every call. */
	async registerHostTools(
		definitions: readonly HostToolDefinition[],
		handler: (call: HostToolCall, context: HostToolContext) => Promise<HostToolOutcome>,
	): Promise<readonly string[]> {
		this.on("host_tool_call", (frame) => {
			void this.answerHostTool(frame, handler);
		});
		const data = (await this.request("set_host_tools", { tools: definitions })) as
			| { toolNames?: readonly string[] }
			| undefined;
		return data?.toolNames ?? [];
	}

	/** Close stdin, then wait (briefly) for the child to exit. */
	async close(options: { readonly timeoutMs?: number } = {}): Promise<void> {
		if (this.child.exitCode !== null || this.child.signalCode !== null) return;
		this.child.stdin.end();
		const timeoutMs = options.timeoutMs ?? 5_000;
		const exited = await Promise.race([
			this.exitPromise.then(() => true),
			new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), timeoutMs);
				timer.unref();
			}),
		]);
		if (exited) return;
		this.child.kill("SIGTERM");
		const terminated = await Promise.race([
			this.exitPromise.then(() => true),
			new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), 2_000);
				timer.unref();
			}),
		]);
		if (!terminated) this.child.kill("SIGKILL");
	}

	private async answerHostTool(
		frame: RpcFrame,
		handler: (call: HostToolCall, context: HostToolContext) => Promise<HostToolOutcome>,
	): Promise<void> {
		const call: HostToolCall = {
			id: String(frame.id ?? ""),
			toolCallId: String(frame.toolCallId ?? ""),
			toolName: String(frame.toolName ?? ""),
			arguments: (frame.arguments ?? {}) as Record<string, unknown>,
		};
		const controller = new AbortController();
		const unsubscribe = this.on("host_tool_cancel", (cancel) => {
			if (String(cancel.targetId ?? "") === call.id) controller.abort();
		});
		let outcome: HostToolOutcome;
		try {
			outcome = await handler(call, {
				update: (text) => this.writeHostToolUpdate(call.id, text),
				signal: controller.signal,
			});
		} catch (error) {
			outcome = { text: error instanceof Error ? error.message : String(error), isError: true };
		} finally {
			unsubscribe();
		}
		this.write({
			type: "host_tool_result",
			id: call.id,
			...(outcome.isError === true ? { isError: true } : {}),
			result: { content: [{ type: "text", text: outcome.text }] },
		});
	}

	private writeHostToolUpdate(id: string, text: string): void {
		this.write({ type: "host_tool_update", id, partialResult: { content: [{ type: "text", text }] } });
	}

	private write(frame: Record<string, unknown>): void {
		if (this.child.stdin.destroyed) return;
		this.child.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	private consume(chunk: string, options: RpcSessionOptions): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.trim().length > 0) this.dispatch(line, options);
			newline = this.buffer.indexOf("\n");
		}
	}

	private dispatch(line: string, options: RpcSessionOptions): void {
		let frame: RpcFrame;
		try {
			frame = JSON.parse(line) as RpcFrame;
		} catch {
			return;
		}
		if (frame.type === "response" && typeof frame.id === "string") {
			const pending = this.pending.get(frame.id);
			if (pending !== undefined) {
				this.pending.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.success === true) pending.resolve(frame.data);
				else pending.reject(new Error(String(frame.error ?? `${pending.command} failed`)));
			}
		}
		options.onEvent?.(frame);
		this.emit(frame);
	}

	private emit(frame: RpcFrame): void {
		for (const handler of this.handlers.get(frame.type) ?? []) handler(frame);
		for (const handler of this.handlers.get("*") ?? []) handler(frame);
	}
}
