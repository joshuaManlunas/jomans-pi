import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MODEL_CACHE_TTL_MS } from "./constants.ts";

export type CursorRuntime = "local" | "cloud";
export type CursorMode = "agent" | "fast" | "plan";
export type SettingSourceName = "project" | "user" | "team" | "mdm" | "plugins" | "all";

export const CURSOR_MODES: readonly CursorMode[] = ["agent", "fast", "plan"];

export interface CloudSettings {
	/** Repository cloned by the cloud agent. Required for cloud runs. */
	repository?: string;
	startingRef?: string;
	autoCreatePR: boolean;
}

export interface McpBridgeSettings {
	enabled: boolean;
	/** When set, only these Pi tools are exposed. */
	include?: string[];
	/** Always removed from the exposed set. */
	exclude: string[];
	callTimeoutMs: number;
}

export interface CursorProviderSettings {
	runtime: CursorRuntime;
	mode: CursorMode;
	cloud: CloudSettings;
	mcpBridge: McpBridgeSettings;
	/** Cursor setting sources the local agent loads (rules, AGENTS.md, MCP config). */
	settingSources?: SettingSourceName[];
	/** Model ids (base ids, without `@context`) that must not receive images. */
	textOnlyModels: string[];
	maxImageBytes: number;
	modelCacheTtlMs: number;
}

export interface SettingsLoadResult {
	settings: CursorProviderSettings;
	warnings: string[];
}

export const DEFAULT_SETTINGS: CursorProviderSettings = {
	runtime: "local",
	mode: "agent",
	cloud: { autoCreatePR: false },
	mcpBridge: { enabled: false, exclude: [], callTimeoutMs: 10 * 60 * 1000 },
	textOnlyModels: [],
	maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
	modelCacheTtlMs: DEFAULT_MODEL_CACHE_TTL_MS,
};

const SETTING_SOURCES: readonly SettingSourceName[] = [
	"project",
	"user",
	"team",
	"mdm",
	"plugins",
	"all",
];

export function settingsPath(agentDir: string): string {
	return join(agentDir, "cursor-provider.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * Validates untrusted JSON settings. Invalid fields fall back to defaults independently and
 * produce a warning; secrets are rejected because this file is plain text.
 */
export function parseSettings(raw: unknown): SettingsLoadResult {
	const warnings: string[] = [];
	const settings: CursorProviderSettings = structuredClone(DEFAULT_SETTINGS);
	if (raw === undefined) return { settings, warnings };
	if (!isRecord(raw)) {
		warnings.push("cursor-provider.json must contain a JSON object; using defaults.");
		return { settings, warnings };
	}
	if ("apiKey" in raw) {
		warnings.push("Ignoring `apiKey` in cursor-provider.json. Use /login cursor-agent instead.");
	}

	if (raw.runtime !== undefined) {
		if (raw.runtime === "local" || raw.runtime === "cloud") settings.runtime = raw.runtime;
		else warnings.push('`runtime` must be "local" or "cloud"; using "local".');
	}
	if (raw.mode !== undefined) {
		if (CURSOR_MODES.includes(raw.mode as CursorMode)) settings.mode = raw.mode as CursorMode;
		else warnings.push('`mode` must be "agent", "fast", or "plan"; using "agent".');
	}

	if (raw.cloud !== undefined) {
		if (!isRecord(raw.cloud)) warnings.push("`cloud` must be an object; ignoring it.");
		else {
			if (typeof raw.cloud.repository === "string" && raw.cloud.repository.trim() !== "") {
				settings.cloud.repository = raw.cloud.repository.trim();
			}
			if (typeof raw.cloud.startingRef === "string" && raw.cloud.startingRef.trim() !== "") {
				settings.cloud.startingRef = raw.cloud.startingRef.trim();
			}
			if (typeof raw.cloud.autoCreatePR === "boolean")
				settings.cloud.autoCreatePR = raw.cloud.autoCreatePR;
		}
	}

	if (raw.mcpBridge !== undefined) {
		if (!isRecord(raw.mcpBridge)) warnings.push("`mcpBridge` must be an object; ignoring it.");
		else {
			if (typeof raw.mcpBridge.enabled === "boolean")
				settings.mcpBridge.enabled = raw.mcpBridge.enabled;
			const include = stringList(raw.mcpBridge.include);
			if (include) settings.mcpBridge.include = include;
			const exclude = stringList(raw.mcpBridge.exclude);
			if (exclude) settings.mcpBridge.exclude = exclude;
			const timeout = positiveInteger(raw.mcpBridge.callTimeoutMs);
			if (timeout) settings.mcpBridge.callTimeoutMs = timeout;
		}
	}

	if (raw.settingSources !== undefined) {
		const sources = stringList(raw.settingSources);
		const valid = sources?.filter((s): s is SettingSourceName =>
			SETTING_SOURCES.includes(s as SettingSourceName),
		);
		if (valid && valid.length === sources?.length) settings.settingSources = valid;
		else warnings.push(`\`settingSources\` entries must be one of ${SETTING_SOURCES.join(", ")}.`);
	}

	const textOnly = stringList(raw.textOnlyModels);
	if (textOnly) settings.textOnlyModels = textOnly;
	const maxImageBytes = positiveInteger(raw.maxImageBytes);
	if (maxImageBytes) settings.maxImageBytes = maxImageBytes;
	const ttl = positiveInteger(raw.modelCacheTtlMs);
	if (ttl) settings.modelCacheTtlMs = ttl;

	return { settings, warnings };
}

export function loadSettings(agentDir: string): SettingsLoadResult {
	let text: string;
	try {
		text = readFileSync(settingsPath(agentDir), "utf8");
	} catch {
		return parseSettings(undefined);
	}
	try {
		return parseSettings(JSON.parse(text));
	} catch {
		const result = parseSettings(undefined);
		result.warnings.push("cursor-provider.json is not valid JSON; using defaults.");
		return result;
	}
}

export interface FlagValues {
	runtime?: string | boolean;
	mode?: string | boolean;
	mcpBridge?: string | boolean;
}

/** CLI flags override the settings file for one run. Cloud still requires an explicit value. */
export function applyFlags(settings: CursorProviderSettings, flags: FlagValues): string[] {
	const warnings: string[] = [];
	if (typeof flags.runtime === "string" && flags.runtime !== "") {
		if (flags.runtime === "local" || flags.runtime === "cloud") settings.runtime = flags.runtime;
		else
			warnings.push(
				`Unknown --cursor-agent-runtime "${flags.runtime}"; keeping "${settings.runtime}".`,
			);
	}
	if (typeof flags.mode === "string" && flags.mode !== "") {
		if (CURSOR_MODES.includes(flags.mode as CursorMode)) settings.mode = flags.mode as CursorMode;
		else warnings.push(`Unknown --cursor-agent-mode "${flags.mode}"; keeping "${settings.mode}".`);
	}
	if (flags.mcpBridge === true) settings.mcpBridge.enabled = true;
	return warnings;
}
