import { describe, expect, test } from "bun:test";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { toPiModels } from "./catalog.ts";
import { STALE_MODEL_CACHE_MS } from "./constants.ts";
import { createModelCatalog, type ModelCatalog } from "./models.ts";
import type { CursorSdk, ModelListItem } from "./sdk.ts";

const FAKE_KEY = "key_test_0000000000000000";
const TTL_MS = 100;
const CACHED_ITEM: ModelListItem = { id: "cached-model", displayName: "Cached Model" };
const FRESH_ITEM: ModelListItem = { id: "fresh-model", displayName: "Fresh Model" };
type Publication = Parameters<RefreshModelsContext["publish"]>[0];

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

function makeCatalog(
	options: {
		loadSdk?: () => Promise<CursorSdk>;
		env?: (name: string) => string | undefined;
		now?: () => number;
		ttlMs?: number;
	} = {},
): { catalog: ModelCatalog; sdkLoads: { count: number } } {
	const sdkLoads = { count: 0 };
	const catalog = createModelCatalog({
		loadSdk:
			options.loadSdk ??
			(async () => {
				sdkLoads.count += 1;
				return makeSdk(async () => [FRESH_ITEM]);
			}),
		ttlMs: () => options.ttlMs ?? TTL_MS,
		textOnlyModels: () => [],
		env: options.env ?? (() => FAKE_KEY),
		now: options.now ?? (() => 1_000),
	});
	return { catalog, sdkLoads };
}

function makeRefreshContext(overrides: Partial<RefreshModelsContext> = {}): {
	context: RefreshModelsContext;
	publications: Publication[];
} {
	const publications: Publication[] = [];
	const context: RefreshModelsContext = {
		allowNetwork: true,
		signal: new AbortController().signal,
		publish: async (publication) => {
			publications.push(publication);
			publication.update?.();
			return true;
		},
		...overrides,
	};
	return { context, publications };
}

function snapshot(item: ModelListItem, checkedAt: number) {
	const models = toPiModels([item]);
	if (models.length === 0) throw new Error("Expected a model snapshot");
	return { models, checkedAt };
}

function ids(catalog: ModelCatalog): string[] {
	return catalog.getModels().map((model) => model.id);
}

describe("createModelCatalog", () => {
	test("restores a fresh cache and skips the SDK until its TTL expires", async () => {
		const { catalog, sdkLoads } = makeCatalog({ now: () => 1_000 });
		const { context } = makeRefreshContext({
			stored: snapshot(CACHED_ITEM, 950),
		});

		await catalog.refresh(context);

		expect(ids(catalog)).toEqual(["cached-model"]);
		expect(catalog.status()).toMatchObject({
			source: "cache",
			count: 1,
			checkedAt: 950,
			stale: false,
		});
		expect(sdkLoads.count).toBe(0);
	});

	test("force refresh bypasses a fresh cache and publishes the network list", async () => {
		const calls: string[] = [];
		const { catalog } = makeCatalog({
			now: () => 1_000,
			loadSdk: async () =>
				makeSdk(async (apiKey) => {
					calls.push(apiKey);
					return [FRESH_ITEM];
				}),
		});
		const { context, publications } = makeRefreshContext({
			stored: snapshot(CACHED_ITEM, 950),
			force: true,
		});

		await catalog.refresh(context);

		expect(calls).toEqual([FAKE_KEY]);
		expect(ids(catalog)).toEqual(["fresh-model"]);
		expect(catalog.status()).toMatchObject({ source: "network", count: 1, checkedAt: 1_000 });
		expect(
			publications.some((publication) => publication.persist?.models[0]?.id === "fresh-model"),
		).toBe(true);
	});

	test("keeps an offline stale cache available and marks it stale", async () => {
		const now = STALE_MODEL_CACHE_MS + 10_000;
		const { catalog, sdkLoads } = makeCatalog({ now: () => now });
		const { context } = makeRefreshContext({
			allowNetwork: false,
			stored: snapshot(CACHED_ITEM, 0),
		});

		await catalog.refresh(context);

		expect(ids(catalog)).toEqual(["cached-model"]);
		expect(catalog.status()).toMatchObject({ source: "cache", count: 1, stale: true });
		expect(sdkLoads.count).toBe(0);
	});

	test("does not load the SDK or request models when no API key is available", async () => {
		const { catalog, sdkLoads } = makeCatalog({ env: () => undefined });
		const { context } = makeRefreshContext();

		await catalog.refresh(context);

		expect(ids(catalog)).toEqual([]);
		expect(catalog.status()).toMatchObject({ source: "none", count: 0 });
		expect(sdkLoads.count).toBe(0);
	});

	test("keeps the last list on network failure and redacts the API key from status", async () => {
		const now = STALE_MODEL_CACHE_MS + 10_000;
		const { catalog } = makeCatalog({
			now: () => now,
			loadSdk: async () =>
				makeSdk(async () => {
					throw new Error(`Request failed while using ${FAKE_KEY}`);
				}),
		});
		const { context } = makeRefreshContext({
			stored: snapshot(CACHED_ITEM, 0),
		});

		await expect(catalog.refresh(context)).rejects.toThrow("redacted");

		expect(ids(catalog)).toEqual(["cached-model"]);
		expect(catalog.status()).toMatchObject({ source: "cache", count: 1, stale: true });
		expect(catalog.status().lastError).toContain("[redacted]");
		expect(catalog.status().lastError).not.toContain(FAKE_KEY);
	});

	test("publishes a login-primed list without loading the SDK again", async () => {
		const { catalog, sdkLoads } = makeCatalog();
		expect(catalog.prime([FRESH_ITEM])).toBe(1);
		expect(catalog.status()).toMatchObject({ source: "none", count: 0 });
		const { context, publications } = makeRefreshContext({ allowNetwork: false });

		await catalog.refresh(context);

		expect(ids(catalog)).toEqual(["fresh-model"]);
		expect(catalog.status()).toMatchObject({ source: "login", count: 1, checkedAt: 1_000 });
		expect(publications).toHaveLength(1);
		expect(publications[0]?.persist?.models[0]?.id).toBe("fresh-model");
		expect(sdkLoads.count).toBe(0);
	});
});
