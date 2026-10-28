import { describe, expect, test } from "bun:test";
import type {
	ApiKeyCredential,
	AuthContext,
	AuthEvent,
	AuthInteraction,
	AuthPrompt,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { createCursorAuth } from "./auth.ts";
import { API_KEY_ENV } from "./constants.ts";
import { createModelCatalog } from "./models.ts";
import type { CursorSdk, ModelListItem } from "./sdk.ts";

const FAKE_KEY = "key_test_0000000000000000";
const STORED_KEY = "key_test_1111111111111111";
const MODEL: ModelListItem = { id: "composer-test", displayName: "Composer Test" };

function makeSdk(listModels: CursorSdk["listModels"]): CursorSdk {
	return {
		listModels,
		createAgent: async () => {
			throw new Error("Unexpected createAgent call");
		},
		resumeAgent: async () => {
			throw new Error("Unexpected resumeAgent call");
		},
		listLocalRuns: async () => [],
	};
}

function makeAuth(
	options: { loadSdk?: () => Promise<CursorSdk>; items?: ModelListItem[]; calls?: string[] } = {},
) {
	const calls = options.calls ?? [];
	const catalog = createModelCatalog({
		loadSdk: async () =>
			makeSdk(async (key) => {
				calls.push(key);
				return options.items ?? [MODEL];
			}),
		ttlMs: () => 100,
		textOnlyModels: () => [],
		env: () => undefined,
		now: () => 1_000,
	});
	const auth = createCursorAuth({
		loadSdk:
			options.loadSdk ??
			(async () =>
				makeSdk(async (key) => {
					calls.push(key);
					return options.items ?? [MODEL];
				})),
		catalog,
	});
	return { auth, catalog, calls };
}

function makeInteraction(key: string): {
	interaction: AuthInteraction & { signal: AbortSignal };
	prompts: AuthPrompt[];
	notifications: AuthEvent[];
} {
	const prompts: AuthPrompt[] = [];
	const notifications: AuthEvent[] = [];
	return {
		interaction: {
			signal: new AbortController().signal,
			prompt: async (prompt) => {
				prompts.push(prompt);
				return key;
			},
			notify: (event) => notifications.push(event),
		},
		prompts,
		notifications,
	};
}

function makeRefreshContext(allowNetwork: boolean): RefreshModelsContext {
	return {
		allowNetwork,
		signal: new AbortController().signal,
		publish: async (publication) => {
			publication.update?.();
			return true;
		},
	};
}

function makeAuthContext(envValue?: string, reads: string[] = []): AuthContext {
	return {
		env: async (name) => {
			reads.push(name);
			return name === API_KEY_ENV ? envValue : undefined;
		},
		fileExists: async () => false,
	};
}

describe("createCursorAuth login", () => {
	test("validates a key with listModels and primes the catalog for post-login publication", async () => {
		const calls: string[] = [];
		const { auth, catalog } = makeAuth({ calls });
		const { interaction, prompts, notifications } = makeInteraction(FAKE_KEY);
		const apiKeyAuth = auth.apiKey;
		expect(apiKeyAuth?.login).toBeDefined();
		if (!apiKeyAuth?.login) throw new Error("Expected Cursor API-key login");

		const credential = await apiKeyAuth.login(interaction);

		expect(credential).toEqual({ type: "api_key", key: FAKE_KEY });
		expect(calls).toEqual([FAKE_KEY]);
		expect(prompts).toEqual([{ type: "secret", message: "Cursor API key", placeholder: "key_…" }]);
		expect(notifications.some((event) => event.type === "progress")).toBe(true);
		expect(
			notifications.some(
				(event) => event.type === "info" && event.message.includes("1 Cursor models"),
			),
		).toBe(true);
		expect(catalog.getModels()).toHaveLength(0);

		await catalog.refresh(makeRefreshContext(false));

		expect(catalog.getModels().map((model) => model.id)).toEqual(["composer-test"]);
		expect(catalog.status().source).toBe("login");
		expect(calls).toEqual([FAKE_KEY]);
	});

	test("rejects a key when Cursor returns no usable models", async () => {
		const { auth, calls } = makeAuth({ items: [], calls: [] });
		const apiKeyAuth = auth.apiKey;
		if (!apiKeyAuth?.login) throw new Error("Expected Cursor API-key login");
		const { interaction } = makeInteraction(FAKE_KEY);

		await expect(apiKeyAuth.login(interaction)).rejects.toThrow(
			"Cursor accepted the key but returned no usable models for this account.",
		);
		expect(calls).toEqual([FAKE_KEY]);
	});
});

describe("createCursorAuth credential resolution", () => {
	test("prefers the stored key for check and resolve", async () => {
		const { auth } = makeAuth({ loadSdk: async () => makeSdk(async () => [MODEL]) });
		const reads: string[] = [];
		const ctx = makeAuthContext(FAKE_KEY, reads);
		const credential: ApiKeyCredential = { type: "api_key", key: STORED_KEY };
		const signal = new AbortController().signal;
		const apiKeyAuth = auth.apiKey;
		if (!apiKeyAuth?.check || !apiKeyAuth.resolve) throw new Error("Expected Cursor API-key auth");

		const check = await apiKeyAuth.check({ ctx, credential, signal });
		const result = await apiKeyAuth.resolve({ ctx, credential, signal });

		expect(check).toEqual({ type: "api_key", source: "/login" });
		expect(result).toEqual({ auth: { apiKey: STORED_KEY }, source: "/login" });
		expect(reads).toEqual([]);
	});

	test("falls back to CURSOR_API_KEY for check and resolve", async () => {
		const { auth } = makeAuth({ loadSdk: async () => makeSdk(async () => [MODEL]) });
		const reads: string[] = [];
		const ctx = makeAuthContext(FAKE_KEY, reads);
		const signal = new AbortController().signal;
		const apiKeyAuth = auth.apiKey;
		if (!apiKeyAuth?.check || !apiKeyAuth.resolve) throw new Error("Expected Cursor API-key auth");

		const check = await apiKeyAuth.check({ ctx, signal });
		const result = await apiKeyAuth.resolve({ ctx, signal });

		expect(check).toEqual({ type: "api_key", source: API_KEY_ENV });
		expect(result).toEqual({ auth: { apiKey: FAKE_KEY }, source: API_KEY_ENV });
		expect(reads).toEqual([API_KEY_ENV, API_KEY_ENV]);
	});

	test("reports missing credentials as unconfigured", async () => {
		const { auth } = makeAuth({ loadSdk: async () => makeSdk(async () => [MODEL]) });
		const ctx = makeAuthContext(undefined);
		const signal = new AbortController().signal;
		const apiKeyAuth = auth.apiKey;
		if (!apiKeyAuth?.check || !apiKeyAuth.resolve) throw new Error("Expected Cursor API-key auth");

		expect(await apiKeyAuth.check({ ctx, signal })).toBeUndefined();
		expect(await apiKeyAuth.resolve({ ctx, signal })).toBeUndefined();
	});
});
