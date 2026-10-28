import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { type CursorPiModel, restorePiModels, toPiModels } from "./catalog.ts";
import { API_KEY_ENV, STALE_MODEL_CACHE_MS } from "./constants.ts";
import { describeCursorError } from "./errors.ts";
import type { CursorSdk, ModelListItem } from "./sdk.ts";
import { abortable } from "./util.ts";

export type CatalogSource = "none" | "cache" | "network" | "login";

export interface CatalogStatus {
	source: CatalogSource;
	count: number;
	checkedAt?: number;
	/** The newest list is older than the stale threshold (typically because refreshes failed). */
	stale: boolean;
	lastError?: string;
}

export interface CatalogDeps {
	loadSdk: () => Promise<CursorSdk>;
	ttlMs: () => number;
	textOnlyModels: () => readonly string[];
	env?: (name: string) => string | undefined;
	now?: () => number;
}

export interface ModelCatalog {
	getModels(): readonly CursorPiModel[];
	status(): CatalogStatus;
	/** Stage a list fetched during login; the next refresh publishes and persists it. */
	prime(items: readonly ModelListItem[]): number;
	refresh(context: RefreshModelsContext): Promise<void>;
}

/**
 * Provider-owned Cursor model catalog. Pi persists snapshots in its models store, so startup
 * restores the last list without network access. A network fetch happens only when the snapshot
 * is older than the TTL, when forced (`/cursor-agent models refresh`), or right after login. A failed
 * fetch keeps the previous list; no model is ever fabricated.
 */
export function createModelCatalog(deps: CatalogDeps): ModelCatalog {
	const now = deps.now ?? Date.now;
	const env = deps.env ?? ((name: string) => process.env[name]);
	let models: CursorPiModel[] = [];
	let source: CatalogSource = "none";
	let checkedAt: number | undefined;
	let lastError: string | undefined;
	let pending: { models: CursorPiModel[]; checkedAt: number } | undefined;

	const install = (next: CursorPiModel[], nextSource: CatalogSource, at: number | undefined) => {
		models = next;
		source = nextSource;
		checkedAt = at;
	};

	return {
		getModels: () => models,
		status: () => ({
			source,
			count: models.length,
			...(checkedAt !== undefined ? { checkedAt } : {}),
			stale: checkedAt !== undefined && now() - checkedAt > STALE_MODEL_CACHE_MS,
			...(lastError ? { lastError } : {}),
		}),
		prime(items) {
			const next = toPiModels(items, { textOnlyModels: deps.textOnlyModels() });
			if (next.length > 0) pending = { models: next, checkedAt: now() };
			return next.length;
		},
		async refresh(context) {
			const stored = context.stored;
			if (stored && source === "none") {
				const restored = restorePiModels(stored.models);
				if (restored.length > 0) {
					await context.publish({
						update: () => install(restored, "cache", stored.checkedAt),
					});
				}
			}

			if (pending) {
				const staged = pending;
				pending = undefined;
				await context.publish({
					persist: { models: staged.models, checkedAt: staged.checkedAt },
					update: () => {
						install(staged.models, "login", staged.checkedAt);
						lastError = undefined;
					},
				});
				return;
			}

			if (!context.allowNetwork || context.signal.aborted) return;
			const credential = context.credential;
			const apiKey =
				(credential?.type === "api_key" ? credential.key : undefined) ?? env(API_KEY_ENV);
			if (!apiKey) return;
			const lastChecked = stored?.checkedAt ?? checkedAt;
			if (!context.force && lastChecked !== undefined && now() - lastChecked < deps.ttlMs()) {
				return;
			}

			try {
				const sdk = await deps.loadSdk();
				const items = await abortable(sdk.listModels(apiKey), context.signal);
				const next = toPiModels(items, { textOnlyModels: deps.textOnlyModels() });
				if (next.length === 0) {
					throw new Error("Cursor returned no usable models; keeping the previous model list.");
				}
				const at = now();
				await context.publish({
					persist: { models: next, checkedAt: at },
					update: () => {
						install(next, "network", at);
						lastError = undefined;
					},
				});
			} catch (error) {
				if (context.signal.aborted) return;
				lastError = describeCursorError(error, { apiKey });
				throw new Error(lastError);
			}
		},
	};
}
