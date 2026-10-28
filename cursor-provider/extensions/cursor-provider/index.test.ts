import { describe, expect, test } from "bun:test";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { MODE_ENTRY_TYPE, PROVIDER_ID } from "./constants.ts";
import {
	createCursorExtension,
	formatRunCard,
	RUN_ENTRY_TYPE,
	type RunCard,
	restoredMode,
} from "./index.ts";
import type { CursorSdk } from "./sdk.ts";

interface FakeExtensionState {
	providers: Provider[];
	flags: Map<string, unknown>;
	commands: Map<string, unknown>;
	entryRenderers: Map<string, unknown>;
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
	entries: Array<{ customType: string; data: unknown }>;
}

function fakeExtensionApi(): { api: ExtensionAPI; state: FakeExtensionState } {
	const state: FakeExtensionState = {
		providers: [],
		flags: new Map(),
		commands: new Map(),
		entryRenderers: new Map(),
		handlers: new Map(),
		entries: [],
	};
	const api = {
		registerProvider: (provider: Provider) => state.providers.push(provider),
		registerFlag: (name: string, options: unknown) => state.flags.set(name, options),
		registerCommand: (name: string, options: unknown) => state.commands.set(name, options),
		registerEntryRenderer: (customType: string, renderer: unknown) =>
			state.entryRenderers.set(customType, renderer),
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			const handlers = state.handlers.get(event) ?? [];
			handlers.push(handler);
			state.handlers.set(event, handlers);
			return () => {};
		},
		getAllTools: () => [],
		getActiveTools: () => [],
		getFlag: () => undefined,
		appendEntry: (customType: string, data: unknown) => state.entries.push({ customType, data }),
	} as unknown as ExtensionAPI;
	return { api, state };
}

function runCard(): RunCard {
	return {
		responseId: "cursor-agent:agent-1:run-1",
		agentId: "agent-1",
		runId: "run-1",
		runtime: "local",
		mode: "fast",
		model: { id: "model-1", params: [{ id: "fast", value: "true" }] },
		status: "finished",
		continuity: "continued",
		tools: [{ callId: "call-1", name: "weather", detail: "Tokyo", status: "completed" }],
		durationMs: 1_250,
	};
}

describe("cursor extension entry points", () => {
	test("registers the native provider, runtime flags, command, and run-card renderer", () => {
		const { api, state } = fakeExtensionApi();
		const extension = createCursorExtension({
			loadSdk: async () => {
				throw new Error("The SDK should stay lazy during extension registration");
			},
			agentDir: "/tmp/cursor-provider-index-test",
		});
		extension(api);

		expect(state.providers.map((provider) => provider.id)).toEqual([PROVIDER_ID]);
		expect([...state.flags.keys()]).toEqual([
			"cursor-agent-runtime",
			"cursor-agent-mode",
			"cursor-agent-mcp-bridge",
		]);
		expect(state.commands.has("cursor-agent")).toBe(true);
		expect(state.entryRenderers.has(RUN_ENTRY_TYPE)).toBe(true);
	});

	test("starts a non-blocking, TTL-respecting model refresh on session start", async () => {
		const { api, state } = fakeExtensionApi();
		createCursorExtension({
			loadSdk: async () => ({}) as CursorSdk,
			agentDir: "/tmp/cursor-provider-index-session-test",
		})(api);
		const refreshCalls: unknown[] = [];
		const ctx = {
			cwd: "/tmp",
			model: undefined,
			ui: { notify: () => {}, setStatus: () => {} },
			sessionManager: { getBranch: () => [] },
			modelRegistry: {
				refresh: (options: unknown) => {
					refreshCalls.push(options);
					return new Promise(() => {});
				},
			},
		};
		const [handler] = state.handlers.get("session_start") ?? [];
		await handler?.({}, ctx);
		expect(refreshCalls).toEqual([{ providers: [PROVIDER_ID] }]);
	});

	test("registers a renderer that returns a Pi Text entry for valid run cards", () => {
		const { api, state } = fakeExtensionApi();
		createCursorExtension({
			loadSdk: async () => ({}) as CursorSdk,
			agentDir: "/tmp/cursor-provider-index-renderer-test",
		})(api);
		const renderer = state.entryRenderers.get(RUN_ENTRY_TYPE);
		expect(typeof renderer).toBe("function");
		if (typeof renderer !== "function") throw new Error("Run-card renderer was not registered");
		const rendered = renderer(
			{ type: "custom", customType: RUN_ENTRY_TYPE, data: runCard() },
			{ expanded: false },
			{ fg: (_color: string, text: string) => text },
		);
		expect(rendered).toBeInstanceOf(Text);
	});

	test("formats run cards deterministically from persisted fields", () => {
		const card = runCard();
		expect(formatRunCard(card, false)).toBe(formatRunCard(structuredClone(card), false));
		expect(formatRunCard(card, true)).toBe(formatRunCard(structuredClone(card), true));
		expect(formatRunCard(card, false)).toContain(
			"Cursor local · fast · model-1 fast=true · continued · finished",
		);
		expect(formatRunCard(card, true)).toContain("✓ weather Tokyo");
	});

	test("restores the latest valid mode entry and ignores unrelated or invalid entries", () => {
		expect(
			restoredMode([
				{ type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "fast" } },
				{ type: "custom", customType: "other-entry", data: { mode: "plan" } },
				{ type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "invalid" } },
				{ type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "plan" } },
			]),
		).toBe("plan");
		expect(
			restoredMode([{ type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "invalid" } }]),
		).toBeUndefined();
	});
});
