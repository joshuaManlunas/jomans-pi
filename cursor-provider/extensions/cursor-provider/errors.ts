import { API_KEY_ENV, PROVIDER_ID } from "./constants.ts";

export class CursorProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CursorProviderError";
	}
}

export const MISSING_AUTH_MESSAGE =
	`No Cursor API key is configured. Run /login ${PROVIDER_ID} and paste a key from ` +
	`https://cursor.com/dashboard (Integrations → API Keys), or set ${API_KEY_ENV}.`;

interface ErrorLike {
	name?: unknown;
	message?: unknown;
	status?: unknown;
	code?: unknown;
}

function fields(error: unknown): { name: string; message: string; status?: number; code?: string } {
	const e = (typeof error === "object" && error !== null ? error : {}) as ErrorLike;
	return {
		name: typeof e.name === "string" ? e.name : "",
		message:
			typeof e.message === "string" ? e.message : typeof error === "string" ? error : String(error),
		status: typeof e.status === "number" ? e.status : undefined,
		code: typeof e.code === "string" ? e.code : undefined,
	};
}

/** Removes anything shaped like a Cursor key before a message reaches the UI or session file. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
	let out = text;
	for (const secret of secrets) {
		if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
	}
	return out.replace(/\b(key|crsr)_[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
}

/**
 * Converts SDK/transport failures into actionable messages. Classification uses the SDK's
 * exported error class names and HTTP status, which are stable public fields in @cursor/sdk 1.0.x.
 */
export function describeCursorError(
	error: unknown,
	context: { modelId?: string; runtime?: string; apiKey?: string } = {},
): string {
	if (error instanceof CursorProviderError) return redactSecrets(error.message, [context.apiKey]);
	const { name, message, status, code } = fields(error);
	const where = context.runtime === "cloud" ? "Cursor Cloud agent" : "local Cursor agent";
	let text: string;
	if (name === "SdkUnavailableError") text = message;
	else if (name === "AuthenticationError" || status === 401 || status === 403) {
		text = `Cursor rejected the API key (${status ?? "auth error"}). Run /login ${PROVIDER_ID} with a valid key, or check ${API_KEY_ENV}.`;
	} else if (name === "RateLimitError" || status === 429) {
		text = `Cursor rate limit reached. Wait and retry. (${message})`;
	} else if (
		/model/i.test(message) &&
		(name === "ConfigurationError" || status === 400 || status === 404)
	) {
		text =
			`Cursor does not accept model "${context.modelId ?? "unknown"}": ${message}. ` +
			`Run /cursor-agent models refresh to update the model list.`;
	} else if (name === "NetworkError") {
		text = `Could not reach Cursor: ${message}. Check your network connection.`;
	} else if (name === "AgentBusyError") {
		text = `The ${where} is still busy with a previous run. Wait for it to finish or abort it, then retry.`;
	} else if (name === "IntegrationNotConnectedError") {
		text = `Cursor Cloud needs a connected GitHub integration: ${message}`;
	} else {
		text = `The ${where} failed: ${message}${code && code !== "error" ? ` (code ${code})` : ""}`;
	}
	return redactSecrets(text, [context.apiKey]);
}
