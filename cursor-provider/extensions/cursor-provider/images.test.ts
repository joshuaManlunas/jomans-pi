import { describe, expect, test } from "bun:test";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { toPiModels } from "./catalog.ts";
import { toSdkImages } from "./images.ts";
import type { ModelListItem } from "./sdk.ts";

const ITEM: ModelListItem = { id: "image-model", displayName: "Image Model" };
const VISION_MODEL = toPiModels([ITEM])[0];
const TEXT_MODEL = toPiModels([ITEM], { textOnlyModels: [ITEM.id] })[0];

if (!VISION_MODEL || !TEXT_MODEL) throw new Error("Test models failed to register");

function image(data: string, mimeType = "image/png"): ImageContent {
	return { type: "image", data, mimeType };
}

describe("toSdkImages", () => {
	test("rejects attachments for a text-only model", () => {
		expect(() => toSdkImages(TEXT_MODEL, [image("YQ==")], 100)).toThrow(/text-only/i);
	});

	test("normalizes MIME case and whitespace around base64 data", () => {
		expect(toSdkImages(VISION_MODEL, [image("Y Q==\n", "IMAGE/PNG")], 1)).toEqual([
			{ data: "YQ==", mimeType: "image/png" },
		]);
	});

	test("rejects unsupported MIME types", () => {
		expect(() => toSdkImages(VISION_MODEL, [image("YQ==", "image/svg+xml")], 100)).toThrow(
			/unsupported type/i,
		);
	});

	test("rejects base64 data containing invalid characters", () => {
		expect(() => toSdkImages(VISION_MODEL, [image("YQ==$!")], 100)).toThrow(/base64/i);
	});

	test("rejects base64 with an impossible encoded length or misplaced padding", () => {
		expect(() => toSdkImages(VISION_MODEL, [image("A")], 100)).toThrow(/base64/i);
		expect(() => toSdkImages(VISION_MODEL, [image("YQ=")], 100)).toThrow(/base64/i);
	});

	test("accepts unpadded base64 and counts its decoded bytes", () => {
		expect(toSdkImages(VISION_MODEL, [image("YQ")], 1)).toHaveLength(1);
		expect(() => toSdkImages(VISION_MODEL, [image("YWJj")], 2)).toThrow(/above the .* limit/i);
	});

	test("allows data exactly at the byte limit and rejects data above it", () => {
		expect(toSdkImages(VISION_MODEL, [image("YQ==")], 1)).toHaveLength(1);
		expect(() => toSdkImages(VISION_MODEL, [image("AAAA")], 2)).toThrow(/above the .* limit/i);
	});
});

// Keep the fixture's provider-facing type explicit so model input changes are visible to tsc.
const _modelTypeCheck: Model<Api> = VISION_MODEL;
void _modelTypeCheck;
