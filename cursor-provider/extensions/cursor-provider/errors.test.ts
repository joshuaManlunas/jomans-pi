import { describe, expect, test } from "bun:test";
import { CursorProviderError, describeCursorError, redactSecrets } from "./errors.ts";
import { SdkUnavailableError } from "./sdk.ts";

const FAKE_KEY = "key_test_0000000000000000";

function sdkError(name: string, message: string, status?: number, code?: string): Error {
	return Object.assign(new Error(message), { name, status, code });
}

describe("redactSecrets", () => {
	test("redacts explicit credentials and Cursor key-shaped strings", () => {
		const extraKey = "crsr_live_0123456789abcdef";
		const result = redactSecrets(`key=${FAKE_KEY}; token=${extraKey}`, [FAKE_KEY]);
		expect(result).toBe("key=[redacted]; token=[redacted]");
		expect(result).not.toContain(FAKE_KEY);
		expect(result).not.toContain(extraKey);
	});

	test("does not replace a short caller-provided secret", () => {
		expect(redactSecrets("key=short", ["short"])).toBe("key=short");
	});
});

describe("describeCursorError", () => {
	test("classifies authentication failures without exposing the supplied key", () => {
		const message = describeCursorError(
			sdkError("AuthenticationError", `Rejected ${FAKE_KEY}`, 401),
			{ apiKey: FAKE_KEY },
		);
		expect(message).toContain("Cursor rejected the API key (401)");
		expect(message).toContain("/login cursor-agent");
		expect(message).not.toContain(FAKE_KEY);
	});

	test("classifies rate limits, invalid model configuration, and network failures", () => {
		expect(describeCursorError(sdkError("RateLimitError", "slow down", 429))).toContain(
			"Cursor rate limit reached",
		);
		expect(
			describeCursorError(sdkError("ConfigurationError", "Bad model name", 404), {
				modelId: "composer-test",
			}),
		).toContain('Cursor does not accept model "composer-test"');
		expect(describeCursorError(sdkError("NetworkError", "connection reset"))).toContain(
			"Could not reach Cursor: connection reset",
		);
	});

	test("classifies busy/cloud integration failures and SDK loading errors", () => {
		expect(
			describeCursorError(sdkError("AgentBusyError", "active run"), { runtime: "cloud" }),
		).toContain("Cursor Cloud agent is still busy");
		expect(
			describeCursorError(sdkError("IntegrationNotConnectedError", "connect GitHub")),
		).toContain("connected GitHub integration");
		expect(describeCursorError(new SdkUnavailableError("module missing"))).toContain(
			"The Cursor SDK (@cursor/sdk) could not be loaded",
		);
	});

	test("redacts CursorProviderError and retains useful details for unknown errors", () => {
		expect(describeCursorError(new CursorProviderError(`Bad configuration: ${FAKE_KEY}`))).toBe(
			"Bad configuration: [redacted]",
		);
		expect(
			describeCursorError(sdkError("OtherError", "unexpected response", undefined, "E_TEST"), {
				runtime: "cloud",
			}),
		).toBe("The Cursor Cloud agent failed: unexpected response (code E_TEST)");
		expect(
			describeCursorError(sdkError("OtherError", "unexpected response", undefined, "error")),
		).toBe("The local Cursor agent failed: unexpected response");
	});
});
