import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { polishPrompt } from "./index.ts";

type Response = {
	stopReason: string;
	content: unknown;
	errorMessage?: string;
};
type RequestContext = {
	systemPrompt: string;
	messages: unknown[];
	tools: unknown[];
};
type CapturedCall = { context: RequestContext; options: unknown };
type Completion =
	| Response
	| Promise<Response>
	| ((calls: CapturedCall[]) => Response | Promise<Response>);

const model = { provider: "fake-provider", id: "fake-model" };
const text = (value: string) => ({ type: "text", text: value });
const toolCall = (argumentsValue: unknown) => ({
	type: "toolCall",
	id: "call-1",
	name: "secret-tool",
	arguments: argumentsValue,
});
const response = (
	stopReason: string,
	content: unknown,
	errorMessage?: string,
): Response => ({ stopReason, content, errorMessage });
const cursorModel = { provider: "cursor", id: "cursor-test-model" };

function cursorBoundaries(systemPrompt: string) {
	const match =
		/Opening boundary: (<prompt-polish-output-[a-f0-9]+>)\n- Closing boundary: (<\/prompt-polish-output-[a-f0-9]+>)/.exec(
			systemPrompt,
		);
	if (!match?.[1] || !match[2]) throw new Error("missing cursor boundaries");
	return { open: match[1], close: match[2] };
}

function harness(
	responses: Completion[],
	signal?: AbortSignal,
	selectedModel = model,
) {
	const calls: CapturedCall[] = [];
	const runtime = {
		complete: (_model: unknown, context: unknown, options: unknown) => {
			calls.push({ context: context as RequestContext, options });
			const next = responses.shift();
			if (next === undefined) throw new Error("missing fake response");
			return typeof next === "function" ? next(calls) : next;
		},
	};
	return {
		calls,
		ctx: {
			model: selectedModel,
			modelRegistry: { runtime },
			signal,
		} as unknown as Pick<
			ExtensionContext,
			"model" | "modelRegistry" | "signal"
		>,
	};
}

function diagnostics() {
	const entries: unknown[] = [];
	return { entries, logger: (entry: unknown) => entries.push(entry) };
}

test("returns trimmed stop text and explicitly disables tools", async () => {
	const h = harness([
		response("stop", [text("  improved "), text("prompt  ")]),
	]);

	expect(await polishPrompt("original", h.ctx)).toBe("improved \nprompt");
	expect(h.calls).toHaveLength(1);
	expect(h.calls[0].context.tools).toEqual([]);
});

test("returns useful text from toolUse without retrying", async () => {
	const d = diagnostics();
	const h = harness([
		response("toolUse", [
			text("  useful prompt  "),
			toolCall({ secret: "tool-args" }),
		]),
	]);

	expect(await polishPrompt("original", h.ctx, { logger: d.logger })).toBe(
		"useful prompt",
	);
	expect(h.calls).toHaveLength(1);
	expect(d.entries).toHaveLength(1);
});

test("retries a toolUse without text and accepts stop text", async () => {
	const d = diagnostics();
	const h = harness([
		response("toolUse", [toolCall({ query: "secret" })]),
		response("stop", [text("  fallback prompt  ")]),
	]);

	expect(await polishPrompt("original", h.ctx, { logger: d.logger })).toBe(
		"fallback prompt",
	);
	expect(h.calls).toHaveLength(2);
	expect(d.entries).toHaveLength(1);
	expect(
		h.calls.every(
			(call) =>
				Array.isArray(call.context.tools) && call.context.tools.length === 0,
		),
	).toBe(true);
	expect(h.calls[1].context.systemPrompt).toContain("no tools are available");
});

test("reports malformed tool responses after retry without leaking details", async () => {
	const d = diagnostics();
	const malformed = response("toolUse", [
		{
			type: "toolCall",
			id: "secret-id",
			name: "secret-tool",
			arguments: "secret-arguments",
		},
	]);
	const h = harness([malformed, malformed]);

	await expect(
		polishPrompt("secret-original", h.ctx, { logger: d.logger }),
	).rejects.toThrow("malformed or incomplete tool response");
	expect(d.entries).toHaveLength(2);
	expect(JSON.stringify(d.entries)).not.toContain("secret-original");
	expect(JSON.stringify(d.entries)).not.toContain("secret-arguments");
});

test("reports valid but unsupported tool requests after retry", async () => {
	const d = diagnostics();
	const call = toolCall({ secret: "secret-arguments" });
	const h = harness([response("toolUse", [call]), response("toolUse", [call])]);

	await expect(
		polishPrompt("original", h.ctx, { logger: d.logger }),
	).rejects.toThrow("requested unavailable tools");
	expect(h.calls).toHaveLength(2);
	expect(d.entries).toHaveLength(2);
	expect(
		d.entries.map((entry) => (entry as { attempt: number }).attempt),
	).toEqual([1, 2]);
});

test("converts a retry that ignores abort into a controlled timeout", async () => {
	const never = new Promise<Response>(() => {});
	const d = diagnostics();
	const h = harness([response("toolUse", []), never]);

	await expect(
		polishPrompt("secret-original", h.ctx, { timeoutMs: 5, logger: d.logger }),
	).rejects.toThrow("timed out");
	expect(h.calls).toHaveLength(2);
	expect(JSON.stringify(d.entries)).not.toContain("secret-original");
});

test("handles provider rejection, provider error, and aborted response safely", async () => {
	const cases: Array<{ completion: Completion; message: string }> = [
		{
			completion: Promise.reject(new Error("secret-provider-error")),
			message: "request failed",
		},
		{
			completion: response("error", [], "secret-provider-error"),
			message: "request failed",
		},
		{
			completion: response("aborted", [], "secret-provider-error"),
			message: "cancelled",
		},
	];

	for (const item of cases) {
		const d = diagnostics();
		const h = harness([item.completion]);
		await expect(
			polishPrompt("secret-original", h.ctx, { logger: d.logger }),
		).rejects.toThrow(item.message);
		expect(JSON.stringify(d.entries)).not.toContain("secret-original");
		expect(JSON.stringify(d.entries)).not.toContain("secret-provider-error");
	}
});

test("outer cancellation rejects even when the provider ignores abort", async () => {
	const controller = new AbortController();
	const never = new Promise<Response>(() => {});
	const h = harness([never], controller.signal);
	const pending = polishPrompt("original", h.ctx, {
		timeoutMs: 500,
		logger: () => {},
	});

	controller.abort();
	await expect(pending).rejects.toThrow("cancelled");
});

test("keeps incomplete and malformed non-tool completions controlled", async () => {
	const cases = [
		{ completion: response("stop", []), message: "no usable text" },
		{ completion: response("stop", undefined), message: "malformed content" },
		{ completion: response("length", []), message: "truncated" },
		{ completion: response("pending", []), message: "did not complete" },
		{ completion: response("deferred", []), message: "did not complete" },
		{ completion: response("mystery", []), message: "request failed" },
	];

	for (const item of cases) {
		const h = harness([item.completion]);
		await expect(
			polishPrompt("original", h.ctx, { logger: () => {} }),
		).rejects.toThrow(item.message);
	}
});

test("diagnostics contain only safe metadata", async () => {
	const d = diagnostics();
	const h = harness([
		response("toolUse", [
			text("safe"),
			toolCall({ secret: "secret-tool-args" }),
		]),
	]);

	await polishPrompt("secret-original-prompt", h.ctx, { logger: d.logger });
	const entry = d.entries[0] as Record<string, unknown>;
	expect(Object.keys(entry).sort()).toEqual([
		"attempt",
		"contentCount",
		"event",
		"model",
		"provider",
		"stopReason",
		"textCount",
		"toolCallCount",
	]);
	expect(JSON.stringify(d.entries)).not.toContain("secret-original-prompt");
	expect(JSON.stringify(d.entries)).not.toContain("secret-tool-args");
});

test("Cursor strips screenshot-style reasoning outside the bounded prompt", async () => {
	const h = harness(
		[
			(calls) => {
				const { open, close } = cursorBoundaries(calls[0].context.systemPrompt);
				return response("stop", [
					text(
						[
							"I inspected the screenshot and reasoned about the layout:",
							"┌────────────────────┐",
							"│ secret trace       │",
							"└────────────────────┘",
							`${open}bounded prompt${close}`,
							"post-boundary reasoning",
						].join("\n"),
					),
				]);
			},
		],
		undefined,
		cursorModel,
	);

	expect(await polishPrompt("original", h.ctx)).toBe("bounded prompt");
});

test("Cursor ignores structured thinking and returns bounded final text", async () => {
	const h = harness(
		[
			(calls) => {
				const { open, close } = cursorBoundaries(calls[0].context.systemPrompt);
				return response("stop", [
					{ type: "thinking", thinking: "secret trace" },
					text(`${open}final prompt${close}`),
				]);
			},
		],
		undefined,
		cursorModel,
	);

	expect(await polishPrompt("original", h.ctx)).toBe("final prompt");
});

test("Cursor retries unbounded text with the same boundary and no tools", async () => {
	const h = harness(
		[
			() => response("stop", [text("unbounded first response")]),
			(calls) => {
				const first = cursorBoundaries(calls[0].context.systemPrompt);
				const second = cursorBoundaries(calls[1].context.systemPrompt);
				expect(second).toEqual(first);
				return response("stop", [
					text(`${second.open}bounded retry${second.close}`),
				]);
			},
		],
		undefined,
		cursorModel,
	);

	expect(await polishPrompt("original", h.ctx)).toBe("bounded retry");
	expect(h.calls).toHaveLength(2);
	expect(h.calls.map((call) => call.context.tools)).toEqual([[], []]);
});

test("Cursor rejects two unbounded responses without exposing traces", async () => {
	const d = diagnostics();
	const h = harness(
		[
			response("stop", [text("secret first trace")]),
			response("stop", [text("secret retry trace")]),
		],
		undefined,
		cursorModel,
	);
	let error: unknown;
	try {
		await polishPrompt("secret-original", h.ctx, { logger: d.logger });
	} catch (caught) {
		error = caught;
	}

	expect(error).toBeInstanceOf(Error);
	expect(String(error)).toContain("malformed content");
	expect(String(error)).not.toContain("secret first trace");
	expect(String(error)).not.toContain("secret retry trace");
	expect(JSON.stringify(d.entries)).not.toContain("secret first trace");
	expect(JSON.stringify(d.entries)).not.toContain("secret retry trace");
	expect(h.calls).toHaveLength(2);
});

test("Cursor rejects duplicate output boundaries", async () => {
	const duplicate = (calls: CapturedCall[]) => {
		const { open, close } = cursorBoundaries(calls[0].context.systemPrompt);
		return response("stop", [
			text(`${open}first${open}nested${close}${close}`),
		]);
	};
	const h = harness([duplicate, duplicate], undefined, cursorModel);

	await expect(polishPrompt("original", h.ctx)).rejects.toThrow(
		"malformed content",
	);
});

test("Cursor rejects malformed toolUse with bounded text", async () => {
	const h = harness(
		[
			(calls) => {
				const { open, close } = cursorBoundaries(calls[0].context.systemPrompt);
				return response("toolUse", [
					text(`${open}bounded prompt${close}`),
					toolCall("malformed-arguments"),
				]);
			},
		],
		undefined,
		cursorModel,
	);

	await expect(polishPrompt("original", h.ctx)).rejects.toThrow(
		"malformed or incomplete tool response",
	);
});

test("Cursor keeps malformed thinking responses controlled", async () => {
	const h = harness(
		[
			(calls) => {
				const { open, close } = cursorBoundaries(calls[0].context.systemPrompt);
				return response("stop", [
					{
						type: "thinking",
						thinking: "secret trace",
						thinkingSignature: 42,
					},
					text(`${open}valid final${close}`),
				]);
			},
		],
		undefined,
		cursorModel,
	);

	await expect(polishPrompt("original", h.ctx)).rejects.toThrow(
		"malformed content",
	);
});
