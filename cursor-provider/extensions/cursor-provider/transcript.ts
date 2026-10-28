import type {
	AssistantMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "./constants.ts";
import { truncate } from "./util.ts";

const RESPONSE_ID_PREFIX = `${PROVIDER_ID}:`;
const MAX_HISTORY_TOOL_ARGS = 2_000;
const MAX_HISTORY_TOOL_RESULT = 4_000;

/** Links a Pi assistant message to the Cursor agent and run that produced it. */
export function formatResponseId(agentId: string, runId: string): string {
	return `${RESPONSE_ID_PREFIX}${agentId}:${runId}`;
}

export function parseResponseId(
	responseId: string | undefined,
): { agentId: string; runId: string } | undefined {
	if (!responseId?.startsWith(RESPONSE_ID_PREFIX)) return undefined;
	const [agentId, runId, ...rest] = responseId.slice(RESPONSE_ID_PREFIX.length).split(":");
	if (!agentId || !runId || rest.length > 0) return undefined;
	return { agentId, runId };
}

export interface RequestParts {
	text: string;
	images: ImageContent[];
}

export type TurnPlan =
	| { kind: "continue"; agentId: string; runId: string; request: RequestParts }
	| {
			kind: "resume";
			agentId: string;
			runId: string;
			request: RequestParts;
			fallback: RequestParts;
	  }
	| { kind: "fresh"; request: RequestParts };

export interface KnownAgent {
	agentId: string;
	lastRunId?: string;
}

function isAssistant(message: Message): message is AssistantMessage {
	return message.role === "assistant";
}

function textOf(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`))
		.join("\n");
}

function imagesOf(content: string | readonly (TextContent | ImageContent)[]): ImageContent[] {
	return typeof content === "string"
		? []
		: content.filter((part): part is ImageContent => part.type === "image");
}

function renderToolResult(message: ToolResultMessage): string {
	const status = message.isError ? "error" : "ok";
	return `Tool result (${message.toolName}, ${status}):\n${truncate(textOf(message.content), MAX_HISTORY_TOOL_RESULT)}`;
}

function renderAssistant(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text.trim() !== "") parts.push(block.text);
		else if (block.type === "toolCall") {
			parts.push(
				`Called tool \`${block.name}\` with ${truncate(JSON.stringify(block.arguments), MAX_HISTORY_TOOL_ARGS)}`,
			);
		}
	}
	return parts.length > 0 ? `Assistant:\n${parts.join("\n")}` : "";
}

/** Readable, deterministic rendering of Pi history for a Cursor agent that has not seen it. */
export function renderHistory(messages: readonly Message[]): string {
	const blocks: string[] = [];
	for (const message of messages) {
		if (message.role === "user") blocks.push(`User:\n${textOf(message.content)}`);
		else if (message.role === "assistant") {
			const rendered = renderAssistant(message);
			if (rendered) blocks.push(rendered);
		} else if (message.role === "toolResult") blocks.push(renderToolResult(message));
	}
	return blocks.join("\n\n");
}

function lastAssistantIndex(messages: readonly Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") return i;
	}
	return -1;
}

/** Text and images of the user messages after the last assistant message. */
function pendingRequest(messages: readonly Message[], from: number): RequestParts {
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const message of messages.slice(from)) {
		if (message.role !== "user") continue;
		const text = textOf(message.content);
		if (text.trim() !== "") texts.push(text);
		images.push(...imagesOf(message.content));
	}
	return { text: texts.join("\n\n"), images };
}

/**
 * Full request for a Cursor agent with no prior context: earlier Pi history is rendered as text
 * (older images become placeholders) and the pending user messages carry their images.
 */
export function buildFreshRequest(messages: readonly Message[]): RequestParts {
	const conversation = messages.filter((m) => m.role !== "system");
	const anchor = lastAssistantIndex(conversation);
	let historyEnd = anchor + 1;
	const tail = conversation.slice(historyEnd);
	if (tail.some((m) => m.role === "toolResult")) historyEnd = conversation.length;
	const history = renderHistory(conversation.slice(0, historyEnd));
	const pending = pendingRequest(conversation, historyEnd);
	const request = pending.text.trim() !== "" ? pending.text : "Continue.";
	if (history === "") return { text: request, images: pending.images };
	return {
		text:
			"The conversation below happened earlier in this Pi session, possibly with other models. " +
			"Use it as context; do not repeat completed actions unless asked.\n\n" +
			`<conversation_history>\n${history}\n</conversation_history>\n\n` +
			`Current request:\n${request}`,
		images: pending.images,
	};
}

/**
 * Decides how to reach the Cursor agent for this turn. A Cursor agent is reused only when the
 * newest assistant message came from it and everything after it is new user input; otherwise a
 * fresh agent receives the rendered history. `known` is the in-memory agent for this Pi session.
 */
export function planTurn(messages: readonly Message[], known: KnownAgent | undefined): TurnPlan {
	const conversation = messages.filter((m) => m.role !== "system");
	const anchorIndex = lastAssistantIndex(conversation);
	const fresh: TurnPlan = { kind: "fresh", request: buildFreshRequest(conversation) };
	if (anchorIndex < 0) return fresh;
	const anchor = conversation[anchorIndex];
	if (!anchor || !isAssistant(anchor) || anchor.provider !== PROVIDER_ID) return fresh;
	if (anchor.stopReason !== "stop" && anchor.stopReason !== "length") return fresh;
	const link = parseResponseId(anchor.responseId);
	if (!link) return fresh;
	const tail = conversation.slice(anchorIndex + 1);
	if (tail.length === 0 || tail.some((m) => m.role !== "user")) return fresh;
	const request = pendingRequest(conversation, anchorIndex + 1);
	if (request.text.trim() === "" && request.images.length === 0) return fresh;
	if (known?.agentId === link.agentId && known.lastRunId === link.runId) {
		return { kind: "continue", ...link, request };
	}
	return { kind: "resume", ...link, request, fallback: fresh.request };
}

/** Tool results after the newest assistant message, used to resume a paused bridge call. */
export function trailingToolResults(messages: readonly Message[]): ToolResultMessage[] {
	const anchor = lastAssistantIndex(messages);
	return messages.slice(anchor + 1).filter((m): m is ToolResultMessage => m.role === "toolResult");
}
