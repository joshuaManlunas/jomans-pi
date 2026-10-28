import { describe, expect, test } from "bun:test";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import { API_ID, PROVIDER_ID } from "./constants.ts";
import {
	formatResponseId,
	parseResponseId,
	planTurn,
	renderHistory,
	trailingToolResults,
} from "./transcript.ts";

function userMessage(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 1 };
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Answer" }],
		api: API_ID,
		provider: PROVIDER_ID,
		model: "composer-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
		...overrides,
	};
}

function toolResult(text: string, id = "call-1"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

function linkedAssistant(): AssistantMessage {
	return assistantMessage({ responseId: formatResponseId("agent-1", "run-1") });
}

describe("response ids", () => {
	test("formats and parses a Cursor agent/run link", () => {
		const responseId = formatResponseId("agent-1", "run-1");
		expect(responseId).toBe("cursor-agent:agent-1:run-1");
		expect(parseResponseId(responseId)).toEqual({ agentId: "agent-1", runId: "run-1" });
	});

	test("rejects missing, foreign, and malformed response ids", () => {
		for (const responseId of [
			undefined,
			"other:agent:run",
			"cursor-agent::run",
			"cursor-agent:agent:",
			"cursor-agent:a:b:c",
		]) {
			expect(parseResponseId(responseId)).toBeUndefined();
		}
	});
});

describe("renderHistory", () => {
	test("renders history deterministically and truncates large tool arguments/results", () => {
		const call: ToolCall = {
			type: "toolCall",
			id: "call-1",
			name: "read",
			arguments: { payload: "x".repeat(2_100) },
		};
		const history: Message[] = [
			userMessage("Read this file"),
			assistantMessage({
				content: [{ type: "text", text: "I will read it." }, call],
			}),
			toolResult("y".repeat(4_050)),
		];

		const rendered = renderHistory(history);

		expect(renderHistory(history)).toBe(rendered);
		expect(rendered).toContain("User:\nRead this file");
		expect(rendered).toContain("Assistant:\nI will read it.");
		expect(rendered).toContain("Called tool `read` with");
		expect(rendered).toContain("Tool result (read, ok):");
		expect(rendered).toContain("more chars]");
		expect(rendered).not.toContain("y".repeat(4_050));
		expect(rendered).not.toContain("x".repeat(2_100));
	});

	test("represents images as placeholders in history text", () => {
		const image: ImageContent = { type: "image", data: "base64-data", mimeType: "image/png" };
		const text: TextContent = { type: "text", text: "A screenshot" };
		expect(renderHistory([userMessage([text, image])])).toBe(
			"User:\nA screenshot\n[image: image/png]",
		);
	});
});

describe("planTurn", () => {
	test("continues a known Cursor agent for new user input", () => {
		const result = planTurn(
			[userMessage("Earlier"), linkedAssistant(), userMessage("Continue with this")],
			{ agentId: "agent-1", lastRunId: "run-1" },
		);

		expect(result).toEqual({
			kind: "continue",
			agentId: "agent-1",
			runId: "run-1",
			request: { text: "Continue with this", images: [] },
		});
	});

	test("resumes a linked agent and carries a fresh-request fallback", () => {
		const result = planTurn(
			[userMessage("Earlier"), linkedAssistant(), userMessage("Next turn")],
			undefined,
		);

		expect(result.kind).toBe("resume");
		if (result.kind !== "resume") throw new Error("Expected a resume plan");
		expect(result.agentId).toBe("agent-1");
		expect(result.runId).toBe("run-1");
		expect(result.request).toEqual({ text: "Next turn", images: [] });
		expect(result.fallback.text).toContain("<conversation_history>");
		expect(result.fallback.text).toContain("Current request:\nNext turn");
	});

	test("preserves images from pending user input when continuing", () => {
		const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
		const result = planTurn(
			[linkedAssistant(), userMessage([{ type: "text", text: "Describe it" }, image])],
			{ agentId: "agent-1", lastRunId: "run-1" },
		);

		expect(result.kind).toBe("continue");
		if (result.kind !== "continue") throw new Error("Expected a continue plan");
		expect(result.request).toEqual({ text: "Describe it\n[image: image/png]", images: [image] });
	});

	test("chooses a fresh agent for unlinked, foreign, interrupted, or empty turns", () => {
		const linked = linkedAssistant();
		const known = { agentId: "agent-1", lastRunId: "run-1" };
		const cases: Message[][] = [
			[userMessage("First turn")],
			[
				assistantMessage({
					provider: "other-provider",
					responseId: formatResponseId("agent-1", "run-1"),
				}),
				userMessage("Next"),
			],
			[
				assistantMessage({
					responseId: formatResponseId("agent-1", "run-1"),
					stopReason: "toolUse",
				}),
				userMessage("Next"),
			],
			[assistantMessage({ responseId: "cursor-agent:malformed" }), userMessage("Next")],
			[linked],
			[linked, userMessage("Next"), toolResult("A tool ran")],
		];

		for (const messages of cases) {
			expect(planTurn(messages, known).kind).toBe("fresh");
		}
	});
});

describe("trailingToolResults", () => {
	test("returns only tool results after the newest assistant message", () => {
		const before = toolResult("old result", "old-call");
		const after = toolResult("new result", "new-call");
		const messages: Message[] = [
			assistantMessage({ responseId: formatResponseId("agent-1", "run-1") }),
			before,
			userMessage("Another turn"),
			assistantMessage({ responseId: formatResponseId("agent-1", "run-2") }),
			after,
		];

		expect(trailingToolResults(messages)).toEqual([after]);
	});
});
