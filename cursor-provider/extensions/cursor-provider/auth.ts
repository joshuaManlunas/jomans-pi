import type { ProviderAuth } from "@earendil-works/pi-ai";
import { API_KEY_ENV } from "./constants.ts";
import { describeCursorError } from "./errors.ts";
import type { ModelCatalog } from "./models.ts";
import type { CursorSdk } from "./sdk.ts";
import { abortable } from "./util.ts";

export const API_KEYS_URL = "https://cursor.com/dashboard?tab=integrations";

/**
 * Api-key auth for Pi's `/login`. Pi owns persistence (its credential store, `auth.json`), so the
 * key never touches extension files. Login validates the key by listing models and stages that
 * list so Pi's post-login refresh publishes it without another request.
 */
export function createCursorAuth(deps: {
	loadSdk: () => Promise<CursorSdk>;
	catalog: ModelCatalog;
}): ProviderAuth {
	return {
		apiKey: {
			name: "Cursor API key",
			async login(interaction) {
				interaction.notify({
					type: "info",
					message: "Create a user API key in the Cursor dashboard under Integrations → API Keys.",
					links: [{ url: API_KEYS_URL, label: "Cursor dashboard" }],
				});
				const key = (
					await interaction.prompt({
						type: "secret",
						message: "Cursor API key",
						placeholder: "key_…",
					})
				).trim();
				if (key === "") throw new Error("No Cursor API key was entered.");
				interaction.notify({ type: "progress", message: "Validating the key with Cursor…" });
				let count: number;
				try {
					const sdk = await deps.loadSdk();
					const items = await abortable(sdk.listModels(key), interaction.signal);
					count = deps.catalog.prime(items);
				} catch (error) {
					if (interaction.signal.aborted) throw error;
					throw new Error(describeCursorError(error, { apiKey: key }));
				}
				if (count === 0) {
					throw new Error(
						"Cursor accepted the key but returned no usable models for this account.",
					);
				}
				interaction.notify({
					type: "info",
					message: `Key accepted. ${count} Cursor models available.`,
				});
				return { type: "api_key", key };
			},
			async check({ ctx, credential }) {
				if (credential?.key) return { type: "api_key", source: "/login" };
				if (await ctx.env(API_KEY_ENV)) return { type: "api_key", source: API_KEY_ENV };
				return undefined;
			},
			async resolve({ ctx, credential }) {
				const stored = credential?.key;
				const key = stored ?? (await ctx.env(API_KEY_ENV));
				if (!key) return undefined;
				return { auth: { apiKey: key }, source: stored ? "/login" : API_KEY_ENV };
			},
		},
	};
}
