import { describe, expect, test } from "bun:test";
import type { ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import { type BridgeCall, type BridgeToolInfo, createBridge, selectBridgeTools } from "./bridge.ts";

const WEATHER_TOOL: BridgeToolInfo = {
	name: "weather",
	description: "Weather lookup",
	parameters: { type: "object" },
};
const TOOLS: BridgeToolInfo[] = [
	{ name: "read", description: "Pi read", parameters: { type: "object" } },
	{ name: "bash", description: "Pi shell", parameters: { type: "object" } },
	WEATHER_TOOL,
	{ name: "inactive", description: "Inactive tool", parameters: { type: "object" } },
];

describe("selectBridgeTools", () => {
	test("excludes Pi builtins by default and hides inactive tools", () => {
		expect(
			selectBridgeTools(TOOLS, ["read", "bash", "weather"], { exclude: [] }).map((t) => t.name),
		).toEqual(["weather"]);
	});

	test("include can opt in builtins, but exclude wins and inactive tools remain hidden", () => {
		expect(
			selectBridgeTools(TOOLS, ["read", "bash", "weather"], {
				include: ["read", "bash", "weather", "inactive"],
				exclude: ["bash"],
			}).map((t) => t.name),
		).toEqual(["read", "weather"]);
	});
});

function makeBridge(timeoutMs = 100): {
	bridge: ReturnType<typeof createBridge>;
	calls: BridgeCall[];
} {
	const calls: BridgeCall[] = [];
	let id = 0;
	return {
		calls,
		bridge: createBridge({
			tools: [WEATHER_TOOL],
			timeoutMs,
			onCall: (call) => calls.push(call),
			newId: () => `pi-call-${++id}`,
		}),
	};
}

function weatherTool(bridge: ReturnType<typeof createBridge>) {
	const tool = bridge.customTools.weather;
	if (!tool) throw new Error("Expected the weather bridge tool");
	return tool;
}

function toolResult(
	call: BridgeCall,
	content: ToolResultMessage["content"],
	isError = false,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.toolName,
		content,
		isError,
		timestamp: 1,
	};
}

describe("createBridge", () => {
	test("resolves only by Pi toolCallId and preserves images and isError", async () => {
		const { bridge, calls } = makeBridge();
		const execute = weatherTool(bridge).execute;
		const pending = execute({ city: "Tokyo" }, {});
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (!call) throw new Error("Expected the bridge to emit its Pi call");
		expect(call).toMatchObject({ id: "pi-call-1", toolName: "weather", args: { city: "Tokyo" } });

		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		const content: ToolResultMessage["content"] = [{ type: "text", text: "blocked" }, image];
		expect(
			bridge.resolve([
				toolResult({ ...call, id: "other-call" }, content),
				toolResult(call, content, true),
			]),
		).toBe(1);
		expect(await pending).toEqual({
			content: [
				{ type: "text", text: "blocked" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
			isError: true,
		});
		expect(bridge.pendingCount()).toBe(0);
	});

	test("returns an MCP error result when a Pi result times out", async () => {
		const { bridge } = makeBridge(5);
		const pending = weatherTool(bridge).execute({ city: "Oslo" }, {});
		await expect(pending).resolves.toMatchObject({
			isError: true,
			content: [{ type: "text", text: expect.stringContaining("within 0s") }],
		});
		expect(bridge.pendingCount()).toBe(0);
	});

	test("cancelAll rejects every pending tool call as an error result", async () => {
		const { bridge } = makeBridge();
		const tool = weatherTool(bridge);
		const pending = [tool.execute({ city: "Oslo" }, {}), tool.execute({ city: "Lima" }, {})];
		expect(bridge.pendingCount()).toBe(2);
		bridge.cancelAll("run cancelled");
		await expect(Promise.all(pending)).resolves.toEqual([
			{ content: [{ type: "text", text: "run cancelled" }], isError: true },
			{ content: [{ type: "text", text: "run cancelled" }], isError: true },
		]);
		expect(bridge.pendingCount()).toBe(0);
	});
});
