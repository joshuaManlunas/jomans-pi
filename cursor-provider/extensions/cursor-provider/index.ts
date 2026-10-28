import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createCursorAuth } from "./auth.ts";
import {
	applyFlags,
	CURSOR_MODES,
	type CursorMode,
	type CursorProviderSettings,
	loadSettings,
	settingsPath,
} from "./config.ts";
import { API_KEY_ENV, BASE_URL, MODE_ENTRY_TYPE, PROVIDER_ID, PROVIDER_NAME } from "./constants.ts";
import { createModelCatalog } from "./models.ts";
import { type CursorRuntimeHandle, createCursorRuntime, type RunRecord } from "./runtime.ts";
import { type CursorSdk, loadCursorSdk } from "./sdk.ts";
import { isRecord } from "./util.ts";

export const RUN_ENTRY_TYPE = "cursor-agent-run";
const STATUS_KEY = "cursor-agent";

export type RunCard = Omit<RunRecord, "sessionKey">;

function isCursorMode(value: unknown): value is CursorMode {
	return typeof value === "string" && (CURSOR_MODES as readonly string[]).includes(value);
}

function isRunCard(value: unknown): value is RunCard {
	return (
		isRecord(value) &&
		typeof value.agentId === "string" &&
		typeof value.runId === "string" &&
		typeof value.status === "string" &&
		Array.isArray(value.tools)
	);
}

/** Deterministic text for a stored run card; depends only on the persisted data. */
export function formatRunCard(card: RunCard, expanded: boolean): string {
	const model = [card.model.id, ...(card.model.params ?? []).map((p) => `${p.id}=${p.value}`)].join(
		" ",
	);
	const head =
		`Cursor ${card.runtime} · ${card.mode} · ${model} · ${card.continuity} · ${card.status}` +
		(card.durationMs === undefined ? "" : ` · ${(card.durationMs / 1000).toFixed(1)}s`) +
		(card.tools.length === 0 ? "" : ` · ${card.tools.length} Cursor tool call(s)`);
	if (!expanded) return head;
	const lines = card.tools.map(
		(tool) =>
			`  ${tool.status === "completed" ? "✓" : "…"} ${tool.name}${tool.detail ? ` ${tool.detail}` : ""}`,
	);
	return [head, `  agent ${card.agentId} · run ${card.runId}`, ...lines].join("\n");
}

/** Latest `/cursor-agent mode` choice recorded on the current branch. */
export function restoredMode(entries: readonly unknown[]): CursorMode | undefined {
	let mode: CursorMode | undefined;
	for (const entry of entries) {
		if (
			isRecord(entry) &&
			entry.type === "custom" &&
			entry.customType === MODE_ENTRY_TYPE &&
			isRecord(entry.data) &&
			isCursorMode(entry.data.mode)
		) {
			mode = entry.data.mode;
		}
	}
	return mode;
}

export interface ExtensionOverrides {
	loadSdk?: () => Promise<CursorSdk>;
	agentDir?: string;
}

export function createCursorExtension(overrides: ExtensionOverrides = {}) {
	return function cursorProvider(pi: ExtensionAPI): void {
		const loadSdk = overrides.loadSdk ?? loadCursorSdk;
		const agentDir = overrides.agentDir ?? getAgentDir();
		let loaded = loadSettings(agentDir);
		let settings: CursorProviderSettings = loaded.settings;
		let mode: CursorMode = settings.mode;
		let cwd = process.cwd();
		const pendingCards = new Map<string, RunCard[]>();

		const catalog = createModelCatalog({
			loadSdk,
			ttlMs: () => settings.modelCacheTtlMs,
			textOnlyModels: () => settings.textOnlyModels,
		});

		const runtime: CursorRuntimeHandle = createCursorRuntime({
			loadSdk,
			settings: () => settings,
			mode: () => mode,
			cwd: () => cwd,
			piTools: () => ({
				all: pi.getAllTools().map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				})),
				active: pi.getActiveTools(),
			}),
			onRunRecord: ({ sessionKey: _sessionKey, ...card }) => {
				const queue = pendingCards.get(card.responseId) ?? [];
				queue.push(card);
				pendingCards.set(card.responseId, queue);
			},
		});

		const provider: Provider = {
			id: PROVIDER_ID,
			name: PROVIDER_NAME,
			baseUrl: BASE_URL,
			auth: createCursorAuth({ loadSdk, catalog }),
			getModels: () => catalog.getModels(),
			refreshModels: (context) => catalog.refresh(context),
			stream: (model, context, options) =>
				runtime.streamSimple(
					model as Model<Api>,
					context,
					options as Parameters<typeof runtime.streamSimple>[2],
				),
			streamSimple: (model, context, options) => runtime.streamSimple(model, context, options),
		};
		pi.registerProvider(provider);

		pi.registerFlag("cursor-agent-runtime", {
			type: "string",
			description: 'Cursor runtime for this run: "local" (default) or "cloud" (explicit opt-in)',
		});
		pi.registerFlag("cursor-agent-mode", {
			type: "string",
			description: 'Cursor mode: "agent", "fast", or "plan"',
		});
		pi.registerFlag("cursor-agent-mcp-bridge", {
			type: "boolean",
			description: "Let Cursor call active non-builtin Pi tools through in-process custom tools",
		});

		const describeState = () =>
			`Cursor ${settings.runtime}${settings.runtime === "cloud" ? " (cloud opt-in)" : ""} · ${mode}` +
			(settings.mcpBridge.enabled ? " · Pi tools bridged" : "");

		const updateStatus = (ctx: ExtensionContext, model: Model<Api> | undefined) => {
			ctx.ui.setStatus(STATUS_KEY, model?.provider === PROVIDER_ID ? describeState() : undefined);
		};

		pi.on("session_start", (_event, ctx) => {
			loaded = loadSettings(agentDir);
			settings = loaded.settings;
			const warnings = [
				...loaded.warnings,
				...applyFlags(settings, {
					runtime: pi.getFlag("cursor-agent-runtime"),
					mode: pi.getFlag("cursor-agent-mode"),
					mcpBridge: pi.getFlag("cursor-agent-mcp-bridge"),
				}),
			];
			mode = restoredMode(ctx.sessionManager.getBranch()) ?? settings.mode;
			cwd = ctx.cwd;
			for (const warning of warnings) ctx.ui.notify(`cursor-provider: ${warning}`, "warning");
			if (settings.runtime === "cloud") {
				ctx.ui.notify(
					"cursor-provider: Cursor Cloud runtime is enabled. Runs execute in a Cursor cloud VM, not on this machine.",
					"warning",
				);
			}
			updateStatus(ctx, ctx.model);
			// Pi's startup refresh never allows network for extension providers. Omitting
			// `allowNetwork` defers to Pi's offline setting; omitting `force` keeps the TTL.
			void ctx.modelRegistry.refresh({ providers: [PROVIDER_ID] }).catch(() => {});
		});

		pi.on("model_select", (event, ctx) => updateStatus(ctx, event.model));

		pi.on("message_end", (event) => {
			const message = event.message;
			if (message.role !== "assistant" || message.provider !== PROVIDER_ID || !message.responseId)
				return;
			const queue = pendingCards.get(message.responseId);
			const card = queue?.shift();
			if (queue?.length === 0) pendingCards.delete(message.responseId);
			if (card) pi.appendEntry(RUN_ENTRY_TYPE, card);
		});

		pi.on("session_shutdown", async () => {
			pendingCards.clear();
			await runtime.disposeAll();
		});

		pi.registerEntryRenderer<RunCard>(RUN_ENTRY_TYPE, (entry, options, theme) => {
			if (!isRunCard(entry.data)) return undefined;
			return new Text(theme.fg("muted", formatRunCard(entry.data, options.expanded)), 0, 0);
		});

		const subcommands = [
			"status",
			"models",
			"models refresh",
			"mode agent",
			"mode fast",
			"mode plan",
			"logout",
		];

		pi.registerCommand("cursor-agent", {
			description: "Cursor provider: status, models [refresh], mode <agent|fast|plan>, logout",
			getArgumentCompletions: (prefix) =>
				subcommands
					.filter((value) => value.startsWith(prefix.trim()))
					.map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				const [command = "status", sub] = args.trim().split(/\s+/).filter(Boolean);
				if (command === "status") {
					const status = catalog.status();
					const hasStoredKey = ctx.modelRegistry
						.getAll()
						.some((m) => m.provider === PROVIDER_ID && ctx.modelRegistry.hasConfiguredAuth(m));
					const auth = hasStoredKey
						? "configured"
						: process.env[API_KEY_ENV]
							? `${API_KEY_ENV} set`
							: `missing (run /login ${PROVIDER_ID})`;
					ctx.ui.notify(
						[
							describeState(),
							`Auth: ${auth}`,
							`Models: ${status.count} (${status.source}${status.stale ? ", stale" : ""})`,
							...(status.lastError ? [`Last refresh error: ${status.lastError}`] : []),
							`Settings: ${settingsPath(agentDir)}`,
						].join("\n"),
						"info",
					);
					return;
				}
				if (command === "models") {
					if (sub === "refresh") {
						ctx.ui.notify("Refreshing Cursor models…", "info");
						const result = await ctx.modelRegistry.refresh({
							providers: [PROVIDER_ID],
							allowNetwork: true,
							force: true,
						});
						const error = result.errors.get(PROVIDER_ID);
						if (error) ctx.ui.notify(`Cursor model refresh failed: ${error.message}`, "error");
						else ctx.ui.notify(`Cursor models: ${catalog.status().count} available.`, "info");
						return;
					}
					const status = catalog.status();
					const checked = status.checkedAt ? new Date(status.checkedAt).toISOString() : "never";
					ctx.ui.notify(
						`Cursor models: ${status.count} from ${status.source}, checked ${checked}${status.stale ? " (stale)" : ""}.` +
							(status.lastError ? `\nLast error: ${status.lastError}` : ""),
						"info",
					);
					return;
				}
				if (command === "mode") {
					if (!isCursorMode(sub)) {
						ctx.ui.notify(
							`Current mode: ${mode}. Use /cursor-agent mode <agent|fast|plan>.`,
							"info",
						);
						return;
					}
					mode = sub;
					pi.appendEntry(MODE_ENTRY_TYPE, { mode });
					updateStatus(ctx, ctx.model);
					ctx.ui.notify(`Cursor mode: ${mode}. Applies from the next message.`, "info");
					return;
				}
				if (command === "logout") {
					ctx.ui.notify(
						`Run /logout and choose ${PROVIDER_ID} to delete the stored key from Pi's credential store.` +
							(process.env[API_KEY_ENV]
								? ` ${API_KEY_ENV} is also set in this environment; unset it too.`
								: ""),
						"info",
					);
					return;
				}
				ctx.ui.notify(
					`Unknown subcommand "${command}". Try: ${subcommands.join(", ")}.`,
					"warning",
				);
			},
		});
	};
}

export default createCursorExtension();
