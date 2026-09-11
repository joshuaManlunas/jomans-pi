import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import backgroundTaskExtension, {
	BackgroundTaskManager,
	type BackgroundTaskSnapshot,
	runBackgroundRequest,
} from "./index.ts";

const managers = new Set<BackgroundTaskManager>();

function manager(
	options: ConstructorParameters<typeof BackgroundTaskManager>[0] = {},
): BackgroundTaskManager {
	const instance = new BackgroundTaskManager(options);
	managers.add(instance);
	return instance;
}

function quote(value: string): string {
	if (process.platform === "win32") return `"${value.replaceAll('"', '\\"')}"`;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function nodeCommand(source: string): string {
	return `${quote(process.execPath)} -e ${quote(source)}`;
}

async function waitForTask(
	instance: BackgroundTaskManager,
	id: string,
	predicate: (task: BackgroundTaskSnapshot) => boolean,
	timeoutMs = 2_000,
): Promise<BackgroundTaskSnapshot> {
	const deadline = Date.now() + timeoutMs;
	do {
		const task = instance.inspect(id);
		if (!task) throw new Error(`missing task ${id}`);
		if (predicate(task)) return task;
		await Bun.sleep(10);
	} while (Date.now() < deadline);
	throw new Error(`timed out waiting for ${id}`);
}

function finished(task: BackgroundTaskSnapshot): boolean {
	return ["exited", "failed", "stopped"].includes(task.state);
}

afterEach(async () => {
	await Promise.allSettled([...managers].map((instance) => instance.cleanup()));
	managers.clear();
});

test("starts asynchronously and lists a stable identifier", async () => {
	const instance = manager();
	const task = await instance.start(
		nodeCommand("setInterval(() => {}, 1_000)"),
		process.cwd(),
	);

	expect(task.id).toBe("bg-1");
	expect(task.state).toBe("running");
	expect(task.pid).toBeNumber();
	expect(instance.list().map((item) => item.id)).toEqual(["bg-1"]);
	expect(instance.inspect(task.id)?.command).toBe(task.command);
});

test("captures stdout and stderr through process exit", async () => {
	const instance = manager();
	const started = await instance.start(
		nodeCommand("process.stdout.write('out'); process.stderr.write('err')"),
		process.cwd(),
	);
	const task = await waitForTask(instance, started.id, finished);

	expect(task.state).toBe("exited");
	expect(task.exitCode).toBe(0);
	expect(task.stdout).toBe("out");
	expect(task.stderr).toBe("err");
});

test("reports nonzero runtime failure", async () => {
	const instance = manager();
	const started = await instance.start(
		nodeCommand("process.stderr.write('boom'); process.exit(7)"),
		process.cwd(),
	);
	const task = await waitForTask(instance, started.id, finished);

	expect(task.state).toBe("failed");
	expect(task.exitCode).toBe(7);
	expect(task.stderr).toBe("boom");
	expect(task.error).toContain("code 7");
});

test("retains a stable failed task when the shell cannot start", async () => {
	const instance = manager({
		shell: "/definitely/missing/background-task-shell",
	});
	const task = await instance.start("echo never", process.cwd());

	expect(task.id).toBe("bg-1");
	expect(task.state).toBe("failed");
	expect(task.error).toContain("Failed to start");
	expect(instance.inspect(task.id)?.state).toBe("failed");
});

test("stops idempotently and escalates a SIGTERM-resistant process group", async () => {
	if (process.platform === "win32") return;
	const instance = manager({ terminationGraceMs: 50, killGraceMs: 500 });
	const started = await instance.start(
		nodeCommand(
			"process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)",
		),
		process.cwd(),
	);

	const stopped = await instance.stop(started.id);
	expect(stopped.state).toBe("stopped");
	expect((await instance.stop(started.id)).state).toBe("stopped");
	const pid = started.pid;
	if (pid) {
		expect(() => process.kill(-pid, 0)).toThrow();
	}
});

test("uses System32 taskkill when PATH omits it", async () => {
	if (process.platform !== "win32") return;
	const originalPath = process.env.PATH;
	const instance = manager({ terminationGraceMs: 50, killGraceMs: 500 });
	try {
		process.env.PATH = "";
		const started = await instance.start(
			nodeCommand("setTimeout(() => {}, 1_000)"),
			process.cwd(),
		);
		expect((await instance.stop(started.id)).state).toBe("stopped");
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
	}
});

test("bounds captured output while continuing to drain it", async () => {
	const instance = manager({ maxOutputBytes: 128 });
	const started = await instance.start(
		nodeCommand("process.stdout.write('x'.repeat(4_096))"),
		process.cwd(),
	);
	const task = await waitForTask(instance, started.id, finished);

	expect(Buffer.byteLength(task.stdout)).toBeLessThanOrEqual(128);
	expect(task.stdoutTruncated).toBe(true);
	expect(task.state).toBe("exited");
});

test("does not expose a split UTF-8 character at the output tail", async () => {
	const instance = manager({ maxOutputBytes: 5 });
	const started = await instance.start(
		nodeCommand("process.stdout.write('a😀😀')"),
		process.cwd(),
	);
	const task = await waitForTask(instance, started.id, finished);

	expect(task.stdout).toBe("😀");
	expect(task.stdoutTruncated).toBe(true);
});

test("cleanup owns a task even before its spawn event", async () => {
	const instance = manager({ terminationGraceMs: 50, killGraceMs: 500 });
	const pending = instance.start(
		nodeCommand("setInterval(() => {}, 1_000)"),
		process.cwd(),
	);

	await instance.cleanup();
	const task = await pending;
	expect(task.state).toBe("stopped");
	const pid = task.pid;
	if (process.platform !== "win32" && pid) {
		expect(() => process.kill(-pid, 0)).toThrow();
	}
});

test("cleanup stops every active task", async () => {
	const instance = manager({ terminationGraceMs: 50, killGraceMs: 500 });
	const first = await instance.start(
		nodeCommand("setInterval(() => {}, 1_000)"),
		process.cwd(),
	);
	const second = await instance.start(
		nodeCommand("setInterval(() => {}, 1_000)"),
		process.cwd(),
	);

	await instance.cleanup();
	expect(instance.inspect(first.id)?.state).toBe("stopped");
	expect(instance.inspect(second.id)?.state).toBe("stopped");
});

test("request operations start, list, inspect, and stop", async () => {
	const instance = manager({ terminationGraceMs: 50, killGraceMs: 500 });
	const start = await runBackgroundRequest(
		instance,
		`run --\t${nodeCommand("setInterval(() => {}, 1_000)")}`,
		process.cwd(),
	);
	expect(start.level).toBe("info");
	expect(start.message).toContain("Started bg-1");

	expect(
		(await runBackgroundRequest(instance, "list", process.cwd())).message,
	).toContain("bg-1 running");
	expect(
		(await runBackgroundRequest(instance, "inspect bg-1", process.cwd()))
			.message,
	).toContain("stdout:");
	expect(
		(await runBackgroundRequest(instance, "stop bg-1", process.cwd())).message,
	).toContain("bg-1 stopped");
	expect(
		(await runBackgroundRequest(instance, "inspect missing", process.cwd()))
			.level,
	).toBe("error");
});

test("forget refuses active tasks and removes only the selected finished task", async () => {
	const instance = manager({ terminationGraceMs: 50, killGraceMs: 500 });
	const active = await instance.start(nodeCommand("setInterval(() => {}, 1_000)"), process.cwd());
	expect((await runBackgroundRequest(instance, `forget ${active.id}`, process.cwd())).level).toBe("error");
	expect(instance.inspect(active.id)?.state).toBe("running");
	await instance.stop(active.id);
	const other = await instance.start(nodeCommand("process.stdout.write('retained')"), process.cwd());
	await waitForTask(instance, other.id, finished);
	expect((await runBackgroundRequest(instance, `forget ${active.id}`, process.cwd())).message).toBe(`Forgot background task: ${active.id}`);
	expect(instance.inspect(active.id)).toBeUndefined();
	expect(instance.inspect(other.id)?.stdout).toBe("retained");
	expect((await runBackgroundRequest(instance, `forget ${active.id}`, process.cwd())).message).toBe(`Unknown background task: ${active.id}`);
	const next = await instance.start(nodeCommand(""), process.cwd());
	expect(next.id).toBe("bg-3");
	expect((await runBackgroundRequest(instance, "forget", process.cwd())).level).toBe("warning");
});

test("forgotten completed tasks release captured output references", async () => {
	const instance = manager({ maxOutputBytes: 128 });
	const ids: string[] = [];
	for (let i = 1; i <= 64; i++) {
		const started = await instance.start(
			nodeCommand(
				`process.stdout.write('stdout-${i}'); process.stderr.write('stderr-${i}')`,
			),
			process.cwd(),
		);
		const task = await waitForTask(instance, started.id, finished);
		expect(task.state).toBe("exited");
		expect(task.stdout).toBe(`stdout-${i}`);
		expect(task.stderr).toBe(`stderr-${i}`);
		ids.push(task.id);
	}

	expect(instance.list()).toHaveLength(ids.length);
	for (const id of ids) {
		instance.forget(id);
		expect(instance.inspect(id)).toBeUndefined();
	}
	expect(instance.list()).toEqual([]);

	const next = await instance.start(nodeCommand(""), process.cwd());
	expect(next.id).toBe("bg-65");
});

test("registers the slash command, plain input handler, and shutdown cleanup", async () => {
	const commands: Record<string, { handler: unknown }> = {};
	const hooks: Record<string, unknown> = {};
	backgroundTaskExtension({
		registerCommand(name: string, command: { handler: unknown }) {
			commands[name] = command;
		},
		on(name: string, handler: unknown) {
			hooks[name] = handler;
		},
	} as unknown as ExtensionAPI);

	expect(commands.background).toBeDefined();
	const notifications: string[] = [];
	const ctx = {
		cwd: process.cwd(),
		ui: { notify: (message: string) => notifications.push(message) },
	};
	const input = hooks.input as (
		event: { text: string },
		context: typeof ctx,
	) => Promise<{ action: string }>;
	const shutdown = hooks.session_shutdown as () => Promise<void>;
	expect(await input({ text: "hello" }, ctx)).toEqual({ action: "continue" });
	expect(await input({ text: "background list" }, ctx)).toEqual({
		action: "handled",
	});
	expect(notifications.at(-1)).toBe("No background tasks.");
	await shutdown();
});
