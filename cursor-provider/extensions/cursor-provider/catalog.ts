import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";
import {
	API_ID,
	BASE_URL,
	PROVIDER_ID,
	UNREPORTED_CONTEXT_WINDOW,
	UNREPORTED_MAX_TOKENS,
} from "./constants.ts";
import type { ModelListItem, ModelSelection } from "./sdk.ts";

export interface CursorParam {
	id: string;
	values: string[];
}

export interface CursorVariant {
	params: Record<string, string>;
	isDefault: boolean;
}

/** Cursor-side facts retained on each Pi model so requests can select a valid variant. */
export interface CursorModelMeta {
	baseId: string;
	params: CursorParam[];
	variants: CursorVariant[];
	/** Value of the `context` parameter this Pi model pins, when the model has one. */
	context?: string;
	/** False when Cursor reported no context size and Pi shows a placeholder. */
	contextReported: boolean;
	thinkingParam?: string;
}

export type CursorPiModel = Model<Api> & { cursor: CursorModelMeta };

const THINKING_PARAM_IDS = ["reasoning_effort", "effort", "reasoning", "thinking"] as const;
const PI_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
const LEVEL_ALIASES: Record<string, ModelThinkingLevel> = {
	none: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	"extra-high": "xhigh",
	max: "max",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseContextWindow(value: string | undefined): number | undefined {
	const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*([km])$/i);
	if (!match?.[1] || !match[2]) return undefined;
	const scale = match[2].toLowerCase() === "m" ? 1_000_000 : 1_000;
	return Math.round(Number(match[1]) * scale);
}

function normalizeParams(item: ModelListItem): CursorParam[] {
	const params: CursorParam[] = [];
	for (const p of item.parameters ?? []) {
		if (!isRecord(p) || typeof p.id !== "string" || !Array.isArray(p.values)) continue;
		const values = p.values
			.map((v) => (isRecord(v) && typeof v.value === "string" ? v.value : undefined))
			.filter((v): v is string => v !== undefined);
		if (values.length > 0) params.push({ id: p.id, values: [...new Set(values)] });
	}
	return params;
}

function normalizeVariants(item: ModelListItem, params: CursorParam[]): CursorVariant[] {
	const known = new Map(params.map((p) => [p.id, new Set(p.values)]));
	const variants: CursorVariant[] = [];
	for (const v of item.variants ?? []) {
		if (!isRecord(v) || !Array.isArray(v.params)) continue;
		const selected: Record<string, string> = {};
		let valid = true;
		for (const p of v.params) {
			if (!isRecord(p) || typeof p.id !== "string" || typeof p.value !== "string") {
				valid = false;
				break;
			}
			const allowed = known.get(p.id);
			if (allowed && !allowed.has(p.value)) valid = false;
			selected[p.id] = p.value;
		}
		if (valid) variants.push({ params: selected, isDefault: v.isDefault === true });
	}
	return variants;
}

function defaultVariant(meta: Pick<CursorModelMeta, "variants">): CursorVariant | undefined {
	return meta.variants.find((v) => v.isDefault) ?? meta.variants[0];
}

/** Maps Pi thinking levels onto the model's own thinking parameter; unsupported levels are null. */
export function buildThinkingLevelMap(
	param: CursorParam | undefined,
): ThinkingLevelMap | undefined {
	if (!param) return undefined;
	const map: ThinkingLevelMap = {};
	for (const level of PI_LEVELS) map[level] = null;
	const isBoolean = param.values.every((v) => v === "true" || v === "false");
	if (isBoolean) {
		if (param.values.includes("false")) map.off = "false";
		if (param.values.includes("true")) map.high = "true";
		return map;
	}
	for (const value of param.values) {
		const level = LEVEL_ALIASES[value.toLowerCase()];
		if (level && map[level] === null) map[level] = value;
	}
	return map;
}

function titleContext(value: string): string {
	return value.toUpperCase();
}

/**
 * Converts Cursor's model list into Pi models. Models with a `context` parameter produce one
 * Pi model per context size: the default size keeps the plain id, others use `id@size`.
 * Invalid entries are dropped rather than guessed.
 */
export function toPiModels(
	items: readonly ModelListItem[],
	options: { textOnlyModels?: readonly string[] } = {},
): CursorPiModel[] {
	const textOnly = new Set(options.textOnlyModels ?? []);
	const out: CursorPiModel[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		if (!isRecord(item) || typeof item.id !== "string" || item.id.trim() === "") continue;
		const baseId = item.id.trim();
		if (seen.has(baseId)) continue;
		seen.add(baseId);
		const displayName =
			typeof item.displayName === "string" && item.displayName.trim() !== ""
				? item.displayName.trim()
				: baseId;
		const params = normalizeParams(item);
		const variants = normalizeVariants(item, params);
		const thinking = params.find((p) =>
			THINKING_PARAM_IDS.includes(p.id as (typeof THINKING_PARAM_IDS)[number]),
		);
		const thinkingLevelMap = buildThinkingLevelMap(thinking);
		const contextParam = params.find((p) => p.id === "context");
		const defaultContext =
			defaultVariant({ variants })?.params.context ?? contextParam?.values[0] ?? undefined;
		const contexts = contextParam
			? [
					...(defaultContext ? [defaultContext] : []),
					...contextParam.values.filter((v) => v !== defaultContext),
				]
			: [undefined];

		for (const context of contexts) {
			const parsed = parseContextWindow(context);
			const id = context && context !== defaultContext ? `${baseId}@${context}` : baseId;
			const name =
				context && contexts.length > 1 ? `${displayName} (${titleContext(context)})` : displayName;
			const contextWindow = parsed ?? UNREPORTED_CONTEXT_WINDOW;
			out.push({
				id,
				name,
				api: API_ID,
				provider: PROVIDER_ID,
				baseUrl: BASE_URL,
				reasoning: thinking !== undefined,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: textOnly.has(baseId) ? ["text"] : ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow,
				maxTokens: Math.min(UNREPORTED_MAX_TOKENS, contextWindow),
				cursor: {
					baseId,
					params,
					variants,
					...(context ? { context } : {}),
					contextReported: parsed !== undefined,
					...(thinking ? { thinkingParam: thinking.id } : {}),
				},
			});
		}
	}
	return out;
}

function isCursorMeta(value: unknown): value is CursorModelMeta {
	if (!isRecord(value) || typeof value.baseId !== "string") return false;
	if (!Array.isArray(value.params) || !Array.isArray(value.variants)) return false;
	return typeof value.contextReported === "boolean";
}

/** Accepts only persisted models this extension wrote; anything else is discarded. */
export function restorePiModels(models: readonly unknown[]): CursorPiModel[] {
	return models.filter(
		(m): m is CursorPiModel =>
			isRecord(m) &&
			m.provider === PROVIDER_ID &&
			m.api === API_ID &&
			typeof m.id === "string" &&
			typeof m.contextWindow === "number" &&
			isCursorMeta(m.cursor),
	);
}

export function getCursorMeta(model: Model<Api>): CursorModelMeta | undefined {
	const meta = (model as Partial<CursorPiModel>).cursor;
	return isCursorMeta(meta) ? meta : undefined;
}

export interface SelectionRequest {
	thinkingValue?: string;
	fast?: boolean;
}

/**
 * Chooses the Cursor variant closest to the request. The pinned context always wins, then the
 * thinking value, then fast mode; ties prefer Cursor's default variant. When Cursor lists no
 * variants, only parameter values Cursor declared are sent.
 */
export function selectModel(meta: CursorModelMeta, request: SelectionRequest): ModelSelection {
	const desired: Record<string, string> = {};
	const has = (id: string) => meta.params.some((p) => p.id === id);
	if (meta.context) desired.context = meta.context;
	if (meta.thinkingParam && request.thinkingValue !== undefined) {
		desired[meta.thinkingParam] = request.thinkingValue;
	}
	if (request.fast !== undefined && has("fast")) desired.fast = request.fast ? "true" : "false";

	const weights: Record<string, number> = { context: 8, fast: 1 };
	if (meta.thinkingParam) weights[meta.thinkingParam] = 4;

	if (meta.variants.length === 0) {
		const params = Object.entries(desired)
			.filter(([id, value]) => meta.params.find((p) => p.id === id)?.values.includes(value))
			.map(([id, value]) => ({ id, value }));
		return params.length > 0 ? { id: meta.baseId, params } : { id: meta.baseId };
	}

	let best: CursorVariant | undefined;
	let bestScore = -1;
	for (const variant of meta.variants) {
		let score = 0;
		for (const [id, value] of Object.entries(desired)) {
			if (variant.params[id] === value) score += weights[id] ?? 1;
		}
		if (score > bestScore || (score === bestScore && variant.isDefault && !best?.isDefault)) {
			best = variant;
			bestScore = score;
		}
	}
	const params = Object.entries(best?.params ?? {}).map(([id, value]) => ({ id, value }));
	return params.length > 0 ? { id: meta.baseId, params } : { id: meta.baseId };
}
