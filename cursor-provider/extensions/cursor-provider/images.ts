import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { SUPPORTED_IMAGE_MIME_TYPES } from "./constants.ts";
import { CursorProviderError } from "./errors.ts";
import type { SDKImage } from "./sdk.ts";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function isWellFormedBase64(data: string): boolean {
	if (data === "" || !BASE64.test(data) || data.length % 4 === 1) return false;
	return !data.endsWith("=") || data.length % 4 === 0;
}

export function decodedBase64Bytes(data: string): number {
	const clean = data.replace(/\s/g, "");
	const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
	return Math.floor((clean.length * 3) / 4) - padding;
}

/**
 * Validates images for the selected model and converts them to SDK image input. Cursor documents
 * no MIME allowlist, so this accepts the formats every Cursor vision model is known to take and
 * fails early with an explanation instead of letting the run fail remotely.
 */
export function toSdkImages(
	model: Model<Api>,
	images: readonly ImageContent[],
	maxBytes: number,
): SDKImage[] {
	if (images.length === 0) return [];
	if (!model.input.includes("image")) {
		throw new CursorProviderError(
			`${model.name} (${model.id}) is configured as text-only, so it cannot receive the ` +
				`${images.length} attached image(s). Choose a vision-capable Cursor model or remove the images. ` +
				"If this model does accept images, remove it from `textOnlyModels` in cursor-provider.json.",
		);
	}
	return images.map((image, index) => {
		const label = `Image ${index + 1}`;
		const mimeType = image.mimeType.toLowerCase();
		if (!(SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
			throw new CursorProviderError(
				`${label} has unsupported type "${image.mimeType}". Cursor accepts ${SUPPORTED_IMAGE_MIME_TYPES.join(", ")}.`,
			);
		}
		const data = image.data.replace(/\s/g, "");
		if (!isWellFormedBase64(data)) {
			throw new CursorProviderError(`${label} is not valid base64 image data.`);
		}
		const bytes = decodedBase64Bytes(data);
		if (bytes > maxBytes) {
			const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
			throw new CursorProviderError(
				`${label} is ${mb(bytes)} MB, above the ${mb(maxBytes)} MB limit (maxImageBytes in cursor-provider.json).`,
			);
		}
		return { data, mimeType };
	});
}
