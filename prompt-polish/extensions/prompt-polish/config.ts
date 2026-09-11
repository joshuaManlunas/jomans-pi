import { readFile } from "node:fs/promises";

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type PolishConfig = {
	model: string;
	thinkingLevel: ThinkingLevel;
	fastMode: boolean;
};

export const DEFAULT_POLISH_CONFIG: Readonly<PolishConfig> = Object.freeze({
	model: "gpt-5.6-sol",
	thinkingLevel: "high",
	fastMode: true,
});

export const POLISH_CONFIG_URL = new URL("./polish.config.json", import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		typeof value === "string" &&
		(THINKING_LEVELS as readonly string[]).includes(value)
	);
}

function defaults(): PolishConfig {
	return { ...DEFAULT_POLISH_CONFIG };
}

function normalizeConfig(value: unknown): PolishConfig {
	if (!isRecord(value)) return defaults();

	return {
		model:
			typeof value.model === "string" && value.model.trim()
				? value.model.trim()
				: DEFAULT_POLISH_CONFIG.model,
		thinkingLevel: isThinkingLevel(value.thinkingLevel)
			? value.thinkingLevel
			: DEFAULT_POLISH_CONFIG.thinkingLevel,
		fastMode:
			typeof value.fastMode === "boolean"
				? value.fastMode
				: DEFAULT_POLISH_CONFIG.fastMode,
	};
}

export function parsePolishConfig(raw: string): PolishConfig {
	try {
		return normalizeConfig(JSON.parse(raw));
	} catch {
		return defaults();
	}
}

export async function loadPolishConfig(
	configUrl: URL | string = POLISH_CONFIG_URL,
): Promise<PolishConfig> {
	try {
		return parsePolishConfig(await readFile(configUrl, "utf8"));
	} catch {
		return defaults();
	}
}
