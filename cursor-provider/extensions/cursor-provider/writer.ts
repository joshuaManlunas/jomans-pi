import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	type JsonObject,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export interface MessageWriter {
	readonly message: AssistantMessage;
	hasText(): boolean;
	text(delta: string): void;
	thinking(delta: string): void;
	closeBlock(): void;
	toolCall(call: { id: string; name: string; arguments: JsonObject }): void;
	setUsage(usage: Omit<Usage, "cost">): void;
	/** Ends the stream successfully. Later calls are ignored. */
	finish(reason: "stop" | "length" | "toolUse", responseId?: string): void;
	/** Ends the stream with an error. Later calls are ignored. */
	fail(reason: "error" | "aborted", message: string, responseId?: string): void;
	isEnded(): boolean;
}

/**
 * Emits a well-formed Pi assistant event sequence: `start`, balanced block events, then exactly
 * one terminal `done` or `error`.
 */
export function createMessageWriter(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	now: () => number = Date.now,
): MessageWriter {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: now(),
	};
	let open: { kind: "text" | "thinking"; index: number } | undefined;
	let ended = false;
	let wroteText = false;

	stream.push({ type: "start", partial: message });

	const closeBlock = () => {
		if (!open) return;
		const block = message.content[open.index];
		if (open.kind === "text" && block?.type === "text") {
			stream.push({
				type: "text_end",
				contentIndex: open.index,
				content: block.text,
				partial: message,
			});
		} else if (open.kind === "thinking" && block?.type === "thinking") {
			stream.push({
				type: "thinking_end",
				contentIndex: open.index,
				content: block.thinking,
				partial: message,
			});
		}
		open = undefined;
	};

	const append = (kind: "text" | "thinking", delta: string) => {
		if (ended || delta === "") return;
		if (open?.kind !== kind) {
			closeBlock();
			const index = message.content.length;
			message.content.push(
				kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" },
			);
			open = { kind, index };
			stream.push({
				type: kind === "text" ? "text_start" : "thinking_start",
				contentIndex: index,
				partial: message,
			});
		}
		const block = message.content[open.index];
		if (block?.type === "text") block.text += delta;
		else if (block?.type === "thinking") block.thinking += delta;
		stream.push({
			type: kind === "text" ? "text_delta" : "thinking_delta",
			contentIndex: open.index,
			delta,
			partial: message,
		});
		if (kind === "text") wroteText = true;
	};

	return {
		message,
		hasText: () => wroteText,
		text: (delta) => append("text", delta),
		thinking: (delta) => append("thinking", delta),
		closeBlock,
		toolCall(call) {
			if (ended) return;
			closeBlock();
			const index = message.content.length;
			const block = { type: "toolCall" as const, ...call };
			message.content.push(block);
			stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
			stream.push({
				type: "toolcall_delta",
				contentIndex: index,
				delta: JSON.stringify(call.arguments),
				partial: message,
			});
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
		},
		setUsage(usage) {
			message.usage = { ...usage, cost: emptyUsage().cost };
			message.usage.cost = calculateCost(model, message.usage);
		},
		finish(reason, responseId) {
			if (ended) return;
			closeBlock();
			ended = true;
			message.stopReason = reason;
			if (responseId) message.responseId = responseId;
			stream.push({ type: "done", reason, message });
			stream.end(message);
		},
		fail(reason, errorMessage, responseId) {
			if (ended) return;
			closeBlock();
			ended = true;
			message.stopReason = reason;
			message.errorMessage = errorMessage;
			if (responseId) message.responseId = responseId;
			stream.push({ type: "error", reason, error: message });
			stream.end(message);
		},
		isEnded: () => ended,
	};
}

/** Minimal async FIFO; `next` rejects when the signal aborts. */
export interface EventQueue<T> {
	push(item: T): void;
	peek(): T | undefined;
	shift(): T | undefined;
	next(signal?: AbortSignal): Promise<T>;
}

export function createEventQueue<T>(): EventQueue<T> {
	const items: T[] = [];
	let waiter: ((item: T) => void) | undefined;
	return {
		push(item) {
			if (waiter) {
				const resolve = waiter;
				waiter = undefined;
				resolve(item);
			} else items.push(item);
		},
		peek: () => items[0],
		shift: () => items.shift(),
		next(signal) {
			const ready = items.shift();
			if (ready !== undefined) return Promise.resolve(ready);
			if (signal?.aborted) return Promise.reject(new Error("aborted"));
			return new Promise<T>((resolve, reject) => {
				const onAbort = () => {
					waiter = undefined;
					reject(new Error("aborted"));
				};
				waiter = (item) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(item);
				};
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
	};
}
