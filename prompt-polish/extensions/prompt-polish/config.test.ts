import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	DEFAULT_POLISH_CONFIG,
	loadPolishConfig,
	POLISH_CONFIG_URL,
	parsePolishConfig,
	THINKING_LEVELS,
} from "./config.ts";

async function withConfigFile<T>(raw: string, callback: (url: URL) => Promise<T>) {
	const directory = await mkdtemp(join(tmpdir(), "prompt-polish-config-"));
	const path = join(directory, "polish.config.json");
	await writeFile(path, raw, "utf8");
	try {
		return await callback(pathToFileURL(path));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("exports and loads the exact module-relative defaults", async () => {
	expect(DEFAULT_POLISH_CONFIG).toEqual({
		model: "openrouter/anthropic/claude-opus-5.5",
		thinkingLevel: "high",
		fastMode: false,
	});
	expect(THINKING_LEVELS).toEqual([
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
	expect(POLISH_CONFIG_URL.protocol).toBe("file:");
	expect(POLISH_CONFIG_URL.pathname.endsWith("/polish.config.json")).toBe(true);
	expect(await loadPolishConfig()).toEqual(DEFAULT_POLISH_CONFIG);
});

test("keeps valid partial settings and fills missing fields independently", () => {
	expect(
		parsePolishConfig(JSON.stringify({ model: "custom-model" })),
	).toEqual({
		model: "custom-model",
		thinkingLevel: "high",
		fastMode: false,
	});
	expect(
		parsePolishConfig(JSON.stringify({ thinkingLevel: "xhigh", fastMode: true })),
	).toEqual({
		model: "openrouter/anthropic/claude-opus-5.5",
		thinkingLevel: "xhigh",
		fastMode: true,
	});
});

test("falls back independently for invalid types and values", () => {
	expect(
		parsePolishConfig(
			JSON.stringify({ model: 42, thinkingLevel: "extreme", fastMode: "yes" }),
		),
	).toEqual(DEFAULT_POLISH_CONFIG);
	expect(
		parsePolishConfig(
			JSON.stringify({ model: "  ", thinkingLevel: "low", fastMode: false }),
		),
	).toEqual({
			model: "openrouter/anthropic/claude-opus-5.5",
			thinkingLevel: "low",
			fastMode: false,
		});
});

test("falls back for malformed JSON and non-object roots", () => {
	expect(parsePolishConfig("{ malformed")).toEqual(DEFAULT_POLISH_CONFIG);
	expect(parsePolishConfig("[]")).toEqual(DEFAULT_POLISH_CONFIG);
	expect(parsePolishConfig("null")).toEqual(DEFAULT_POLISH_CONFIG);
});

test("loader catches malformed and missing files", async () => {
	await withConfigFile('{"model":"custom-model"', async (url) => {
		expect(await loadPolishConfig(url)).toEqual(DEFAULT_POLISH_CONFIG);
	});

	const missing = new URL("./missing-polish.config.json", import.meta.url);
	expect(await loadPolishConfig(missing)).toEqual(DEFAULT_POLISH_CONFIG);
});
