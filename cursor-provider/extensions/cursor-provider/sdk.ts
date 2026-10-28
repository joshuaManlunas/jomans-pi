import type {
	AgentOptions,
	ModelListItem,
	ModelSelection,
	Run,
	RunResult,
	SDKAgent,
	SDKCustomTool,
	SDKCustomToolResult,
	SDKImage,
	SDKMessage,
	SDKUserMessage,
	SendOptions,
} from "@cursor/sdk";

export type {
	AgentOptions,
	ModelListItem,
	ModelSelection,
	Run,
	RunResult,
	SDKAgent,
	SDKCustomTool,
	SDKCustomToolResult,
	SDKImage,
	SDKMessage,
	SDKUserMessage,
	SendOptions,
};

export interface RunSummary {
	id: string;
	createdAt?: number;
}

/** The subset of `@cursor/sdk` this extension uses. Injected in tests. */
export interface CursorSdk {
	listModels(apiKey: string): Promise<ModelListItem[]>;
	createAgent(options: AgentOptions): Promise<SDKAgent>;
	resumeAgent(agentId: string, options: Partial<AgentOptions>): Promise<SDKAgent>;
	/** Runs recorded for a local agent, used to prove a restored agent has no newer turns. */
	listLocalRuns(agentId: string, cwd: string): Promise<RunSummary[]>;
}

export class SdkUnavailableError extends Error {
	constructor(cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(
			`The Cursor SDK (@cursor/sdk) could not be loaded: ${detail}. Reinstall the extension with ` +
				"`pi install npm:pi-cursor-provider` (or `npm install` in its directory) on Node 22.13 or newer.",
		);
		this.name = "SdkUnavailableError";
	}
}

let loaded: Promise<CursorSdk> | undefined;

/** Loads the SDK on first use so Pi startup never pays for the SDK bundle. */
export function loadCursorSdk(): Promise<CursorSdk> {
	loaded ??= import("@cursor/sdk").then(
		(sdk): CursorSdk => ({
			listModels: (apiKey) => sdk.Cursor.models.list({ apiKey }),
			createAgent: (options) => sdk.Agent.create(options),
			resumeAgent: (agentId, options) => sdk.Agent.resume(agentId, options),
			listLocalRuns: async (agentId, cwd) => {
				const result = await sdk.Agent.listRuns(agentId, { runtime: "local", cwd, limit: 100 });
				return result.items.map((run) => ({ id: run.id, createdAt: run.createdAt }));
			},
		}),
		(error: unknown) => {
			loaded = undefined;
			throw new SdkUnavailableError(error);
		},
	);
	return loaded;
}
