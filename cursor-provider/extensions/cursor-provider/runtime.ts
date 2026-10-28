import {
	type Api,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	type Bridge,
	type BridgeCall,
	type BridgeToolInfo,
	createBridge,
	selectBridgeTools,
} from "./bridge.ts";
import { getCursorMeta, selectModel } from "./catalog.ts";
import type { CursorMode, CursorProviderSettings, CursorRuntime } from "./config.ts";
import { API_KEY_ENV } from "./constants.ts";
import { CursorProviderError, describeCursorError, MISSING_AUTH_MESSAGE } from "./errors.ts";
import { toSdkImages } from "./images.ts";
import type {
	AgentOptions,
	CursorSdk,
	ModelSelection,
	Run,
	RunResult,
	SDKAgent,
	SDKImage,
} from "./sdk.ts";
import {
	buildFreshRequest,
	formatResponseId,
	planTurn,
	type RequestParts,
	trailingToolResults,
} from "./transcript.ts";
import { isRecord, truncate } from "./util.ts";
import {
	createEventQueue,
	createMessageWriter,
	type EventQueue,
	type MessageWriter,
} from "./writer.ts";

export interface ToolActivity {
	callId: string;
	name: string;
	detail?: string;
	status: "running" | "completed";
}

/** Serializable summary of one Cursor run; index.ts stores it as a replay card. */
export interface RunRecord {
	sessionKey: string;
	responseId: string;
	agentId: string;
	runId: string;
	runtime: CursorRuntime;
	mode: CursorMode;
	model: ModelSelection;
	status: "finished" | "paused" | "error" | "cancelled";
	continuity: "fresh" | "continued" | "resumed";
	tools: ToolActivity[];
	durationMs?: number;
}

export interface RuntimeDeps {
	loadSdk: () => Promise<CursorSdk>;
	settings: () => CursorProviderSettings;
	mode: (sessionKey: string) => CursorMode;
	cwd: () => string;
	/** All registered Pi tools plus the names active in this session, for the optional bridge. */
	piTools: () => { all: BridgeToolInfo[]; active: string[] };
	onRunRecord?: (record: RunRecord) => void;
	env?: (name: string) => string | undefined;
	newId?: () => string;
}

type LiveEvent =
	| { type: "text"; text: string }
	| { type: "thinking"; text: string }
	| { type: "thinking_end" }
	| { type: "bridge"; call: BridgeCall }
	| { type: "done"; result: RunResult }
	| { type: "failed"; error: unknown };

type SdkTokenUsage = NonNullable<RunResult["usage"]>;
type SdkTurnUsage = Pick<
	SdkTokenUsage,
	"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens"
>;

interface RunUsageState {
	turnCount: number;
	latestTurnUsage?: SdkTurnUsage;
}

interface LiveRun {
	run: Run;
	agentId: string;
	queue: EventQueue<LiveEvent>;
	bridge?: Bridge;
	tools: Map<string, ToolActivity>;
	usage: RunUsageState;
	record: Omit<RunRecord, "status" | "tools" | "responseId" | "durationMs">;
	settled: boolean;
}

interface SessionState {
	agent?: SDKAgent;
	agentId?: string;
	lastRunId?: string;
	runtime?: CursorRuntime;
	live?: LiveRun;
}

export interface CursorRuntimeHandle {
	streamSimple(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
	disposeSession(sessionKey: string): Promise<void>;
	disposeAll(): Promise<void>;
	activeSessions(): number;
}

const TOOL_DETAIL_KEYS = ["command", "path", "filePath", "pattern", "query", "url", "globPattern"];

function toolDetail(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	for (const key of TOOL_DETAIL_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value !== "") return truncate(value.replace(/\s+/g, " "), 120);
	}
	return undefined;
}

/** Maps SDK `onDelta` updates to live events; unknown update types are ignored. */
export function handleDelta(update: unknown, live: Pick<LiveRun, "queue" | "tools">): void {
	if (!isRecord(update)) return;
	switch (update.type) {
		case "text-delta":
			if (typeof update.text === "string") live.queue.push({ type: "text", text: update.text });
			return;
		case "thinking-delta":
			if (typeof update.text === "string") live.queue.push({ type: "thinking", text: update.text });
			return;
		case "thinking-completed":
			live.queue.push({ type: "thinking_end" });
			return;
		case "tool-call-started":
		case "tool-call-completed": {
			const callId = typeof update.callId === "string" ? update.callId : undefined;
			const toolCall = isRecord(update.toolCall) ? update.toolCall : undefined;
			if (!callId || !toolCall) return;
			const existing = live.tools.get(callId);
			live.tools.set(callId, {
				callId,
				name: typeof toolCall.type === "string" ? toolCall.type : (existing?.name ?? "tool"),
				detail: existing?.detail ?? toolDetail(toolCall.args),
				status: update.type === "tool-call-completed" ? "completed" : "running",
			});
			return;
		}
	}
}

function isSdkTurnUsage(value: unknown): value is SdkTurnUsage {
	return (
		isRecord(value) &&
		typeof value.inputTokens === "number" &&
		typeof value.outputTokens === "number" &&
		typeof value.cacheReadTokens === "number" &&
		typeof value.cacheWriteTokens === "number" &&
		(value.reasoningTokens === undefined || typeof value.reasoningTokens === "number")
	);
}

function captureTurnUsage(update: unknown, usage: RunUsageState): void {
	if (!isRecord(update) || update.type !== "turn-ended") return;
	usage.turnCount += 1;
	usage.latestTurnUsage = isSdkTurnUsage(update.usage) ? update.usage : undefined;
}

function sdkUsage(usage: SdkTurnUsage) {
	const cacheRead = usage.cacheReadTokens;
	const cacheWrite = usage.cacheWriteTokens;
	const output = usage.outputTokens;
	// Cursor inputTokens includes cached buckets; RunResult.usage is cumulative across turns.
	const input = Math.max(0, usage.inputTokens - cacheRead - cacheWrite);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		...(usage.reasoningTokens === undefined ? {} : { reasoning: usage.reasoningTokens }),
	};
}

function sdkRunUsage(result: RunResult, usage: RunUsageState) {
	const turnUsage = usage.latestTurnUsage ?? (usage.turnCount === 1 ? result.usage : undefined);
	return turnUsage ? sdkUsage(turnUsage) : undefined;
}

function thinkingValue(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): string | undefined {
	const map = model.thinkingLevelMap;
	if (!map) return undefined;
	const value = options?.reasoning ? map[options.reasoning] : map.off;
	return typeof value === "string" ? value : undefined;
}

function applyPayloadOverride(text: string, replacement: unknown): string {
	if (
		isRecord(replacement) &&
		isRecord(replacement.message) &&
		typeof replacement.message.text === "string"
	) {
		return replacement.message.text;
	}
	return text;
}

/**
 * The provider's `streamSimple`: one Cursor SDK agent per Pi session, local by default. Cloud is
 * used only when settings or flags say so and never as a fallback for local failures.
 */
export function createCursorRuntime(deps: RuntimeDeps): CursorRuntimeHandle {
	const sessions = new Map<string, SessionState>();
	const env = deps.env ?? ((name: string) => process.env[name]);
	let counter = 0;
	const newId =
		deps.newId ?? (() => `cursor_bridge_${Date.now().toString(36)}_${(counter++).toString(36)}`);

	const stateFor = (key: string): SessionState => {
		let state = sessions.get(key);
		if (!state) {
			state = {};
			sessions.set(key, state);
		}
		return state;
	};

	const settleLive = (state: SessionState, live: LiveRun, reason: string) => {
		if (live.settled) return;
		live.settled = true;
		live.bridge?.cancelAll(reason);
		if (state.live === live) state.live = undefined;
	};

	const cancelLive = async (state: SessionState, reason: string) => {
		const live = state.live;
		if (!live) return;
		settleLive(state, live, reason);
		await live.run.cancel().catch(() => undefined);
	};

	const closeAgent = (state: SessionState) => {
		try {
			state.agent?.close();
		} catch {
			// Closing a finished agent is best effort.
		}
		state.agent = undefined;
		state.agentId = undefined;
		state.lastRunId = undefined;
	};

	const emitRecord = (live: LiveRun, status: RunRecord["status"], durationMs?: number) => {
		deps.onRunRecord?.({
			...live.record,
			responseId: formatResponseId(live.agentId, live.run.id),
			status,
			tools: [...live.tools.values()],
			...(durationMs === undefined ? {} : { durationMs }),
		});
	};

	/** Streams live-run events into one Pi assistant message until the run ends or asks for a Pi tool. */
	const drain = async (
		state: SessionState,
		live: LiveRun,
		writer: MessageWriter,
		model: Model<Api>,
		signal: AbortSignal | undefined,
		apiKey: string,
	): Promise<void> => {
		const responseId = formatResponseId(live.agentId, live.run.id);
		while (true) {
			let event: LiveEvent;
			try {
				event = await live.queue.next(signal);
			} catch {
				await cancelLive(state, "The Pi request was aborted.");
				emitRecord(live, "cancelled");
				writer.fail("aborted", "Cursor run cancelled.", responseId);
				return;
			}
			switch (event.type) {
				case "text":
					writer.text(event.text);
					break;
				case "thinking":
					writer.thinking(event.text);
					break;
				case "thinking_end":
					writer.closeBlock();
					break;
				case "bridge": {
					const calls = [event.call];
					await new Promise((resolve) => setTimeout(resolve, 25));
					while (live.queue.peek()?.type === "bridge") {
						const next = live.queue.shift();
						if (next?.type === "bridge") calls.push(next.call);
					}
					for (const call of calls) {
						writer.toolCall({ id: call.id, name: call.toolName, arguments: call.args });
					}
					emitRecord(live, "paused");
					writer.finish("toolUse", responseId);
					return;
				}
				case "done": {
					const { result } = event;
					settleLive(state, live, "The Cursor run ended.");
					state.lastRunId = live.run.id;
					const usage = sdkRunUsage(result, live.usage);
					if (usage) writer.setUsage(usage);
					if (result.status === "finished") {
						if (!writer.hasText() && result.result) writer.text(result.result);
						emitRecord(live, "finished", result.durationMs);
						writer.finish("stop", responseId);
					} else if (result.status === "cancelled") {
						emitRecord(live, "cancelled", result.durationMs);
						writer.fail("aborted", "Cursor run cancelled.", responseId);
					} else {
						emitRecord(live, "error", result.durationMs);
						const detail =
							result.error?.message ?? "the local agent reported an error without details";
						writer.fail(
							"error",
							describeCursorError(new Error(`Cursor run failed: ${detail}`), {
								modelId: model.id,
								runtime: live.record.runtime,
								apiKey,
							}),
							responseId,
						);
					}
					return;
				}
				case "failed":
					settleLive(state, live, "The Cursor run failed.");
					emitRecord(live, "error");
					writer.fail(
						"error",
						describeCursorError(event.error, {
							modelId: model.id,
							runtime: live.record.runtime,
							apiKey,
						}),
						responseId,
					);
					return;
			}
		}
	};

	const obtainAgent = async (
		sdk: CursorSdk,
		state: SessionState,
		plan: ReturnType<typeof planTurn>,
		base: AgentOptions,
		runtime: CursorRuntime,
		cwd: string,
		messages: TranscriptContext["messages"],
	): Promise<{ agent: SDKAgent; request: RequestParts; continuity: RunRecord["continuity"] }> => {
		const sameRuntime = state.runtime === runtime;
		if (plan.kind === "continue" && state.agent && sameRuntime) {
			return { agent: state.agent, request: plan.request, continuity: "continued" };
		}
		const fallback =
			plan.kind === "fresh"
				? plan.request
				: plan.kind === "resume"
					? plan.fallback
					: buildFreshRequest(messages);
		if (plan.kind !== "fresh" && runtime === "local" && plan.agentId.startsWith("agent-")) {
			closeAgent(state);
			try {
				const agent = await sdk.resumeAgent(plan.agentId, base);
				const runs = await sdk.listLocalRuns(plan.agentId, cwd);
				const latest = runs.reduce<(typeof runs)[number] | undefined>(
					(best, run) => (!best || (run.createdAt ?? 0) >= (best.createdAt ?? 0) ? run : best),
					undefined,
				);
				if (latest?.id === plan.runId) {
					return { agent, request: plan.request, continuity: "resumed" };
				}
				agent.close();
			} catch {
				// A missing or unreadable local agent is replaced by a fresh one with rendered history.
			}
		}
		closeAgent(state);
		const agent = await sdk.createAgent(base);
		return {
			agent,
			request: fallback,
			continuity: "fresh",
		};
	};

	const start = async (
		model: Model<Api>,
		context: TranscriptContext,
		options: SimpleStreamOptions | undefined,
		writer: MessageWriter,
	): Promise<void> => {
		const sessionKey = options?.sessionId ?? "default";
		const state = stateFor(sessionKey);
		const signal = options?.signal;
		const apiKey = options?.apiKey || env(API_KEY_ENV);
		if (!apiKey) throw new CursorProviderError(MISSING_AUTH_MESSAGE);
		const meta = getCursorMeta(model);
		if (!meta) {
			throw new CursorProviderError(
				`${model.id} is not in the Cursor model catalog. Run /cursor-agent models refresh and pick a listed model.`,
			);
		}

		if (state.live && !state.live.settled) {
			const live = state.live;
			const matched = live.bridge?.resolve(trailingToolResults(context.messages)) ?? 0;
			if (matched > 0) {
				await drain(state, live, writer, model, signal, apiKey);
				return;
			}
			await cancelLive(state, "The conversation moved on before Pi returned tool results.");
		}

		const settings = deps.settings();
		const runtime = settings.runtime;
		const mode = deps.mode(sessionKey);
		if (runtime === "cloud" && !settings.cloud.repository) {
			throw new CursorProviderError(
				'Cloud runtime is selected but `cloud.repository` is not set in cursor-provider.json. Set it, or switch back with `"runtime": "local"`.',
			);
		}
		const selection = selectModel(meta, {
			thinkingValue: thinkingValue(model, options),
			...(mode === "fast" ? { fast: true } : {}),
		});
		const cwd = deps.cwd();
		const base: AgentOptions =
			runtime === "local"
				? {
						apiKey,
						model: selection,
						local: {
							cwd,
							...(settings.settingSources ? { settingSources: settings.settingSources } : {}),
						},
					}
				: {
						apiKey,
						model: selection,
						cloud: {
							repos: [
								{
									url: settings.cloud.repository as string,
									...(settings.cloud.startingRef
										? { startingRef: settings.cloud.startingRef }
										: {}),
								},
							],
							autoCreatePR: settings.cloud.autoCreatePR,
						},
					};

		const plan = planTurn(
			context.messages,
			state.agentId ? { agentId: state.agentId, lastRunId: state.lastRunId } : undefined,
		);
		const images: SDKImage[] = toSdkImages(model, plan.request.images, settings.maxImageBytes);

		const sdk = await deps.loadSdk();
		const { agent, request, continuity } = await obtainAgent(
			sdk,
			state,
			plan,
			base,
			runtime,
			cwd,
			context.messages,
		);
		state.agent = agent;
		state.agentId = agent.agentId;
		state.runtime = runtime;
		const requestImages =
			request === plan.request
				? images
				: toSdkImages(model, request.images, settings.maxImageBytes);

		const queue = createEventQueue<LiveEvent>();
		const tools = new Map<string, ToolActivity>();
		let bridge: Bridge | undefined;
		if (runtime === "local" && settings.mcpBridge.enabled) {
			const { all, active } = deps.piTools();
			const selected = selectBridgeTools(all, active, settings.mcpBridge);
			if (selected.length > 0) {
				bridge = createBridge({
					tools: selected,
					timeoutMs: settings.mcpBridge.callTimeoutMs,
					newId,
					onCall: (call) => queue.push({ type: "bridge", call }),
				});
			}
		}

		const sdkMode = mode === "plan" ? "plan" : "agent";
		let text = request.text;
		if (options?.onPayload) {
			const payload = {
				runtime,
				agentId: agent.agentId,
				model: selection,
				mode: sdkMode,
				message: { text, imageCount: requestImages.length },
				customTools: bridge ? Object.keys(bridge.customTools) : [],
			};
			text = applyPayloadOverride(text, await options.onPayload(payload, model));
		}

		if (signal?.aborted) throw new CursorProviderError("Cursor run cancelled before it started.");
		const usage: RunUsageState = { turnCount: 0 };
		const run = await agent.send(
			requestImages.length > 0 ? { text, images: requestImages } : text,
			{
				model: selection,
				mode: sdkMode,
				onDelta: ({ update }) => {
					captureTurnUsage(update, usage);
					handleDelta(update, { queue, tools });
				},
				...(bridge ? { local: { customTools: bridge.customTools } } : {}),
			},
		);
		await options?.onResponse?.({ status: 200, headers: {} }, model);

		const live: LiveRun = {
			run,
			agentId: agent.agentId,
			queue,
			...(bridge ? { bridge } : {}),
			tools,
			usage,
			record: {
				sessionKey,
				agentId: agent.agentId,
				runId: run.id,
				runtime,
				mode,
				model: selection,
				continuity,
			},
			settled: false,
		};
		state.live = live;
		run.wait().then(
			(result) => queue.push({ type: "done", result }),
			(error: unknown) => queue.push({ type: "failed", error }),
		);
		await drain(state, live, writer, model, signal, apiKey);
	};

	const disposeSession = async (sessionKey: string) => {
		const state = sessions.get(sessionKey);
		if (!state) return;
		await cancelLive(state, "The Pi session ended.");
		closeAgent(state);
		sessions.delete(sessionKey);
	};

	return {
		streamSimple(model, context, options) {
			const stream = createAssistantMessageEventStream();
			const writer = createMessageWriter(stream, model);
			start(model, context, options, writer).catch((error: unknown) => {
				const aborted = options?.signal?.aborted === true;
				const message =
					error instanceof CursorProviderError
						? error.message
						: describeCursorError(error, {
								modelId: model.id,
								runtime: deps.settings().runtime,
								...(options?.apiKey ? { apiKey: options.apiKey } : {}),
							});
				writer.fail(aborted ? "aborted" : "error", message);
			});
			return stream;
		},
		disposeSession,
		async disposeAll() {
			await Promise.all([...sessions.keys()].map(disposeSession));
		},
		activeSessions: () => sessions.size,
	};
}
