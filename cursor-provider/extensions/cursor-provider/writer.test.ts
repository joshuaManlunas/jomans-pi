import { describe, expect, test } from "bun:test";
import {
	type Api,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Model,
} from "@earendil-works/pi-ai";
import { createMessageWriter } from "./writer.ts";

const MODEL = {
	id: "writer-model",
	name: "Writer Model",
	api: "cursor-agent-sdk",
	provider: "cursor-agent",
	baseUrl: "https://api.cursor.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4_000,
} as Model<Api>;

async function collect(
	stream: AsyncIterable<AssistantMessageEvent>,
): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

describe("createMessageWriter", () => {
	test("orders start, balanced blocks and tool calls before one terminal done", async () => {
		const stream = createAssistantMessageEventStream();
		const eventsPromise = collect(stream);
		const writer = createMessageWriter(stream, MODEL, () => 123);
		writer.text("answer");
		writer.thinking("reasoning");
		writer.toolCall({ id: "tool-1", name: "weather", arguments: { city: "Tokyo" } });
		writer.setUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 });
		writer.finish("stop", "cursor-agent:agent-1:run-1");
		writer.fail("error", "ignored");

		const events = await eventsPromise;
		const types = events.map((event) => event.type);
		expect(types[0]).toBe("start");
		expect(types.at(-1)).toBe("done");
		expect(types.indexOf("toolcall_start")).toBeGreaterThan(types.indexOf("thinking_end"));
		expect(types.indexOf("done")).toBeGreaterThan(types.indexOf("toolcall_end"));
		expect(types.filter((type) => type === "text_start")).toHaveLength(1);
		expect(types.filter((type) => type === "text_end")).toHaveLength(1);
		expect(types.filter((type) => type === "thinking_start")).toHaveLength(1);
		expect(types.filter((type) => type === "thinking_end")).toHaveLength(1);
		expect(types.filter((type) => type === "toolcall_start")).toHaveLength(1);
		expect(types.filter((type) => type === "toolcall_delta")).toHaveLength(1);
		expect(types.filter((type) => type === "toolcall_end")).toHaveLength(1);
		expect(types.filter((type) => type === "done" || type === "error")).toHaveLength(1);
		expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({
			toolCall: { id: "tool-1", name: "weather", arguments: { city: "Tokyo" } },
		});
		const message = await stream.result();
		expect(message.responseId).toBe("cursor-agent:agent-1:run-1");
		expect(message.usage).toMatchObject({
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
		});
	});

	test("emits exactly one error terminal and ignores later finish calls", async () => {
		const stream = createAssistantMessageEventStream();
		const eventsPromise = collect(stream);
		const writer = createMessageWriter(stream, MODEL);
		writer.text("partial");
		writer.fail("aborted", "cancelled", "cursor-agent:agent-2:run-2");
		writer.finish("stop");

		const events = await eventsPromise;
		expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(
			1,
		);
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
		expect(await stream.result()).toMatchObject({
			stopReason: "aborted",
			errorMessage: "cancelled",
			responseId: "cursor-agent:agent-2:run-2",
		});
	});
});
