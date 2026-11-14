import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_POLISH_CONFIG } from "./config.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import registerExtension, {
	CLIPBOARD_TIMEOUT_MS,
	type ClipboardCommand,
	COPY_SHORTCUT,
	completionOverrides,
	copyPromptText,
	fallbackCopyToClipboard,
	HISTORY_SHORTCUT,
	MAX_OSC52_ENCODED_LENGTH,
	PREVIEW_SHORTCUT,
	PromptPreviewOverlay,
	polishPrompt,
	promptCopyControl,
	promptHistoryControl,
	promptPreviewControl,
	resolveConfiguredModel,
	restorePolishHistory,
	runClipboardCommand,
} from "./index.ts";

type Response = {
	stopReason: string;
	content: unknown;
	errorMessage?: string;
};
type RequestContext = {
	systemPrompt: string;
	messages: unknown[];
	tools: unknown[];
};
type CapturedCall = {
	model: unknown;
	context: RequestContext;
	options: unknown;
};
type Completion =
	| Response
	| Promise<Response>
	| ((calls: CapturedCall[]) => Response | Promise<Response>);

const model = { provider: "fake-provider", id: "fake-model" };
const text = (value: string) => ({ type: "text", text: value });
const toolCall = (argumentsValue: unknown) => ({
	type: "toolCall",
	id: "call-1",
	name: "secret-tool",
	arguments: argumentsValue,
});
const response = (
	stopReason: string,
	content: unknown,
	errorMessage?: string,
): Response => ({ stopReason, content, errorMessage });
const polishingModel = {
	provider: "openrouter",
	id: "anthropic/claude-opus-5.5",
};
const providers = ["cursor", "openrouter", "anthropic", "openai", "fake-provider"];
type AvailableModels = unknown[] | (() => unknown[]);

function outputBoundaries(systemPrompt: string) {
	const match =
		/Opening boundary: (<prompt-polish-output-[a-f0-9]+>)\n- Closing boundary: (<\/prompt-polish-output-[a-f0-9]+>)/.exec(
			systemPrompt,
		);
	if (!match?.[1] || !match[2]) throw new Error("missing output boundaries");
	return { open: match[1], close: match[2] };
}

function boundedText(value: string, systemPrompt: string): string {
	const { open, close } = outputBoundaries(systemPrompt);
	return `${open}${value}${close}`;
}

function boundedResponse(
	value: string,
	stopReason = "stop",
	otherContent: unknown[] = [],
): Completion {
	return (calls) =>
		response(stopReason, [
			text(boundedText(value, calls.at(-1)!.context.systemPrompt)),
			...otherContent,
		]);
}

function harness(
	responses: Completion[],
	signal?: AbortSignal,
	selectedModel = model,
	availableModels: AvailableModels = [],
) {
	const calls: CapturedCall[] = [];
	const runtime = {
		complete: (calledModel: unknown, context: unknown, options: unknown) => {
			calls.push({
				model: calledModel,
				context: context as RequestContext,
				options,
			});
			const next = responses.shift();
			if (next === undefined) throw new Error("missing fake response");
			return typeof next === "function" ? next(calls) : next;
		},
	};
	return {
		calls,
		ctx: {
			model: selectedModel,
			modelRegistry: {
				complete: runtime.complete,
				getAvailable: () =>
					typeof availableModels === "function"
						? availableModels()
						: availableModels,
			},
			signal,
		} as unknown as Pick<
			ExtensionContext,
			"model" | "modelRegistry" | "signal"
		>,
	};
}

function diagnostics() {
	const entries: unknown[] = [];
	return { entries, logger: (entry: unknown) => entries.push(entry) };
}

const previewTheme = { fg: (_color: string, text: string) => text };
function previewTui(requestRender = () => {}) {
	return {
		requestRender,
		terminal: { rows: 20, columns: 80 },
	} as unknown as TUI;
}

type PreviewComponent = {
	render: (width: number) => string[];
	handleMouse?: (event: TuiMouseEvent) => unknown;
};

function previewWidget(value: unknown): PreviewComponent {
	if (typeof value !== "function") throw new Error("missing preview widget");
	return value(previewTui(), previewTheme) as PreviewComponent;
}

function clickAt(y: number): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x: 1,
		y,
		width: 80,
		height: 20,
		screenX: 1,
		screenY: y,
		clickCount: 1,
	};
}

test("registers an accessible labeled preview shortcut and states", () => {
	const shortcuts = new Map<string, { description: string }>();
	registerExtension({
		registerShortcut: (key: string, value: { description: string }) =>
			shortcuts.set(key, value),
	} as never);

	expect(shortcuts.get(PREVIEW_SHORTCUT)?.description).toContain("preview");
	expect(shortcuts.get(COPY_SHORTCUT)?.description).toContain("Copy");
	expect(shortcuts.get(HISTORY_SHORTCUT)?.description).toContain("history");
	expect(promptCopyControl()).toContain("Copy polished prompt");
	expect(promptHistoryControl()).toContain("Polish history");
	expect(promptCopyControl()).toContain("Ctrl+Shift+Y");
	expect(promptCopyControl()).not.toContain("Ctrl+Shift+C");
	expect(promptPreviewControl(false)).toContain("Expand polished prompt");
	expect(promptPreviewControl(false)).toContain("collapsed");
	expect(promptPreviewControl(false)).toContain("Ctrl+Shift+E");
	expect(promptPreviewControl(false)).not.toContain("Ctrl+Shift+P");
	expect(promptPreviewControl(true)).toContain("Collapse polished prompt");
	expect(promptPreviewControl(true)).toContain("expanded");
});

test("registered preview shortcut expands and restores without mutating editor text", async () => {
	type Shortcut = {
		description: string;
		handler: (ctx: unknown) => Promise<void> | void;
	};
	const shortcuts = new Map<string, Shortcut>();
	const widgets = new Map<string, unknown>();
	const editorWrites: string[] = [];
	const copied: string[] = [];
	let editorReads = 0;
	let editorText = "original prompt";
	const generated = "polished first\n\n  polished second";
	let overlay: unknown;
	let resolveOverlay: (() => void) | undefined;

	const ui = {
		getEditorText: () => {
			editorReads++;
			return editorText;
		},
		setEditorText: (value: string) => {
			editorText = value;
			editorWrites.push(value);
		},
		setStatus: () => {},
		setWidget: (key: string, content: unknown) => widgets.set(key, content),
		theme: previewTheme,
		notify: () => {},
		custom: async (
			factory: (tui: TUI, theme: typeof previewTheme, kb: unknown, done: () => void) => unknown,
			options: unknown,
		) => {
			expect(options).toMatchObject({ overlay: true });
			return new Promise<void>((resolve) => {
				resolveOverlay = resolve;
				const done = () => resolve();
				void Promise.resolve(
					factory(previewTui(), previewTheme, { matches: () => false }, done),
			).then(
					(value) => {
						overlay = value;
					},
				);
			});
		},
	};
	const ctx = {
		mode: "tui",
		ui,
		model,
		modelRegistry: {
			getAvailable: () => [],
			complete: async (_model: unknown, context: RequestContext) =>
				response("stop", [text(boundedText(generated, context.systemPrompt))]),
		},
		signal: undefined,
	};
	registerExtension(
		{
			registerShortcut: (key: string, value: Shortcut) =>
				shortcuts.set(key, value),
		} as never,
		async (value: string) => {
			copied.push(value);
		},
	);

	await shortcuts.get("ctrl+shift+o")!.handler(ctx);
	expect(editorText).toBe(generated);
	expect(editorWrites).toEqual([generated]);
	expect(previewWidget(widgets.get("prompt-polish-preview")).render(80)[0]).toContain(
		"collapsed",
	);

	editorText = "edited after polishing";
	const readsBeforeCopy = editorReads;
	const compactControl = previewWidget(widgets.get("prompt-polish-preview"));
	expect(compactControl.handleMouse?.(clickAt(1))).toMatchObject({
		handled: true,
	});
	await Promise.resolve();
	expect(copied).toEqual([generated]);
	expect(editorReads).toBe(readsBeforeCopy);
	expect(editorText).toBe("edited after polishing");

	expect(compactControl.handleMouse?.(clickAt(0))).toMatchObject({
		handled: true,
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(overlay).toBeInstanceOf(PromptPreviewOverlay);
	expect(previewWidget(widgets.get("prompt-polish-preview")).render(80)[0]).toContain(
		"expanded",
	);
	expect((overlay as PromptPreviewOverlay).render(80).join("\n")).toContain(
		"polished first",
	);
	expect(editorText).toBe("edited after polishing");

	expect(
		(overlay as PromptPreviewOverlay).handleMouse(clickAt(1)),
	).toMatchObject({ handled: true });
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	expect(previewWidget(widgets.get("prompt-polish-preview")).render(80)[0]).toContain(
		"collapsed",
	);
	expect(editorText).toBe("edited after polishing");
	expect(editorWrites).toEqual([generated]);

	const expand = shortcuts.get(PREVIEW_SHORTCUT)!.handler(ctx);
	await Promise.resolve();
	await Promise.resolve();
	expect(overlay).toBeInstanceOf(PromptPreviewOverlay);
	expect(previewWidget(widgets.get("prompt-polish-preview")).render(80)[0]).toContain(
		"expanded",
	);
	expect(editorText).toBe("edited after polishing");

	expect(
		(overlay as PromptPreviewOverlay).handleMouse(clickAt(2)),
	).toMatchObject({ handled: true });
	await Promise.resolve();
	expect(copied).toEqual([generated, generated]);

	await shortcuts.get(COPY_SHORTCUT)!.handler(ctx);
	expect(copied).toEqual([generated, generated, generated]);
	expect(editorText).toBe("edited after polishing");

	await shortcuts.get(PREVIEW_SHORTCUT)!.handler(ctx);
	resolveOverlay?.();
	await expand;
	expect(previewWidget(widgets.get("prompt-polish-preview")).render(80)[0]).toContain(
		"collapsed",
	);
	expect(editorText).toBe("edited after polishing");
	expect(editorWrites).toEqual([generated]);
});

test("successful polish persists history even when the editor changed", async () => {
	type Shortcut = {
		description: string;
		handler: (ctx: unknown) => Promise<void> | void;
	};
	type EventHandler = (event: unknown, ctx: unknown) => unknown;
	const shortcuts = new Map<string, Shortcut>();
	const events = new Map<string, EventHandler>();
	const widgets = new Map<string, unknown>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const notices: string[] = [];
	let editorText = "original prompt";
	let completeStarted = false;
	let completionContext: RequestContext;
	let resolveCompletion: ((value: Response) => void) | undefined;
	const ui = {
		getEditorText: () => editorText,
		setEditorText: (value: string) => {
			editorText = value;
		},
		setStatus: () => {},
		setWidget: (key: string, content: unknown) => widgets.set(key, content),
		theme: previewTheme,
		notify: (message: string) => notices.push(message),
		custom: async () => null,
	};
	const ctx = {
		mode: "tui",
		ui,
		model,
		modelRegistry: {
			getAvailable: () => [],
			complete: (_model: unknown, context: RequestContext) => {
				completionContext = context;
				completeStarted = true;
				return new Promise<Response>((resolve) => {
					resolveCompletion = resolve;
				});
			},
		},
		signal: undefined,
	};
	registerExtension({
		registerShortcut: (key: string, value: Shortcut) =>
			shortcuts.set(key, value),
		on: (event: string, handler: EventHandler) => events.set(event, handler),
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	} as never);

	const improveShortcut = shortcuts.get("ctrl+shift+o");
	if (!improveShortcut) throw new Error("missing improve shortcut");
	const pending = improveShortcut.handler(ctx);
	while (!completeStarted)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	editorText = "user changed this while polishing";
	resolveCompletion?.(
		response("stop", [
			text(boundedText("improved prompt", completionContext!.systemPrompt)),
		]),
	);
	await pending;

	expect(editorText).toBe("user changed this while polishing");
	expect(appended).toHaveLength(1);
	expect(appended[0]).toMatchObject({
		type: "prompt-polish-history",
		data: { original: "original prompt", improved: "improved prompt" },
	});
	expect(notices).toContain(
		"Editor changed; improved prompt was saved to history but not applied",
	);

	const inputHandler = events.get("input");
	expect(inputHandler?.({}, ctx)).toEqual({ action: "continue" });
	expect(typeof widgets.get("prompt-polish-preview")).toBe("function");
	expect(
		previewWidget(widgets.get("prompt-polish-preview")).render(80)[0],
	).toContain("Polish history");
});

test("session transitions clear UI and discard stale completions", async () => {
	type Shortcut = {
		description: string;
		handler: (ctx: unknown) => Promise<void> | void;
	};
	type EventHandler = (event: unknown, ctx: unknown) => unknown;
	const shortcuts = new Map<string, Shortcut>();
	const events = new Map<string, EventHandler>();
	const widgets = new Map<string, unknown>();
	const appended: unknown[] = [];
	const notices: string[] = [];
	let editorText = "original prompt";
	let completeStarted = false;
	let resolveCompletion: ((value: Response) => void) | undefined;
	const ui = {
		getEditorText: () => editorText,
		setEditorText: (value: string) => {
			editorText = value;
		},
		setStatus: () => {},
		setWidget: (key: string, content: unknown) => widgets.set(key, content),
		theme: previewTheme,
		notify: (message: string) => notices.push(message),
		custom: async () => null,
	};
	const sessionManager = {
		getSessionId: () => "session-one",
		getBranch: () => [],
	};
	const ctx = {
		mode: "tui",
		ui,
		model,
		modelRegistry: {
			getAvailable: () => [],
			complete: () => {
				completeStarted = true;
				return new Promise<Response>((resolve) => {
					resolveCompletion = resolve;
				});
			},
		},
		sessionManager,
		signal: undefined,
	};
	registerExtension({
		registerShortcut: (key: string, value: Shortcut) =>
			shortcuts.set(key, value),
		on: (event: string, handler: EventHandler) => events.set(event, handler),
		appendEntry: (_type: string, data: unknown) => appended.push(data),
	} as never);
	events.get("session_start")?.({}, ctx);

	const improveShortcut = shortcuts.get("ctrl+shift+o");
	if (!improveShortcut) throw new Error("missing improve shortcut");
	const pending = improveShortcut.handler(ctx);
	while (!completeStarted)
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	events.get("session_shutdown")?.({}, ctx);
	resolveCompletion?.(response("stop", [text("stale polished prompt")]));
	await pending;

	expect(appended).toEqual([]);
	expect(editorText).toBe("original prompt");
	expect(widgets.get("prompt-polish-preview")).toBeUndefined();
	expect(notices).toEqual([]);
});

test("expanded preview preserves exact multiline text and collapses on Escape", () => {
	const original = "first line\n\n  second line\nthird line";
	let closed = 0;
	const overlay = new PromptPreviewOverlay(
		previewTui(),
		previewTheme,
		original,
		() => {
			closed++;
		},
	);
	const rendered = overlay.render(80).join("\n");

	expect(rendered).toContain("Preview: expanded");
	expect(rendered).toContain("first line");
	expect(rendered).toContain("  second line");
	expect(rendered).toContain("third line");
	overlay.handleInput("\x1b");
	expect(closed).toBe(1);
});

test("preview keeps one continuous themed border at every width", () => {
	const overlay = new PromptPreviewOverlay(
		previewTui(),
		previewTheme,
		"first line\nsecond line",
		() => {},
	);
	for (const width of [1, 2, 3, 20]) {
		const lines = overlay.render(width);
		expect(lines.length).toBeGreaterThan(0);
		if (width >= 3) {
			expect(lines[0]?.startsWith("╭")).toBe(true);
			expect(lines.at(-1)?.startsWith("╰")).toBe(true);
			expect(lines.slice(1, -1).every((line) => line.startsWith("│"))).toBe(
				true,
			);
		}
	}
});

test("rehydrates branch history and deduplicates exact completed text", () => {
	const history = restorePolishHistory([
		{
			type: "custom",
			customType: "prompt-polish-history",
			data: { original: "first", improved: "polished", timestamp: 1 },
		},
		{
			type: "custom",
			customType: "prompt-polish-history",
			data: { original: "second", improved: "new polished", timestamp: 2 },
		},
		{
			type: "custom",
			customType: "prompt-polish-history",
			data: { original: "third", improved: "polished", timestamp: 3 },
		},
	]);
	expect(history.map((item) => item.improved)).toEqual([
		"polished",
		"new polished",
	]);
	expect(history[0]?.original).toBe("third");
});

test("copy preserves exact whitespace and reports clipboard outcomes", async () => {
	const exact = "  first line\n\n  second line  ";
	const copied: string[] = [];
	const notices: Array<{ message: string; type?: string }> = [];
	const notify = (message: string, type?: string) => notices.push({ message, type });

	expect(
		await copyPromptText(exact, notify, async (value) => {
			copied.push(value);
		}),
	).toBe(true);
	expect(copied).toEqual([exact]);
	expect(notices).toEqual([
		{ message: "Prompt copied to clipboard", type: "info" },
	]);

	notices.length = 0;
	expect(
		await copyPromptText(exact, notify, async () => {
			throw new Error("clipboard unavailable");
		}),
	).toBe(false);
	expect(notices).toEqual([
		{ message: "Prompt copy failed: clipboard unavailable", type: "error" },
	]);
});

test("clipboard fallback preserves command order and exact text", async () => {
	const exact = "first\n\n  second";
	const calls: Array<{ command: string; args: string[]; text: string }> = [];
	await fallbackCopyToClipboard(exact, {
		platform: "linux",
		env: {
			TERMUX_VERSION: "1",
			WAYLAND_DISPLAY: "wayland-1",
			DISPLAY: ":0",
		},
		navigator: {},
		runCommand: async (command, text) => {
			calls.push({ ...command, text });
			if (command.command === "termux-clipboard-set")
				throw new Error("termux unavailable");
		},
	});
	expect(calls).toEqual([
		{ command: "termux-clipboard-set", args: [], text: exact },
		{ command: "wl-copy", args: [], text: exact },
	]);
});

test("failed local clipboard paths use bounded OSC52", async () => {
	const exact = "exact clipboard text";
	const calls: ClipboardCommand[] = [];
	let osc52Text: string | undefined;
	await fallbackCopyToClipboard(exact, {
		platform: "linux",
		env: { DISPLAY: ":0" },
		navigator: {},
		runCommand: async (command) => {
			calls.push(command);
			throw new Error(`${command.command} unavailable`);
		},
		emitOsc52: (text) => {
			osc52Text = text;
			return true;
		},
	});
	expect(calls).toEqual([
		{ command: "xclip", args: ["-selection", "clipboard"] },
		{ command: "xsel", args: ["--clipboard", "--input"] },
	]);
	expect(osc52Text).toBe(exact);
});

test("remote clipboard attempts OSC52 after local success", async () => {
	const events: string[] = [];
	const exact = "remote exact text";
	await fallbackCopyToClipboard(exact, {
		platform: "darwin",
		env: { SSH_CONNECTION: "remote" },
		navigator: {},
		runCommand: async (command, text) => {
			events.push(`${command.command}:${text}`);
	},
		emitOsc52: (text) => {
			events.push(`osc52:${text}`);
			return true;
		},
	});
	expect(events).toEqual(["pbcopy:remote exact text", "osc52:remote exact text"]);
});

test("browser clipboard rejection and timeout remain bounded", async () => {
	expect(CLIPBOARD_TIMEOUT_MS).toBe(5_000);
	const rejection = {
		clipboard: {
			writeText: async () => {
				throw new Error("browser rejected");
			},
		},
	};
	let failure: unknown;
	try {
		await fallbackCopyToClipboard("exact", {
			platform: "other",
			navigator: rejection,
			emitOsc52: () => false,
		});
	} catch (error) {
		failure = error;
	}
	expect(String(failure)).toContain("browser rejected");

	const started = Date.now();
	failure = undefined;
	try {
		await fallbackCopyToClipboard("exact", {
			platform: "other",
			timeoutMs: 5,
			navigator: {
				clipboard: { writeText: () => new Promise(() => {}) },
			},
			emitOsc52: () => false,
		});
	} catch (error) {
		failure = error;
	}
	expect(Date.now() - started).toBeLessThan(500);
	expect(String(failure)).toContain(
		"navigator.clipboard.writeText timed out after 5ms",
	);
});

test("clipboard command timeout kills the child without a shell", async () => {
	let killCount = 0;
	let receivedArgs: string[] = [];
	let receivedOptions: unknown;
	const child = {
		stdin: {
			once: () => child.stdin,
			end: () => {},
		},
		once: () => child,
		kill: () => {
			killCount++;
			return true;
		},
	};
	const spawnProcess = ((
		_command: string,
		args: string[],
		options: unknown,
	) => {
		receivedArgs = args;
		receivedOptions = options;
		return child;
	}) as never;
	let failure: unknown;
	try {
		await runClipboardCommand(
			{ command: "slow-copy", args: ["--clipboard"] },
			"exact text",
			spawnProcess,
			5,
		);
	} catch (error) {
		failure = error;
	}
	expect(killCount).toBe(1);
	expect(receivedArgs).toEqual(["--clipboard"]);
	expect(receivedOptions).toMatchObject({
		stdio: ["pipe", "ignore", "ignore"],
	});
	expect(receivedOptions).not.toHaveProperty("shell");
	expect(String(failure)).toContain("slow-copy timed out after 5ms");
});

test("failed expanded copy leaves the overlay open", async () => {
	const notices: Array<{ message: string; type?: string }> = [];
	let closed = 0;
	const overlay = new PromptPreviewOverlay(
		previewTui(),
		previewTheme,
		"exact\n\n  text",
		() => {
			closed++;
		},
		() => {
			void copyPromptText(
				"exact\n\n  text",
				(message, type) => notices.push({ message, type }),
				async () => {
					throw new Error("clipboard unavailable");
				},
			);
		},
	);
	overlay.render(80);
	const scrollTop = overlay.scrollView.scrollTop;
	expect(overlay.handleMouse(clickAt(2))).toMatchObject({ handled: true });
	await Promise.resolve();
	await Promise.resolve();
	expect(closed).toBe(0);
	expect(overlay.scrollView.scrollTop).toBe(scrollTop);
	expect(notices).toEqual([
		{ message: "Prompt copy failed: clipboard unavailable", type: "error" },
	]);
});

test("expanded copy uses the mouse control and configured copy key", () => {
	const exact = "first line\n\n  second line";
	const copied: string[] = [];
	const matched: Array<{ data: string; key: string }> = [];
	let closed = 0;
	const overlay = new PromptPreviewOverlay(
		previewTui(),
		previewTheme,
		exact,
		() => {
			closed++;
		},
		() => copied.push(exact),
		{
			matches: (data: string, key: string) => {
				matched.push({ data, key });
				return data === "configured-copy" && key === "app.message.copy";
			},
		},
	);
	overlay.render(80);
	const scrollTop = overlay.scrollView.scrollTop;

	expect(overlay.handleMouse(clickAt(2))).toMatchObject({ handled: true });
	overlay.handleInput("configured-copy");
	overlay.handleInput(`${String.fromCharCode(27)}[121;6u`);
	expect(copied).toEqual([exact, exact, exact]);
	expect(matched).toEqual([
		{ data: "configured-copy", key: "app.message.copy" },
	]);
	expect(overlay.scrollView.scrollTop).toBe(scrollTop);
	expect(closed).toBe(0);
});

test("preview mouse handling is limited to the collapse control row", () => {
	let closed = 0;
	const overlay = new PromptPreviewOverlay(
		previewTui(),
		previewTheme,
		"first line\nsecond line",
		() => {
			closed++;
		},
	);
	overlay.render(80);

	expect(overlay.handleMouse(clickAt(3))).toBeUndefined();
	expect(closed).toBe(0);
	expect(overlay.handleMouse(clickAt(1))).toMatchObject({ handled: true });
	expect(closed).toBe(1);
});

test("expanded preview scrolls only after content exceeds its viewport", () => {
	const short = new PromptPreviewOverlay(
		previewTui(),
		previewTheme,
		"one\ntwo",
		() => {},
	);
	short.scrollView.updateLayout(2, 8, () => {});
	short.handleInput("\x1b[B");
	expect(short.scrollView.scrollTop).toBe(0);

	const long = new PromptPreviewOverlay(
		previewTui(),
		previewTheme,
		Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
		() => {},
	);
	long.scrollView.updateLayout(20, 5, () => {});
	long.handleInput("\x1b[B");
	expect(long.scrollView.scrollTop).toBe(1);
});

test("default config resolves OpenRouter's nested Opus id and targets the session model", async () => {
	const h = harness([boundedResponse("improved prompt")], undefined, model, [
		{ provider: "openrouter", id: "wrong-model" },
		{ provider: "anthropic", id: "claude-opus-5.5" },
		polishingModel,
	]);
	expect(
		resolveConfiguredModel(
			DEFAULT_POLISH_CONFIG.model,
			model as never,
			h.ctx.modelRegistry,
		),
	).toBe(polishingModel);
	expect(await polishPrompt("original", h.ctx)).toBe("improved prompt");
	expect(h.calls[0].model).toBe(polishingModel);
	expect(h.calls[0].options).toMatchObject({ reasoningEffort: "high" });
	expect(h.calls[0].options).not.toHaveProperty("serviceTier");
	expect(h.calls[0].context.tools).toEqual([]);
	const message = h.calls[0].context.messages[0] as {
		content: { text: string }[];
	};
	expect(message.content[0].text).toContain(
		`TARGET_MODEL: ${model.provider}/${model.id}`,
	);
	expect(message.content[0].text).not.toContain(
		`TARGET_MODEL: ${polishingModel.provider}/${polishingModel.id}`,
	);
	expect(message.content[0].text).toContain(
		"CONTEXT:\n<context>\n\n</context>",
	);
});

test("falls back to the session model when the default is unavailable or lookup throws", async () => {
	for (const available of [
		[],
		() => {
			throw new Error("lookup failed");
		},
	]) {
		const h = harness(
			[boundedResponse("improved")],
			undefined,
			model,
			available,
		);
		expect(await polishPrompt("original", h.ctx)).toBe("improved");
		expect(h.calls[0].model).toBe(model);
	}
});

test("bare model ids prefer the session provider then sort deterministically", () => {
	const later = { provider: "z-provider", id: "custom-model" };
	const earlier = { provider: "a-provider", id: "custom-model" };
	const h = harness([], undefined, model, [later, earlier]);
	expect(
		resolveConfiguredModel("custom-model", model as never, h.ctx.modelRegistry),
	).toBe(earlier);
	expect(
		resolveConfiguredModel("custom-model", later as never, h.ctx.modelRegistry),
	).toBe(later);
});

test("fastMode only opts into priority when explicitly enabled", () => {
	expect(completionOverrides(DEFAULT_POLISH_CONFIG)).not.toHaveProperty(
		"serviceTier",
	);
	expect(
		completionOverrides({ ...DEFAULT_POLISH_CONFIG, fastMode: true }),
	).toMatchObject({ serviceTier: "priority" });
});

test("initial and retry system prompts start with the exact module-relative contract", async () => {
	const contract = readFileSync(
		new URL(
			"../../skills/prompt-polish/references/polishing.md",
			import.meta.url,
		),
		"utf8",
	);
	const h = harness(
		[
			response("toolUse", [toolCall({ query: "secret" })]),
			boundedResponse("fallback prompt"),
		],
		undefined,
		model,
		[polishingModel],
	);
	expect(await polishPrompt("original", h.ctx, { logger: () => {} })).toBe(
		"fallback prompt",
	);
	expect(h.calls).toHaveLength(2);
	for (const call of h.calls) {
		expect(call.context.systemPrompt.startsWith(contract)).toBe(true);
		outputBoundaries(call.context.systemPrompt);
		expect(call.model).toBe(polishingModel);
		expect(call.options).toMatchObject({ reasoningEffort: "high" });
		expect(call.options).not.toHaveProperty("serviceTier");
		expect(call.context.tools).toEqual([]);
	}
	expect(h.calls[1].context.systemPrompt).toContain("no tools available");
});

test.each(providers)(
	"%s strips outside text and structured thinking using its own boundary",
	async (provider) => {
		const h = harness(
			[
				(calls) =>
					response("stop", [
						{ type: "thinking", thinking: "secret trace" },
						text(
							`outside reasoning${boundedText("final prompt", calls.at(-1)!.context.systemPrompt)}trailing reasoning`,
						),
					]),
			],
			undefined,
			{ provider, id: "test-model" },
		);
		expect(await polishPrompt("original", h.ctx)).toBe("final prompt");
		expect(h.calls).toHaveLength(1);
	},
);

test("retry and independent requests get fresh nonces and keep tools disabled", async () => {
	const h = harness([
		response("stop", [text("unbounded first response")]),
		boundedResponse("bounded retry"),
		boundedResponse("another request"),
	]);
	expect(await polishPrompt("original", h.ctx, { logger: () => {} })).toBe(
		"bounded retry",
	);
	expect(await polishPrompt("original", h.ctx)).toBe("another request");
	expect(
		new Set(
			h.calls.map((call) => outputBoundaries(call.context.systemPrompt).open),
		).size,
	).toBe(3);
	expect(h.calls.map((call) => call.context.tools)).toEqual([[], [], []]);
});

test.each(providers)(
	"%s retries unbounded output once and preserves editor and history",
	async (provider) => {
		await checkUnchangedEditor(
			[
				response("stop", [text("secret first trace")]),
				response("stop", [text("secret retry trace")]),
			],
			{ provider, id: "test-model" },
			2,
			"malformed content",
		);
	},
);

test.each(["stop", "toolUse"])(
	"empty bounded %s leaves editor and history unchanged without retrying",
	async (reason) => {
		await checkUnchangedEditor(
			[boundedResponse("", reason)],
			model,
			1,
			"found no prompt to rewrite; the original prompt was not changed.",
		);
	},
);

test("empty bounded retry stops without adding history", async () => {
	await checkUnchangedEditor(
		[response("toolUse", [toolCall({})]), boundedResponse("")],
		model,
		2,
		"found no prompt to rewrite",
	);
});

async function checkUnchangedEditor(
	responses: Completion[],
	selectedModel: typeof model,
	count: number,
	message: string,
) {
	const shortcuts = new Map<string, { handler: (ctx: unknown) => unknown }>();
	const appended: unknown[] = [];
	const notices: string[] = [];
	const writes: string[] = [];
	const h = harness(responses, undefined, selectedModel);
	const ctx = {
		...h.ctx,
		mode: "tui",
		ui: {
			getEditorText: () => "original prompt",
			setEditorText: (value: string) => writes.push(value),
			setStatus: () => {},
			setWidget: () => {},
			theme: previewTheme,
			notify: (value: string) => notices.push(value),
			custom: async (
				factory: (
					tui: TUI,
					theme: typeof previewTheme,
					kb: unknown,
					done: () => void,
				) => PreviewComponent,
			) => {
				const layout = factory(previewTui(), previewTheme, {}, () => {});
				expect(layout.render(80).join("\n")).toContain(
					"No polished prompts saved",
				);
				return null;
			},
		},
	};
	registerExtension({
		registerShortcut: (
			key: string,
			shortcut: { handler: (ctx: unknown) => unknown },
		) => shortcuts.set(key, shortcut),
		appendEntry: (_type: string, data: unknown) => appended.push(data),
	} as never);
	await shortcuts.get("ctrl+shift+o")!.handler(ctx);
	expect(h.calls).toHaveLength(count);
	expect(writes).toEqual([]);
	expect(appended).toEqual([]);
	expect(notices).toHaveLength(1);
	expect(notices[0]).toContain(message);
	expect(notices[0]).not.toContain("secret");
	await shortcuts.get(HISTORY_SHORTCUT)!.handler(ctx);
}

test.each([
	"duplicate-open",
	"duplicate-close",
	"reversed",
	"missing-close",
	"stale-nonce",
])("rejects %s boundaries after one retry", async (kind) => {
	const invalid = (calls: CapturedCall[]) => {
		const { open, close } = outputBoundaries(
			calls.at(-1)!.context.systemPrompt,
		);
		const values = {
			"duplicate-open": `${open}first${open}nested${close}`,
			"duplicate-close": `${open}first${close}${close}`,
			reversed: `${close}prompt${open}`,
			"missing-close": `${open}prompt`,
			"stale-nonce":
				"<prompt-polish-output-deadbeef>prompt</prompt-polish-output-deadbeef>",
		};
		return response("stop", [text(values[kind as keyof typeof values])]);
	};
	const h = harness([invalid, invalid]);
	await expect(
		polishPrompt("original", h.ctx, { logger: () => {} }),
	).rejects.toThrow("malformed content");
	expect(h.calls).toHaveLength(2);
});

test("joins boundary fragments across text blocks without leaking thinking", async () => {
	const h = harness([
		(calls) => {
			const value = boundedText(
				"final\n\n  prompt",
				calls[0].context.systemPrompt,
			);
			return response("stop", [
				text(value.slice(0, 10)),
				{ type: "thinking", thinking: "secret" },
				text(value.slice(10)),
			]);
		},
	]);
	expect(await polishPrompt("original", h.ctx)).toBe("final\n\n  prompt");
});

test("bounded toolUse text succeeds without retry but malformed tools are rejected", async () => {
	const h = harness([
		boundedResponse("useful prompt", "toolUse", [toolCall({})]),
	]);
	expect(await polishPrompt("original", h.ctx, { logger: () => {} })).toBe(
		"useful prompt",
	);
	expect(h.calls).toHaveLength(1);
	const malformed = harness([
		boundedResponse("prompt", "toolUse", [toolCall("malformed")]),
	]);
	await expect(
		polishPrompt("original", malformed.ctx, { logger: () => {} }),
	).rejects.toThrow("malformed or incomplete tool response");
});

test("tool-only retries distinguish malformed and unavailable tools without leaking arguments", async () => {
	for (const [argumentsValue, expected] of [
		["secret-arguments", "malformed or incomplete tool response"],
		[{ secret: "secret-arguments" }, "requested unavailable tools"],
	] as const) {
		const d = diagnostics();
		const completion = response("toolUse", [toolCall(argumentsValue)]);
		const h = harness([completion, completion]);
		await expect(
			polishPrompt("secret-original", h.ctx, { logger: d.logger }),
		).rejects.toThrow(expected);
		expect(h.calls).toHaveLength(2);
		expect(d.entries).toHaveLength(2);
		expect(JSON.stringify(d.entries)).not.toContain("secret-");
	}
});

test("retry timeout and parent cancellation reject even when the provider ignores abort", async () => {
	const never = new Promise<Response>(() => {});
	const h = harness([response("toolUse", []), never]);
	await expect(
		polishPrompt("original", h.ctx, { timeoutMs: 5, logger: () => {} }),
	).rejects.toThrow("timed out");
	expect(h.calls).toHaveLength(2);
	const controller = new AbortController();
	const cancelled = harness([never], controller.signal);
	const pending = polishPrompt("original", cancelled.ctx, {
		timeoutMs: 500,
		logger: () => {},
	});
	controller.abort();
	await expect(pending).rejects.toThrow("cancelled");
});

test("incomplete, malformed, rejected and cancelled responses remain controlled", async () => {
	const cases: Array<[Completion, string]> = [
		[response("stop", []), "no usable text"],
		[response("stop", undefined), "malformed content"],
		[response("length", []), "truncated"],
		[response("pending", []), "did not complete"],
		[response("deferred", []), "did not complete"],
		[response("mystery", []), "request failed"],
		[response("error", [], "secret-error"), "request failed"],
		[response("aborted", []), "cancelled"],
		[() => Promise.reject(new Error("secret-error")), "request failed"],
		[
			boundedResponse("prompt", "stop", [
				{ type: "thinking", thinking: "secret", thinkingSignature: 42 },
			]),
			"malformed content",
		],
	];
	for (const [completion, expected] of cases) {
		const h = harness([completion]);
		const d = diagnostics();
		await expect(
			polishPrompt("secret-original", h.ctx, { logger: d.logger }),
		).rejects.toThrow(expected);
		expect(JSON.stringify(d.entries)).not.toContain("secret-");
	}
});

test("diagnostics contain only safe metadata", async () => {
	const d = diagnostics();
	const h = harness([
		boundedResponse("safe", "toolUse", [
			toolCall({ secret: "secret-tool-args" }),
		]),
	]);
	await polishPrompt("secret-original-prompt", h.ctx, { logger: d.logger });
	expect(Object.keys(d.entries[0] as Record<string, unknown>).sort()).toEqual([
		"attempt",
		"contentCount",
		"event",
		"model",
		"provider",
		"stopReason",
		"textCount",
		"toolCallCount",
	]);
	expect(JSON.stringify(d.entries)).not.toContain("secret-");
});
