import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFlags, DEFAULT_SETTINGS, loadSettings, parseSettings } from "./config.ts";

const FAKE_KEY = "key_test_0000000000000000";

describe("parseSettings", () => {
	test("validates fields independently, applies defaults, and reports invalid values", () => {
		const { settings, warnings } = parseSettings({
			runtime: "remote",
			mode: "outline",
			cloud: {
				repository: "  https://github.com/acme/repo  ",
				startingRef: " main ",
				autoCreatePR: true,
			},
			mcpBridge: {
				enabled: true,
				include: ["read", "", 7, "bash"],
				exclude: ["write"],
				callTimeoutMs: 0,
			},
			settingSources: ["project", "unknown"],
			textOnlyModels: [" composer ", "", false],
			maxImageBytes: -1,
			modelCacheTtlMs: 1.5,
		});

		expect(settings.runtime).toBe("local");
		expect(settings.mode).toBe("agent");
		expect(settings.cloud).toEqual({
			repository: "https://github.com/acme/repo",
			startingRef: "main",
			autoCreatePR: true,
		});
		expect(settings.mcpBridge.enabled).toBe(true);
		expect(settings.mcpBridge.include).toEqual(["read", "bash"]);
		expect(settings.mcpBridge.exclude).toEqual(["write"]);
		expect(settings.mcpBridge.callTimeoutMs).toBe(DEFAULT_SETTINGS.mcpBridge.callTimeoutMs);
		expect(settings.settingSources).toBeUndefined();
		expect(settings.textOnlyModels).toEqual([" composer "]);
		expect(settings.maxImageBytes).toBe(DEFAULT_SETTINGS.maxImageBytes);
		expect(settings.modelCacheTtlMs).toBe(DEFAULT_SETTINGS.modelCacheTtlMs);
		expect(warnings).toHaveLength(3);
		expect(warnings.join("\n")).toContain("runtime");
		expect(warnings.join("\n")).toContain("mode");
		expect(warnings.join("\n")).toContain("settingSources");
	});

	test("warns and uses defaults for a non-object JSON value", () => {
		const result = parseSettings(["not", "an", "object"]);
		expect(result.settings).toEqual(DEFAULT_SETTINGS);
		expect(result.warnings).toEqual([
			"cursor-provider.json must contain a JSON object; using defaults.",
		]);
	});

	test("rejects API keys from the plain-text settings file", () => {
		const result = parseSettings({ apiKey: FAKE_KEY, runtime: "cloud" });
		expect(result.settings.runtime).toBe("cloud");
		expect("apiKey" in result.settings).toBe(false);
		expect(result.warnings).toEqual([
			"Ignoring `apiKey` in cursor-provider.json. Use /login cursor-agent instead.",
		]);
		expect(result.warnings.join(" ")).not.toContain(FAKE_KEY);
	});
});

describe("applyFlags", () => {
	test("valid CLI flags override settings and invalid values warn without overwriting", () => {
		const settings = parseSettings({ runtime: "local", mode: "plan" }).settings;
		const warnings = applyFlags(settings, {
			runtime: "cloud",
			mode: "explore",
			mcpBridge: true,
		});

		expect(settings.runtime).toBe("cloud");
		expect(settings.mode).toBe("plan");
		expect(settings.mcpBridge.enabled).toBe(true);
		expect(warnings).toEqual(['Unknown --cursor-agent-mode "explore"; keeping "plan".']);
	});

	test("false boolean flag values do not disable the configured MCP bridge", () => {
		const settings = parseSettings({ mcpBridge: { enabled: true } }).settings;
		expect(applyFlags(settings, { runtime: false, mode: false, mcpBridge: false })).toEqual([]);
		expect(settings.runtime).toBe("local");
		expect(settings.mode).toBe("agent");
		expect(settings.mcpBridge.enabled).toBe(true);
	});
});

describe("loadSettings", () => {
	function withTempDir(run: (dir: string) => void): void {
		const dir = mkdtempSync(join(tmpdir(), "cursor-provider-config-test-"));
		try {
			run(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("uses defaults silently when the settings file is missing", () => {
		withTempDir((dir) => {
			const result = loadSettings(dir);
			expect(result.settings).toEqual(DEFAULT_SETTINGS);
			expect(result.warnings).toEqual([]);
		});
	});

	test("warns and uses defaults when the settings file is invalid JSON", () => {
		withTempDir((dir) => {
			writeFileSync(join(dir, "cursor-provider.json"), "{ invalid", "utf8");
			const result = loadSettings(dir);
			expect(result.settings).toEqual(DEFAULT_SETTINGS);
			expect(result.warnings).toEqual(["cursor-provider.json is not valid JSON; using defaults."]);
		});
	});
});
