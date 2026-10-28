import { describe, expect, test } from "bun:test";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	ToolResultMessage,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { toPiModels } from "./catalog.ts";
import { type CursorProviderSettings, type CursorRuntime, DEFAULT_SETTINGS } from "./config.ts";
import { MISSING_AUTH_MESSAGE } from "./errors.ts";
import { createCursorRuntime, type RunRecord, type RuntimeDeps } from "./runtime.ts";
import type {
	AgentOptions,
	CursorSdk,
	ModelListItem,
	Run,
	RunResult,
	SDKAgent,
	SDKCustomToolResult,
	SDKUserMessage,
	SendOptions,
} from "./sdk.ts";

const FAKE_KEY = "key_test_fake_1234567890";
const REPOSITORY = "https://example.invalid/acme/project.git";

function makeModel(options: { textOnly?: boolean; fast?: boolean } = {}): Model<Api> {
	const parameters: NonNullable<ModelListItem["parameters"]> = options.fast
		? [
				{
					id: "fast",
					displayName: "Fast",
					values: [{ value: "true" }, { value: "false" }],
				},
			]
		: [];
	const item: ModelListItem = { id: "runtime-model", displayName: "Runtime Model", parameters };
	const model = toPiModels([item], { textOnlyModels: options.textOnly ? [item.id] : [] })[0];
	if (!model) throw new Error("Test model failed to register");
	return model;
}

const MODEL = makeModel({ fast: true });

function context(messages: Message[]): TranscriptContext {
	return { messages } as TranscriptContext;
}

function user(text: string): Message {
	return { role: "user", content: text, timestamp: 1 };
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

interface FakeRunControl {
	run: Run;
	resolve(result: RunResult): void;
	cancelCount(): number;
}

function makeRun(agentId: string, id: string): FakeRunControl {
	const result = deferred<RunResult>();
	let cancellations = 0;
	const run = {
		id,
		agentId,
		wait: () => result.promise,
		cancel: async () => {
			cancellations += 1;
			result.resolve({ id, status: "cancelled" });
		},
		supports: () => false,
		unsupportedReason: () => "not implemented by fake",
		stream: async function* () {},
		conversation: async () => [],
		status: "running",
		onDidChangeStatus: () => () => {},
	} as unknown as Run;
	return {
		run,
		resolve: (value) => result.resolve(value),
		cancelCount: () => cancellations,
	};
}

interface SendCall {
	agentId: string;
	agentOptions: AgentOptions;
	message: string | SDKUserMessage;
	options: SendOptions;
	run: FakeRunControl;
}

interface FakeSdkState {
	createOptions: AgentOptions[];
	resumeCalls: Array<{ agentId: string; options: Partial<AgentOptions> }>;
	localRunLookups: Array<{ agentId: string; cwd: string }>;
	sendCalls: SendCall[];
	closedAgentIds: string[];
	firstSend: Deferred<SendCall>;
	resolveLocalRuns: (
		agentId: string,
		cwd: string,
	) => Promise<Array<{ id: string; createdAt?: number }>>;
	onSend?: (call: SendCall) => void | Promise<void>;
	createError?: Error;
}

function makeFakeSdk(
	options: {
		onSend?: FakeSdkState["onSend"];
		createError?: Error;
		listLocalRuns?: FakeSdkState["resolveLocalRuns"];
	} = {},
): { sdk: CursorSdk; state: FakeSdkState } {
	const state: FakeSdkState = {
		createOptions: [],
		resumeCalls: [],
		localRunLookups: [],
		sendCalls: [],
		closedAgentIds: [],
		firstSend: deferred<SendCall>(),
		resolveLocalRuns: options.listLocalRuns ?? (async () => []),
		onSend:
			options.onSend ??
			((call) =>
				call.run.resolve({ id: call.run.run.id, status: "finished", result: "fake completed" })),
		createError: options.createError,
	};
	let agentCounter = 0;
	let runCounter = 0;

	const makeAgent = (agentId: string, agentOptions: AgentOptions): SDKAgent =>
		({
			agentId,
			model: undefined,
			send: async (message: string | SDKUserMessage, sendOptions: SendOptions = {}) => {
				const run = makeRun(agentId, `run-${++runCounter}`);
				const call: SendCall = { agentId, agentOptions, message, options: sendOptions, run };
				state.sendCalls.push(call);
				if (state.sendCalls.length === 1) state.firstSend.resolve(call);
				await state.onSend?.(call);
				return run.run;
			},
			close: () => state.closedAgentIds.push(agentId),
			reload: async () => {},
			[Symbol.asyncDispose]: async () => {
				state.closedAgentIds.push(agentId);
			},
			listArtifacts: async () => [],
			downloadArtifact: async () => Buffer.from(""),
			getUsage: async () => ({
				runs: [],
				usage: {
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 0,
				},
			}),
		}) as SDKAgent;

	const sdk: CursorSdk = {
		listModels: async () => [],
		createAgent: async (agentOptions) => {
			state.createOptions.push(agentOptions);
			if (state.createError) throw state.createError;
			return makeAgent(`agent-${++agentCounter}`, agentOptions);
		},
		resumeAgent: async (agentId, agentOptions) => {
			state.resumeCalls.push({ agentId, options: agentOptions });
			return makeAgent(agentId, agentOptions as AgentOptions);
		},
		listLocalRuns: async (agentId, cwd) => {
			state.localRunLookups.push({ agentId, cwd });
			return state.resolveLocalRuns(agentId, cwd);
		},
	};
	return { sdk, state };
}

function makeHarness(
	options: {
		runtime?: CursorRuntime;
		cloudRepository?: string;
		mode?: CursorProviderSettings["mode"];
		apiKey?: string | null;
		mcpEnabled?: boolean;
		piTools?: RuntimeDeps["piTools"];
		fakeSdk?: ReturnType<typeof makeFakeSdk>;
	} = {},
) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	if (options.runtime) settings.runtime = options.runtime;
	if (options.cloudRepository) settings.cloud.repository = options.cloudRepository;
	if (options.mode) settings.mode = options.mode;
	if (options.mcpEnabled !== undefined) settings.mcpBridge.enabled = options.mcpEnabled;
	const fake = options.fakeSdk ?? makeFakeSdk();
	const records: RunRecord[] = [];
	const apiKey = options.apiKey === undefined ? FAKE_KEY : (options.apiKey ?? undefined);
	const runtime = createCursorRuntime({
		loadSdk: async () => fake.sdk,
		settings: () => settings,
		mode: () => settings.mode,
		cwd: () => "/repo",
		piTools: options.piTools ?? (() => ({ all: [], active: [] })),
		onRunRecord: (record) => records.push(record),
		env: () => apiKey,
		newId: () => "pi-call-test",
	});
	return { runtime, settings, fake, records };
}

function optionsFor(
	sessionId = "session-1",
	extra: { apiKey?: string; signal?: AbortSignal } = {},
) {
	return {
		sessionId,
		apiKey: extra.apiKey ?? FAKE_KEY,
		...(extra.signal ? { signal: extra.signal } : {}),
	};
}

function toolResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "weather",
		content: [{ type: "text", text: "sunny" }],
		isError: false,
		timestamp: 2,
	};
}

describe("createCursorRuntime", () => {
	test("uses local runtime by default", async () => {
		const harness = makeHarness();
		await harness.runtime.streamSimple(MODEL, context([user("hello")]), optionsFor()).result();
		expect(harness.settings.runtime).toBe("local");
		expect(harness.fake.state.createOptions[0]).toHaveProperty("local.cwd", "/repo");
		expect(harness.fake.state.createOptions[0]?.cloud).toBeUndefined();
	});

	test("creates a cloud agent only for explicit cloud settings with a repository", async () => {
		const harness = makeHarness({ runtime: "cloud", cloudRepository: REPOSITORY });
		await harness.runtime
			.streamSimple(MODEL, context([user("run remotely")]), optionsFor())
			.result();
		expect(harness.fake.state.createOptions[0]).toMatchObject({
			cloud: { repos: [{ url: REPOSITORY }], autoCreatePR: false },
		});
		expect(harness.fake.state.createOptions[0]?.local).toBeUndefined();
	});

	test("errors when cloud is selected without cloud.repository", async () => {
		const harness = makeHarness({ runtime: "cloud" });
		const message = await harness.runtime
			.streamSimple(MODEL, context([user("run remotely")]), optionsFor())
			.result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("cloud.repository");
		expect(harness.fake.state.createOptions).toHaveLength(0);
	});

	test("does not fall back to cloud when local agent creation throws", async () => {
		const fake = makeFakeSdk({ createError: new Error("local creation failed") });
		const harness = makeHarness({ runtime: "local", cloudRepository: REPOSITORY, fakeSdk: fake });
		const message = await harness.runtime
			.streamSimple(MODEL, context([user("hello")]), optionsFor())
			.result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("local creation failed");
		expect(fake.state.createOptions).toHaveLength(1);
		expect(fake.state.createOptions[0]?.local).toBeDefined();
		expect(fake.state.createOptions[0]?.cloud).toBeUndefined();
	});

	test("reports the missing-auth message without loading the SDK", async () => {
		const harness = makeHarness({ apiKey: null });
		const message = await harness.runtime
			.streamSimple(MODEL, context([user("hello")]), { sessionId: "no-key" })
			.result();
		expect(message.errorMessage).toBe(MISSING_AUTH_MESSAGE);
		expect(harness.fake.state.createOptions).toHaveLength(0);
	});

	test("rejects a model without Cursor metadata", async () => {
		const harness = makeHarness();
		const unknown = { ...MODEL, id: "not-in-catalog", cursor: undefined } as unknown as Model<Api>;
		const message = await harness.runtime
			.streamSimple(unknown, context([user("hello")]), optionsFor())
			.result();
		expect(message.errorMessage).toContain("not in the Cursor model catalog");
		expect(harness.fake.state.createOptions).toHaveLength(0);
	});

	test("maps text and thinking deltas, normalizes cache-inclusive turn usage, and responseId", async () => {
		const fake = makeFakeSdk({
			onSend: (call) => {
				call.options.onDelta?.({ update: { type: "text-delta", text: "live answer" } });
				call.options.onDelta?.({ update: { type: "thinking-delta", text: "short thought" } });
				call.options.onDelta?.({ update: { type: "thinking-completed", thinkingDurationMs: 0 } });
				call.options.onDelta?.({
					update: {
						type: "turn-ended",
						usage: {
							inputTokens: 12,
							outputTokens: 5,
							cacheReadTokens: 3,
							cacheWriteTokens: 2,
							reasoningTokens: 1,
						},
					},
				});
				call.run.resolve({
					id: call.run.run.id,
					status: "finished",
					result: "fallback text is not used",
					usage: {
						inputTokens: 999,
						outputTokens: 42,
						cacheReadTokens: 500,
						cacheWriteTokens: 400,
						totalTokens: 1941,
						reasoningTokens: 10,
					},
				});
			},
		});
		const harness = makeHarness({ fakeSdk: fake });
		const message = await harness.runtime
			.streamSimple(MODEL, context([user("hello")]), optionsFor())
			.result();
		const content = message.content;
		expect(content).toContainEqual({ type: "text", text: "live answer" });
		expect(content).toContainEqual({ type: "thinking", thinking: "short thought" });
		expect(message.usage).toMatchObject({
			input: 7,
			output: 5,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 17,
			reasoning: 1,
		});
		expect(message.responseId).toBe("cursor-agent:agent-1:run-1");
		expect(harness.records[0]?.responseId).toBe(message.responseId);
	});

	test("uses the latest per-turn usage instead of cumulative run usage", async () => {
		const fake = makeFakeSdk({
			onSend: (call) => {
				call.options.onDelta?.({
					update: {
						type: "turn-ended",
						usage: {
							inputTokens: 100,
							outputTokens: 3,
							cacheReadTokens: 90,
							cacheWriteTokens: 5,
							reasoningTokens: 1,
						},
					},
				});
				call.options.onDelta?.({
					update: {
						type: "turn-ended",
						usage: {
							inputTokens: 70_658,
							outputTokens: 2,
							cacheReadTokens: 70_600,
							cacheWriteTokens: 54,
							reasoningTokens: 2,
						},
					},
				});
				call.run.resolve({
					id: call.run.run.id,
					status: "finished",
					result: "multi-turn result",
					usage: {
						inputTokens: 70_758,
						outputTokens: 5,
						cacheReadTokens: 70_690,
						cacheWriteTokens: 59,
						totalTokens: 141_512,
					},
				});
			},
		});
		const harness = makeHarness({ fakeSdk: fake });
		const message = await harness.runtime
			.streamSimple(MODEL, context([user("hello")]), optionsFor())
			.result();

		expect(message.usage).toMatchObject({
			input: 4,
			output: 2,
			cacheRead: 70_600,
			cacheWrite: 54,
			totalTokens: 70_660,
			reasoning: 2,
		});
	});

	test("normalizes cumulative result usage as a single-turn fallback", async () => {
		const fake = makeFakeSdk({
			onSend: (call) => {
				call.options.onDelta?.({ update: { type: "turn-ended" } });
				call.run.resolve({
					id: call.run.run.id,
					status: "finished",
					usage: {
						inputTokens: 12,
						outputTokens: 5,
						cacheReadTokens: 3,
						cacheWriteTokens: 2,
						totalTokens: 22,
					},
				});
			},
		});
		const harness = makeHarness({ fakeSdk: fake });
		const message = await harness.runtime
			.streamSimple(MODEL, context([user("hello")]), optionsFor())
			.result();

		expect(message.usage).toMatchObject({
			input: 7,
			output: 5,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 17,
		});
	});

	test("leaves multi-turn result usage unset when turn-level usage is unavailable", async () => {
		const fake = makeFakeSdk({
			onSend: (call) => {
				call.options.onDelta?.({ update: { type: "turn-ended" } });
				call.options.onDelta?.({ update: { type: "turn-ended" } });
				call.run.resolve({
					id: call.run.run.id,
					status: "finished",
					usage: {
						inputTokens: 70_758,
						outputTokens: 5,
						cacheReadTokens: 70_690,
						cacheWriteTokens: 59,
						totalTokens: 141_512,
					},
				});
			},
		});
		const harness = makeHarness({ fakeSdk: fake });
		const message = await harness.runtime
			.streamSimple(MODEL, context([user("hello")]), optionsFor())
			.result();

		expect(message.usage).toMatchObject({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
		});
	});

	test("passes user images to the SDK in a { text, images } request", async () => {
		const harness = makeHarness();
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		await harness.runtime
			.streamSimple(
				MODEL,
				context([
					{ role: "user", content: [{ type: "text", text: "inspect this" }, image], timestamp: 1 },
				]),
				optionsFor(),
			)
			.result();
		const sent = harness.fake.state.sendCalls[0]?.message;
		expect(sent).toMatchObject({
			text: expect.stringContaining("inspect this"),
			images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
		});
	});

	test("applies fast mode as a model param and plan mode as the SDK agent mode", async () => {
		const fastHarness = makeHarness({ mode: "fast" });
		await fastHarness.runtime.streamSimple(MODEL, context([user("fast")]), optionsFor()).result();
		expect(fastHarness.fake.state.createOptions[0]?.model).toMatchObject({
			id: "runtime-model",
			params: [{ id: "fast", value: "true" }],
		});
		expect(fastHarness.fake.state.sendCalls[0]?.options.mode).toBe("agent");

		const planHarness = makeHarness({ mode: "plan" });
		await planHarness.runtime.streamSimple(MODEL, context([user("plan")]), optionsFor()).result();
		expect(planHarness.fake.state.sendCalls[0]?.options.mode).toBe("plan");
		expect(planHarness.fake.state.createOptions[0]?.model).toMatchObject({ id: "runtime-model" });
		expect(planHarness.fake.state.createOptions[0]?.model?.params).toBeUndefined();
	});

	test("continues a known Cursor run, starts fresh for other-provider history, and resumes only a listed local run", async () => {
		const continuation = makeHarness();
		const first = await continuation.runtime
			.streamSimple(MODEL, context([user("first")]), optionsFor())
			.result();
		const second = await continuation.runtime
			.streamSimple(MODEL, context([user("first"), first, user("second")]), optionsFor())
			.result();
		expect(continuation.fake.state.createOptions).toHaveLength(1);
		expect(continuation.records.at(-1)?.continuity).toBe("continued");
		expect(second.stopReason).toBe("stop");

		const foreignAssistant: AssistantMessage = {
			...second,
			provider: "another-provider",
			responseId: undefined,
		};
		const fresh = await continuation.runtime
			.streamSimple(
				MODEL,
				context([user("first"), first, user("second"), foreignAssistant, user("third")]),
				optionsFor(),
			)
			.result();
		expect(fresh.stopReason).toBe("stop");
		expect(continuation.fake.state.createOptions).toHaveLength(2);
		expect(continuation.records.at(-1)?.continuity).toBe("fresh");

		const resumedRunId = first.responseId?.split(":").at(-1);
		if (!resumedRunId || !first.responseId)
			throw new Error("Expected a responseId for resume fixture");
		const resumedAgentId = first.responseId.split(":")[1];
		if (!resumedAgentId) throw new Error("Expected an agent id in responseId");
		const resumeFake = makeFakeSdk({
			listLocalRuns: async () => [
				{ id: "older-run", createdAt: 1 },
				{ id: resumedRunId, createdAt: 2 },
			],
		});
		const resumed = makeHarness({ fakeSdk: resumeFake });
		await resumed.runtime
			.streamSimple(
				MODEL,
				context([user("first"), first, user("after restart")]),
				optionsFor("resumed-session"),
			)
			.result();
		expect(resumeFake.state.resumeCalls.map((call) => call.agentId)).toEqual([resumedAgentId]);
		expect(resumeFake.state.localRunLookups).toEqual([{ agentId: resumedAgentId, cwd: "/repo" }]);
		expect(resumeFake.state.createOptions).toHaveLength(0);
		expect(resumed.records[0]?.continuity).toBe("resumed");
	});

	test("aborts a live run and asks the SDK run to cancel", async () => {
		const fake = makeFakeSdk({ onSend: () => {} });
		const harness = makeHarness({ fakeSdk: fake });
		const controller = new AbortController();
		const stream = harness.runtime.streamSimple(
			MODEL,
			context([user("wait")]),
			optionsFor("abort-session", { signal: controller.signal }),
		);
		const call = await fake.state.firstSend.promise;
		controller.abort();
		const message = await stream.result();
		expect(call.run.cancelCount()).toBe(1);
		expect(message.stopReason).toBe("aborted");
	});

	test("bridges a Pi custom tool through toolUse and resolves it on the next stream", async () => {
		let execution: Promise<SDKCustomToolResult> | undefined;
		let executionResult: SDKCustomToolResult | undefined;
		const fake = makeFakeSdk({
			onSend: (call) => {
				const tool = Object.values(call.options.local?.customTools ?? {})[0];
				if (!tool) throw new Error("Expected the bridge custom tool");
				const pending = Promise.resolve(tool.execute({ city: "Lisbon" }, {}));
				execution = pending;
				void pending.then((result) => {
					executionResult = result;
					call.run.resolve({
						id: call.run.run.id,
						status: "finished",
						result: "continued after tool",
					});
				});
			},
		});
		const harness = makeHarness({
			mcpEnabled: true,
			fakeSdk: fake,
			piTools: () => ({
				all: [{ name: "weather", description: "Lookup weather", parameters: { type: "object" } }],
				active: ["weather"],
			}),
		});
		const original = [user("check weather")];
		const first = await harness.runtime
			.streamSimple(MODEL, context(original), optionsFor("bridge-session"))
			.result();
		expect(first.stopReason).toBe("toolUse");
		const toolCall = first.content.find((block) => block.type === "toolCall");
		expect(toolCall).toMatchObject({
			type: "toolCall",
			name: "weather",
			arguments: { city: "Lisbon" },
		});
		if (toolCall?.type !== "toolCall") throw new Error("Expected a bridged Pi tool call");
		expect(execution).toBeDefined();

		const toolMessage = toolResult(toolCall.id);
		const second = await harness.runtime
			.streamSimple(
				MODEL,
				context([...original, first, toolMessage, user("continue")]),
				optionsFor("bridge-session"),
			)
			.result();
		expect(second.stopReason).toBe("stop");
		expect(second.content).toContainEqual({ type: "text", text: "continued after tool" });
		expect(executionResult).toMatchObject({
			content: [{ type: "text", text: "sunny" }],
			isError: false,
		});
		expect(fake.state.sendCalls).toHaveLength(1);
	});

	test("omits local.customTools when the bridge is disabled", async () => {
		const harness = makeHarness({
			mcpEnabled: false,
			piTools: () => ({
				all: [{ name: "weather", description: "Lookup weather", parameters: { type: "object" } }],
				active: ["weather"],
			}),
		});
		await harness.runtime.streamSimple(MODEL, context([user("hello")]), optionsFor()).result();
		expect(harness.fake.state.sendCalls[0]?.options.local?.customTools).toBeUndefined();
	});

	test("disposeAll cancels a live run and closes its agent", async () => {
		const fake = makeFakeSdk({ onSend: () => {} });
		const harness = makeHarness({ fakeSdk: fake });
		const stream = harness.runtime.streamSimple(
			MODEL,
			context([user("wait")]),
			optionsFor("dispose-session"),
		);
		const call = await fake.state.firstSend.promise;
		// Let start() attach the live run to its session before disposal.
		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.runtime.disposeAll();
		const message = await stream.result();
		expect(call.run.cancelCount()).toBe(1);
		expect(fake.state.closedAgentIds).toContain("agent-1");
		expect(message.stopReason).toBe("aborted");
		expect(harness.runtime.activeSessions()).toBe(0);
	});

	test("never exposes a fake API key in SDK error text", async () => {
		const fake = makeFakeSdk({
			onSend: (call) =>
				call.run.resolve({
					id: call.run.run.id,
					status: "error",
					error: { message: `request failed with ${FAKE_KEY}` },
				}),
		});
		const harness = makeHarness({ fakeSdk: fake });
		const message = await harness.runtime
			.streamSimple(MODEL, context([user("hello")]), optionsFor())
			.result();
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).not.toContain(FAKE_KEY);
		expect(message.errorMessage).toContain("[redacted]");
	});
});
