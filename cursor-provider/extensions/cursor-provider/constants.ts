export const PROVIDER_ID = "cursor-agent";
export const PROVIDER_NAME = "Cursor (SDK agent)";
export const API_ID = "cursor-agent-sdk";
export const BASE_URL = "https://api.cursor.com";
export const API_KEY_ENV = "CURSOR_API_KEY";

/** Cursor does not report a context window for models without a `context` parameter. */
export const UNREPORTED_CONTEXT_WINDOW = 200_000;
/** Cursor does not report output limits; Pi requires a value. */
export const UNREPORTED_MAX_TOKENS = 64_000;

export const DEFAULT_MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const STALE_MODEL_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

export const MODE_ENTRY_TYPE = "cursor-agent-mode";
export const MCP_SERVER_NAME = "pi-tools";

export const SUPPORTED_IMAGE_MIME_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;
export const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Pi coding tools that duplicate Cursor's own local tools; never bridged unless explicitly included. */
export const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
