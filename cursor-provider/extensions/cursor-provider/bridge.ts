import type { JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import type { McpBridgeSettings } from "./config.ts";
import { PI_BUILTIN_TOOLS } from "./constants.ts";
import type { SDKCustomTool, SDKCustomToolResult } from "./sdk.ts";
import { isRecord } from "./util.ts";

export interface BridgeToolInfo {
	name: string;
	description: string;
	parameters: unknown;
}

export interface BridgeCall {
	/** Pi tool-call id; Pi echoes it back on the tool result. */
	id: string;
	/** Pi tool name, not the sanitized Cursor-facing name. */
	toolName: string;
	args: JsonObject;
}

export interface Bridge {
	customTools: Record<string, SDKCustomTool>;
	/** Resolves waiting Cursor calls with Pi tool results; returns how many matched. */
	resolve(results: readonly ToolResultMessage[]): number;
	pendingCount(): number;
	cancelAll(reason: string): void;
}

/**
 * Chooses which Pi tools Cursor may call: only tools active in this Pi session, never Pi's
 * built-in coding tools (Cursor has its own) unless listed in `include`, never `exclude`d ones.
 */
export function selectBridgeTools(
	all: readonly BridgeToolInfo[],
	active: readonly string[],
	settings: Pick<McpBridgeSettings, "include" | "exclude">,
): BridgeToolInfo[] {
	const activeSet = new Set(active);
	const include = settings.include ? new Set(settings.include) : undefined;
	const exclude = new Set(settings.exclude);
	const builtins = new Set<string>(PI_BUILTIN_TOOLS);
	return all.filter((tool) => {
		if (!activeSet.has(tool.name) || exclude.has(tool.name)) return false;
		if (include) return include.has(tool.name);
		return !builtins.has(tool.name);
	});
}

export function cursorToolName(name: string, taken: ReadonlySet<string>): string {
	const base = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "tool";
	let candidate = base;
	for (let i = 2; taken.has(candidate); i++) candidate = `${base.slice(0, 56)}_${i}`;
	return candidate;
}

function jsonSchema(parameters: unknown): Record<string, never> | Record<string, unknown> {
	try {
		const copy: unknown = JSON.parse(JSON.stringify(parameters ?? {}));
		return isRecord(copy) ? copy : { type: "object" };
	} catch {
		return { type: "object" };
	}
}

/** Converts a Pi tool result into MCP tool content, preserving images and the error flag. */
export function toCustomToolResult(result: ToolResultMessage): SDKCustomToolResult {
	const content = result.content.map((part) =>
		part.type === "text"
			? { type: "text" as const, text: part.text }
			: { type: "image" as const, data: part.data, mimeType: part.mimeType },
	);
	return {
		content: content.length > 0 ? content : [{ type: "text", text: "(no output)" }],
		isError: result.isError,
	};
}

function errorResult(text: string): SDKCustomToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

/**
 * Builds in-process SDK custom tools for one Cursor run. Each call is handed to Pi through
 * `onCall` and stays pending until Pi returns a matching tool result, the per-call timeout
 * expires, or the run is cancelled. Nothing listens on a network interface.
 */
export function createBridge(options: {
	tools: readonly BridgeToolInfo[];
	timeoutMs: number;
	onCall: (call: BridgeCall) => void;
	newId: () => string;
}): Bridge {
	const pending = new Map<string, { settle: (result: SDKCustomToolResult) => void }>();
	const customTools: Record<string, SDKCustomTool> = {};
	const taken = new Set<string>();

	for (const tool of options.tools) {
		const cursorName = cursorToolName(tool.name, taken);
		taken.add(cursorName);
		customTools[cursorName] = {
			description: tool.description,
			inputSchema: jsonSchema(tool.parameters) as SDKCustomTool["inputSchema"],
			execute: (args) =>
				new Promise<SDKCustomToolResult>((resolve) => {
					const id = options.newId();
					const timer = setTimeout(() => {
						pending.delete(id);
						resolve(
							errorResult(
								`Pi did not return a result for ${tool.name} within ${Math.round(options.timeoutMs / 1000)}s.`,
							),
						);
					}, options.timeoutMs);
					pending.set(id, {
						settle: (result) => {
							clearTimeout(timer);
							pending.delete(id);
							resolve(result);
						},
					});
					options.onCall({
						id,
						toolName: tool.name,
						args: (isRecord(args) ? args : {}) as JsonObject,
					});
				}),
		};
	}

	return {
		customTools,
		resolve(results) {
			let matched = 0;
			for (const result of results) {
				const entry = pending.get(result.toolCallId);
				if (!entry) continue;
				entry.settle(toCustomToolResult(result));
				matched += 1;
			}
			return matched;
		},
		pendingCount: () => pending.size,
		cancelAll(reason) {
			for (const entry of [...pending.values()]) entry.settle(errorResult(reason));
		},
	};
}
