import { describe, expect, test } from "bun:test";
import {
	buildThinkingLevelMap,
	type CursorModelMeta,
	parseContextWindow,
	restorePiModels,
	selectModel,
	toPiModels,
} from "./catalog.ts";
import type { ModelListItem } from "./sdk.ts";

const CONTEXT_MODEL: ModelListItem = {
	id: "composer-test",
	displayName: "Composer Test",
	parameters: [
		{ id: "context", values: [{ value: "128k" }, { value: "1m" }] },
		{ id: "reasoning_effort", values: [{ value: "low" }, { value: "high" }] },
	],
	variants: [
		{
			params: [
				{ id: "context", value: "128k" },
				{ id: "reasoning_effort", value: "low" },
			],
			displayName: "Default",
			isDefault: true,
		},
		{
			params: [
				{ id: "context", value: "1m" },
				{ id: "reasoning_effort", value: "high" },
			],
			displayName: "Large context",
		},
	],
};

describe("parseContextWindow", () => {
	test("parses k/m suffixes, decimals, and surrounding whitespace", () => {
		expect(parseContextWindow("128k")).toBe(128_000);
		expect(parseContextWindow(" 1.5 M ")).toBe(1_500_000);
		expect(parseContextWindow("1.25k")).toBe(1_250);
		expect(parseContextWindow("200K")).toBe(200_000);
	});

	test("returns undefined when Cursor does not provide a parseable size", () => {
		for (const value of [undefined, "", "200000", "200 tokens", "NaNk", "-2k"]) {
			expect(parseContextWindow(value)).toBeUndefined();
		}
	});
});

describe("buildThinkingLevelMap", () => {
	test("maps named values and aliases to Pi thinking levels", () => {
		const map = buildThinkingLevelMap({
			id: "reasoning_effort",
			values: ["none", "minimal", "medium", "extra-high", "max", "custom"],
		});
		expect(map?.off).toBe("none");
		expect(map?.minimal).toBe("minimal");
		expect(map?.medium).toBe("medium");
		expect(map?.xhigh).toBe("extra-high");
		expect(map?.max).toBe("max");
		expect(map?.low).toBeNull();
		expect(map?.high).toBeNull();
	});

	test("maps boolean reasoning values to off/high and leaves unsupported levels null", () => {
		const map = buildThinkingLevelMap({ id: "thinking", values: ["false", "true"] });
		expect(map?.off).toBe("false");
		expect(map?.high).toBe("true");
		expect(map?.minimal).toBeNull();
		expect(map?.low).toBeNull();
		expect(map?.medium).toBeNull();
		expect(map?.xhigh).toBeNull();
		expect(map?.max).toBeNull();
		expect(buildThinkingLevelMap(undefined)).toBeUndefined();
	});
});

describe("toPiModels", () => {
	test("creates context-pinned variants and maps text-only and thinking metadata", () => {
		const models = toPiModels([CONTEXT_MODEL], { textOnlyModels: ["composer-test"] });

		expect(models.map((model) => model.id)).toEqual(["composer-test", "composer-test@1m"]);
		expect(models.map((model) => model.name)).toEqual([
			"Composer Test (128K)",
			"Composer Test (1M)",
		]);
		expect(models.map((model) => model.contextWindow)).toEqual([128_000, 1_000_000]);
		expect(models.every((model) => model.maxTokens === 64_000)).toBe(true);
		expect(models.map((model) => model.input)).toEqual([["text"], ["text"]]);
		expect(models[0]?.cursor).toMatchObject({
			baseId: "composer-test",
			context: "128k",
			contextReported: true,
			thinkingParam: "reasoning_effort",
		});
		expect(models[1]?.cursor.context).toBe("1m");
		expect(models[0]?.reasoning).toBe(true);
		expect(models[0]?.thinkingLevelMap?.low).toBe("low");
		expect(models[0]?.thinkingLevelMap?.high).toBe("high");
	});

	test("drops invalid/duplicate ids without fabricating unreported model metadata", () => {
		const bareModel: ModelListItem = { id: "bare-model", displayName: "Bare Model" };
		const models = toPiModels([
			{ id: "   ", displayName: "Blank id" },
			bareModel,
			{ id: "bare-model", displayName: "Duplicate" },
			null as unknown as ModelListItem,
		]);

		expect(models).toHaveLength(1);
		expect(models[0]?.name).toBe("Bare Model");
		expect(models[0]?.contextWindow).toBe(200_000);
		expect(models[0]?.maxTokens).toBe(64_000);
		expect(models[0]?.reasoning).toBe(false);
		expect(models[0]?.thinkingLevelMap).toBeUndefined();
		expect(models[0]?.cursor).toMatchObject({
			baseId: "bare-model",
			params: [],
			variants: [],
			contextReported: false,
		});
		expect(models[0]?.cursor.context).toBeUndefined();
	});

	test("discards invalid parameter and variant metadata rather than inventing values", () => {
		const item = {
			id: "partial",
			displayName: "Partial",
			parameters: [
				{ id: "context", values: [{ value: "128k" }] },
				{ id: "broken", values: "not-an-array" },
			],
			variants: [
				{ params: [{ id: "context", value: "128k" }], displayName: "Valid" },
				{ params: [{ id: "context", value: 128 }], displayName: "Invalid" },
			],
		} as unknown as ModelListItem;
		const [model] = toPiModels([item]);

		expect(model?.cursor.params).toEqual([{ id: "context", values: ["128k"] }]);
		expect(model?.cursor.variants).toEqual([{ params: { context: "128k" }, isDefault: false }]);
	});
});

describe("restorePiModels", () => {
	test("restores only models carrying this provider's persisted metadata", () => {
		const [valid] = toPiModels([CONTEXT_MODEL]);
		expect(valid).toBeDefined();
		if (!valid) throw new Error("Expected fixture model");

		const restored = restorePiModels([
			valid,
			{ ...valid, provider: "another-provider" },
			{ ...valid, api: "another-api" },
			{ ...valid, cursor: { baseId: "missing-arrays" } },
			{ id: valid.id, provider: valid.provider, api: valid.api, cursor: valid.cursor },
			null,
		]);

		expect(restored).toEqual([valid]);
	});
});

describe("selectModel", () => {
	const meta: CursorModelMeta = {
		baseId: "composer-test",
		params: [
			{ id: "context", values: ["128k", "256k"] },
			{ id: "reasoning_effort", values: ["low", "high"] },
			{ id: "fast", values: ["false", "true"] },
		],
		variants: [
			{
				params: { context: "128k", reasoning_effort: "low", fast: "false" },
				isDefault: true,
			},
			{
				params: { context: "256k", reasoning_effort: "high", fast: "true" },
				isDefault: false,
			},
			{
				params: { context: "128k", reasoning_effort: "high", fast: "true" },
				isDefault: false,
			},
		],
		context: "128k",
		contextReported: true,
		thinkingParam: "reasoning_effort",
	};

	test("scores context, requested reasoning, and fast mode in priority order", () => {
		expect(selectModel(meta, { thinkingValue: "high", fast: true })).toEqual({
			id: "composer-test",
			params: [
				{ id: "context", value: "128k" },
				{ id: "reasoning_effort", value: "high" },
				{ id: "fast", value: "true" },
			],
		});
	});

	test("uses Cursor's default variant to break equal scores", () => {
		const noMatchingRequest: CursorModelMeta = {
			...meta,
			context: "not-listed",
			thinkingParam: undefined,
		};
		expect(selectModel(noMatchingRequest, {})).toEqual({
			id: "composer-test",
			params: [
				{ id: "context", value: "128k" },
				{ id: "reasoning_effort", value: "low" },
				{ id: "fast", value: "false" },
			],
		});
	});

	test("without variants sends only declared parameter values", () => {
		const noVariants = { ...meta, context: "512k", variants: [] };
		expect(selectModel(noVariants, { thinkingValue: "high", fast: true })).toEqual({
			id: "composer-test",
			params: [
				{ id: "reasoning_effort", value: "high" },
				{ id: "fast", value: "true" },
			],
		});
	});
});
