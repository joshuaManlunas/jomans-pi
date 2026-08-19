import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type BackgroundTaskState =
	| "starting"
	| "running"
	| "stopping"
	| "exited"
	| "failed"
	| "stopped";

export type BackgroundTaskSnapshot = {
	id: string;
	command: string;
	cwd: string;
	state: BackgroundTaskState;
	pid?: number;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	signal?: string | null;
	error?: string;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
};

type ManagerOptions = {
	shell?: string;
	terminationGraceMs?: number;
	killGraceMs?: number;
	maxOutputBytes?: number;
};

type TaskRecord = Omit<
	BackgroundTaskSnapshot,
	"stdout" | "stderr" | "stdoutTruncated" | "stderrTruncated"
> & {
	child?: ChildProcess;
	stdoutBuffer: Buffer;
	stderrBuffer: Buffer;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	spawned: boolean;
	settled: boolean;
	stopRequested: boolean;
	parentClosed: boolean;
	parentExitCode: number | null;
	parentSignal: string | null;
	startupPromise: Promise<void>;
	resolveStartup: () => void;
	parentClosePromise: Promise<void>;
	resolveParentClose: () => void;
	settledPromise: Promise<void>;
	resolveSettled: () => void;
	terminationPromise?: Promise<string | undefined>;
	onStdout?: (chunk: Buffer | string) => void;
	onStderr?: (chunk: Buffer | string) => void;
	onError?: (error: Error) => void;
	onClose?: (code: number | null, signal: string | null) => void;
};

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const POLL_INTERVAL_MS = 20;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function positive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: fallback;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function decodeTail(buffer: Buffer): string {
	let start = 0;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start).toString("utf8");
}

function terminal(state: BackgroundTaskState): boolean {
	return state === "exited" || state === "failed" || state === "stopped";
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class BackgroundTaskManager {
	private readonly tasks = new Map<string, TaskRecord>();
	private readonly shell?: string;
	private readonly terminationGraceMs: number;
	private readonly killGraceMs: number;
	private readonly maxOutputBytes: number;
	private nextId = 1;

	constructor(options: ManagerOptions = {}) {
		this.shell = options.shell;
		this.terminationGraceMs = positive(
			options.terminationGraceMs,
			DEFAULT_TERMINATION_GRACE_MS,
		);
		this.killGraceMs = positive(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
		this.maxOutputBytes = positive(
			options.maxOutputBytes,
			DEFAULT_MAX_OUTPUT_BYTES,
		);
	}

	async start(command: string, cwd: string): Promise<BackgroundTaskSnapshot> {
		if (!command.trim()) throw new Error("Background command cannot be empty");

		const id = `bg-${this.nextId++}`;
		const startup = deferred();
		const parentClose = deferred();
		const settled = deferred();
		const task: TaskRecord = {
			id,
			command,
			cwd,
			state: "starting",
			startedAt: Date.now(),
			stdoutBuffer: Buffer.alloc(0),
			stderrBuffer: Buffer.alloc(0),
			stdoutTruncated: false,
			stderrTruncated: false,
			spawned: false,
			settled: false,
			stopRequested: false,
			parentClosed: false,
			parentExitCode: null,
			parentSignal: null,
			startupPromise: startup.promise,
			resolveStartup: startup.resolve,
			parentClosePromise: parentClose.promise,
			resolveParentClose: parentClose.resolve,
			settledPromise: settled.promise,
			resolveSettled: settled.resolve,
		};
		this.tasks.set(id, task);

		const windows = process.platform === "win32";
		const shell =
			this.shell ??
			(windows
				? process.env.ComSpec || "cmd.exe"
				: process.env.SHELL || "/bin/sh");
		const shellArgs = windows ? ["/d", "/s", "/c", command] : ["-lc", command];

		try {
			task.child = spawn(shell, shellArgs, {
				cwd,
				detached: !windows,
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			task.error = `Failed to start: ${errorMessage(error)}`;
			task.state = "failed";
			task.endedAt = Date.now();
			task.settled = true;
			task.resolveStartup();
			task.resolveParentClose();
			task.resolveSettled();
			return this.snapshot(task);
		}

		const child = task.child;
		task.onStdout = (chunk) => this.appendOutput(task, "stdout", chunk);
		task.onStderr = (chunk) => this.appendOutput(task, "stderr", chunk);
		task.onError = (error) => this.handleChildError(task, error);
		task.onClose = (code, signal) => {
			void this.handleChildClose(task, code, signal);
		};
		child.stdout?.on("data", task.onStdout);
		child.stderr?.on("data", task.onStderr);
		child.on("error", task.onError);
		child.once("close", task.onClose);
		child.once("spawn", () => {
			task.spawned = true;
			task.pid = child.pid;
			if (!task.stopRequested && !task.settled && task.state === "starting")
				task.state = "running";
			task.resolveStartup();
		});

		await task.startupPromise;
		if (task.stopRequested) await task.settledPromise;
		return this.snapshot(task);
	}

	list(): BackgroundTaskSnapshot[] {
		return [...this.tasks.values()].map((task) => this.snapshot(task));
	}

	inspect(id: string): BackgroundTaskSnapshot | undefined {
		const task = this.tasks.get(id);
		return task ? this.snapshot(task) : undefined;
	}

	async stop(id: string): Promise<BackgroundTaskSnapshot> {
		const task = this.tasks.get(id);
		if (!task) throw new Error(`Unknown background task: ${id}`);
		if (terminal(task.state)) return this.snapshot(task);

		task.stopRequested = true;
		task.state = "stopping";
		await task.startupPromise;
		if (task.settled) return this.snapshot(task);
		const terminationError = await this.terminate(task);
		await Promise.race([task.parentClosePromise, sleep(this.killGraceMs)]);
		if (terminationError) task.error = terminationError;
		this.finish(task, task.parentExitCode, task.parentSignal, terminationError);
		await task.settledPromise;
		return this.snapshot(task);
	}

	async cleanup(): Promise<void> {
		const active = [...this.tasks.values()].filter(
			(task) => !terminal(task.state),
		);
		await Promise.allSettled(active.map((task) => this.stop(task.id)));
	}

	private snapshot(task: TaskRecord): BackgroundTaskSnapshot {
		return {
			id: task.id,
			command: task.command,
			cwd: task.cwd,
			state: task.state,
			pid: task.pid,
			startedAt: task.startedAt,
			endedAt: task.endedAt,
			exitCode: task.exitCode,
			signal: task.signal,
			error: task.error,
			stdout: decodeTail(task.stdoutBuffer),
			stderr: decodeTail(task.stderrBuffer),
			stdoutTruncated: task.stdoutTruncated,
			stderrTruncated: task.stderrTruncated,
		};
	}

	private appendOutput(
		task: TaskRecord,
		stream: "stdout" | "stderr",
		chunk: Buffer | string,
	): void {
		const key = stream === "stdout" ? "stdoutBuffer" : "stderrBuffer";
		const truncationKey =
			stream === "stdout" ? "stdoutTruncated" : "stderrTruncated";
		const next = Buffer.concat([
			task[key],
			Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
		]);
		if (next.length > this.maxOutputBytes) {
			task[key] = next.subarray(next.length - this.maxOutputBytes);
			task[truncationKey] = true;
		} else {
			task[key] = next;
		}
	}

	private handleChildError(task: TaskRecord, error: Error): void {
		task.error = `${task.spawned ? "Process error" : "Failed to start"}: ${error.message}`;
		task.resolveStartup();
		if (!task.spawned) {
			task.parentClosed = true;
			task.resolveParentClose();
			this.finish(task, null, null, task.error);
		}
	}

	private async handleChildClose(
		task: TaskRecord,
		code: number | null,
		signal: string | null,
	): Promise<void> {
		task.parentClosed = true;
		task.parentExitCode = code;
		task.parentSignal = signal;
		task.resolveStartup();
		task.resolveParentClose();
		if (task.settled || task.stopRequested) return;

		let terminationError: string | undefined;
		if (this.isAlive(task)) {
			task.state = "stopping";
			terminationError = await this.terminate(task);
			if (terminationError) task.error = terminationError;
		}
		this.finish(task, code, signal, terminationError);
	}

	private terminate(task: TaskRecord): Promise<string | undefined> {
		if (task.terminationPromise) return task.terminationPromise;
		task.terminationPromise = this.terminateOnce(task);
		return task.terminationPromise;
	}

	private async terminateOnce(task: TaskRecord): Promise<string | undefined> {
		if (!this.isAlive(task)) return undefined;
		try {
			this.signal(task, "SIGTERM");
		} catch (error) {
			return `Failed to terminate ${task.id}: ${errorMessage(error)}`;
		}
		if (await this.waitUntilGone(task, this.terminationGraceMs))
			return undefined;

		try {
			this.signal(task, "SIGKILL");
		} catch (error) {
			return `Failed to kill ${task.id}: ${errorMessage(error)}`;
		}
		if (await this.waitUntilGone(task, this.killGraceMs)) return undefined;
		return `Process ${task.id} did not exit after SIGKILL`;
	}

	private signal(task: TaskRecord, signal: NodeJS.Signals): void {
		const pid = task.pid ?? task.child?.pid;
		if (!pid) throw new Error("process has no PID");
		if (process.platform === "win32") {
			const result = spawnSync(
				"taskkill",
				["/pid", String(pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])],
				{ encoding: "utf8", windowsHide: true },
			);
			if (result.error) throw result.error;
			if (result.status !== 0 && this.isAlive(task)) {
				throw new Error(
					result.stderr.trim() || `taskkill exited with code ${result.status}`,
				);
			}
			return;
		}
		try {
			process.kill(-pid, signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}

	private isAlive(task: TaskRecord): boolean {
		const pid = task.pid ?? task.child?.pid;
		if (!pid) return false;
		try {
			process.kill(process.platform === "win32" ? pid : -pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ESRCH";
		}
	}

	private async waitUntilGone(
		task: TaskRecord,
		timeoutMs: number,
	): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		do {
			if (!this.isAlive(task)) return true;
			await sleep(
				Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
			);
		} while (Date.now() < deadline);
		return !this.isAlive(task);
	}

	private finish(
		task: TaskRecord,
		code: number | null,
		signal: string | null,
		terminationError?: string,
	): void {
		if (task.settled) return;
		task.settled = true;
		task.endedAt = Date.now();
		task.exitCode = code;
		task.signal = signal;
		if (terminationError) {
			task.state = "failed";
			task.error = terminationError;
		} else if (task.stopRequested) {
			task.state = "stopped";
		} else if (task.error) {
			task.state = "failed";
		} else if (code === 0) {
			task.state = "exited";
		} else {
			task.state = "failed";
			task.error = signal
				? `Process terminated by ${signal}`
				: `Process exited with code ${code ?? "unknown"}`;
		}

		if (task.onStdout) task.child?.stdout?.off("data", task.onStdout);
		if (task.onStderr) task.child?.stderr?.off("data", task.onStderr);
		task.child?.stdout?.destroy();
		task.child?.stderr?.destroy();
		if (task.onError) {
			task.child?.off("error", task.onError);
			task.child?.on("error", () => {});
		}
		task.resolveStartup();
		task.resolveParentClose();
		task.resolveSettled();
	}
}

type RequestResult = {
	message: string;
	level: "info" | "warning" | "error";
};

function taskLine(task: BackgroundTaskSnapshot): string {
	const pid = task.pid ? ` pid=${task.pid}` : "";
	return `${task.id} ${task.state}${pid} — ${task.command}`;
}

function taskDetails(task: BackgroundTaskSnapshot): string {
	const lines = [
		taskLine(task),
		`cwd: ${task.cwd}`,
		`exit: ${task.exitCode ?? "-"}${task.signal ? ` signal=${task.signal}` : ""}`,
	];
	if (task.error) lines.push(`error: ${task.error}`);
	lines.push(
		`stdout${task.stdoutTruncated ? " (tail; truncated)" : ""}:\n${task.stdout || "(empty)"}`,
		`stderr${task.stderrTruncated ? " (tail; truncated)" : ""}:\n${task.stderr || "(empty)"}`,
	);
	return lines.join("\n");
}

function commandAfter(args: string, keyword: string): string {
	let command = args.slice(keyword.length).trimStart();
	if (/^--(?:\s|$)/.test(command)) command = command.slice(2).trimStart();
	return command;
}

export async function runBackgroundRequest(
	manager: BackgroundTaskManager,
	args: string,
	cwd: string,
): Promise<RequestResult> {
	const input = args.trim();
	if (!input) {
		return {
			message:
				"Usage: background <command> | background list | background inspect <id> | background stop <id>",
			level: "warning",
		};
	}

	if (input === "list") {
		const tasks = manager.list();
		return {
			message: tasks.length
				? tasks.map(taskLine).join("\n")
				: "No background tasks.",
			level: "info",
		};
	}

	for (const action of ["inspect", "stop"] as const) {
		if (input === action || input.startsWith(`${action} `)) {
			const id = input.slice(action.length).trim();
			if (!id)
				return {
					message: `Usage: background ${action} <id>`,
					level: "warning",
				};
			const task = manager.inspect(id);
			if (!task)
				return { message: `Unknown background task: ${id}`, level: "error" };
			if (action === "inspect")
				return { message: taskDetails(task), level: "info" };
			const stopped = await manager.stop(id);
			return {
				message:
					taskLine(stopped) +
					(stopped.error ? `\nerror: ${stopped.error}` : ""),
				level: stopped.state === "failed" ? "error" : "info",
			};
		}
	}

	let command = input;
	for (const keyword of ["run", "start"] as const) {
		if (input === keyword || input.startsWith(`${keyword} `)) {
			command = commandAfter(input, keyword);
			if (!command.trim()) {
				return {
					message: `Usage: background ${keyword} [--] <command>`,
					level: "warning",
				};
			}
			break;
		}
	}

	const task = await manager.start(command, cwd);
	return {
		message:
			task.state === "failed"
				? `Failed to start ${task.id}: ${task.error ?? "unknown error"}`
				: `Started ${task.id}${task.pid ? ` (pid ${task.pid})` : ""}: ${task.command}`,
		level: task.state === "failed" ? "error" : "info",
	};
}

export default function backgroundTaskExtension(pi: ExtensionAPI): void {
	const manager = new BackgroundTaskManager();
	const handle = async (
		args: string,
		ctx: {
			cwd: string;
			ui: { notify(message: string, level: RequestResult["level"]): void };
		},
	): Promise<void> => {
		const result = await runBackgroundRequest(manager, args, ctx.cwd);
		ctx.ui.notify(result.message, result.level);
	};

	pi.registerCommand("background", {
		description: "Start, list, inspect, or stop background processes",
		handler: handle,
	});

	pi.on("input", async (event, ctx) => {
		const match = /^background(?:\s+([\s\S]*))?$/.exec(event.text);
		if (!match) return { action: "continue" };
		await handle(match[1] ?? "", ctx);
		return { action: "handled" };
	});

	pi.on("session_shutdown", async () => {
		await manager.cleanup();
	});
}
