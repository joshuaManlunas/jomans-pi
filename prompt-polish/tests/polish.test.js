// Adapted from canonical index.test.ts; UI-only tests remain with the extension.
import { expect, test } from "bun:test";
import { polishPrompt, completionOverrides, resolveConfiguredModel } from "../scripts/polish.mjs";
import { CLIPBOARD_TIMEOUT_MS, MAX_OSC52_ENCODED_LENGTH, copyPromptText, fallbackCopyToClipboard, runClipboardCommand } from "../scripts/clipboard.mjs";
const model = { provider: "fake-provider", id: "fake-model" };
const text = (value) => ({ type: "text", text: value });
const toolCall = (argumentsValue) => ({
  type: "toolCall",
  id: "call-1",
  name: "secret-tool",
  arguments: argumentsValue
});
const response = (stopReason, content, errorMessage) => ({ stopReason, content, errorMessage });
const cursorModel = { provider: "cursor", id: "cursor-test-model" };
function cursorBoundaries(systemPrompt) {
  const match = /Opening boundary: (<prompt-polish-output-[a-f0-9]+>)\n- Closing boundary: (<\/prompt-polish-output-[a-f0-9]+>)/.exec(systemPrompt);
  if (!match?.[1] || !match[2])
    throw new Error("missing cursor boundaries");
  return { open: match[1], close: match[2] };
}
function harness(responses, signal, selectedModel = model, availableModels = []) {
  const calls = [];
  const runtime = {
    complete: (calledModel, context, options) => {
      calls.push({
        model: calledModel,
        context,
        options
      });
      const next = responses.shift();
      if (next === undefined)
        throw new Error("missing fake response");
      return typeof next === "function" ? next(calls) : next;
    }
  };
  return {
    calls,
    ctx: {
      model: selectedModel,
      backend: {
        complete: runtime.complete,
        listModels: () => typeof availableModels === "function" ? availableModels() : availableModels
      },
      signal
    }
  };
}
function diagnostics() {
  const entries = [];
  return { entries, logger: (entry) => entries.push(entry) };
}
test("copy preserves exact whitespace and reports clipboard outcomes", async () => {
  const exact = `  first line

  second line  `;
  const copied = [];
  const notices = [];
  const notify = (message, type) => notices.push({ message, type });
  expect(await copyPromptText(exact, notify, async (value) => {
    copied.push(value);
  })).toBe(true);
  expect(copied).toEqual([exact]);
  expect(notices).toEqual([
    { message: "Prompt copied to clipboard", type: "info" }
  ]);
  notices.length = 0;
  expect(await copyPromptText(exact, notify, async () => {
    throw new Error("clipboard unavailable");
  })).toBe(false);
  expect(notices).toEqual([
    { message: "Prompt copy failed: clipboard unavailable", type: "error" }
  ]);
});
test("clipboard fallback preserves command order and exact text", async () => {
  const exact = `first

  second`;
  const calls = [];
  await fallbackCopyToClipboard(exact, {
    platform: "linux",
    env: {
      TERMUX_VERSION: "1",
      WAYLAND_DISPLAY: "wayland-1",
      DISPLAY: ":0"
    },
    navigator: {},
    runCommand: async (command, text) => {
      calls.push({ ...command, text });
      if (command.command === "termux-clipboard-set")
        throw new Error("termux unavailable");
    }
  });
  expect(calls).toEqual([
    { command: "termux-clipboard-set", args: [], text: exact },
    { command: "wl-copy", args: [], text: exact }
  ]);
});
test("failed local clipboard paths use bounded OSC52", async () => {
  const exact = "exact clipboard text";
  const calls = [];
  let osc52Text;
  await fallbackCopyToClipboard(exact, {
    platform: "linux",
    env: { DISPLAY: ":0" },
    navigator: {},
    runCommand: async (command) => {
      calls.push(command);
      throw new Error(`${command.command} unavailable`);
    },
    emitOsc52: (text) => {
      osc52Text = text;
      return true;
    }
  });
  expect(calls).toEqual([
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] }
  ]);
  expect(osc52Text).toBe(exact);
});
test("remote clipboard attempts OSC52 after local success", async () => {
  const events = [];
  const exact = "remote exact text";
  await fallbackCopyToClipboard(exact, {
    platform: "darwin",
    env: { SSH_CONNECTION: "remote" },
    navigator: {},
    runCommand: async (command, text) => {
      events.push(`${command.command}:${text}`);
    },
    emitOsc52: (text) => {
      events.push(`osc52:${text}`);
      return true;
    }
  });
  expect(events).toEqual(["pbcopy:remote exact text", "osc52:remote exact text"]);
});
test("browser clipboard rejection and timeout remain bounded", async () => {
  expect(CLIPBOARD_TIMEOUT_MS).toBe(5000);
  const rejection = {
    clipboard: {
      writeText: async () => {
        throw new Error("browser rejected");
      }
    }
  };
  let failure;
  try {
    await fallbackCopyToClipboard("exact", {
      platform: "other",
      navigator: rejection,
      emitOsc52: () => false
    });
  } catch (error) {
    failure = error;
  }
  expect(String(failure)).toContain("browser rejected");
  const started = Date.now();
  failure = undefined;
  try {
    await fallbackCopyToClipboard("exact", {
      platform: "other",
      timeoutMs: 5,
      navigator: {
        clipboard: { writeText: () => new Promise(() => {}) }
      },
      emitOsc52: () => false
    });
  } catch (error) {
    failure = error;
  }
  expect(Date.now() - started).toBeLessThan(500);
  expect(String(failure)).toContain("navigator.clipboard.writeText timed out after 5ms");
});
test("clipboard command timeout kills the child without a shell", async () => {
  let killCount = 0;
  let receivedArgs = [];
  let receivedOptions;
  const child = {
    stdin: {
      once: () => child.stdin,
      end: () => {}
    },
    once: () => child,
    kill: () => {
      killCount++;
      return true;
    }
  };
  const spawnProcess = (_command, args, options) => {
    receivedArgs = args;
    receivedOptions = options;
    return child;
  };
  let failure;
  try {
    await runClipboardCommand({ command: "slow-copy", args: ["--clipboard"] }, "exact text", spawnProcess, 5);
  } catch (error) {
    failure = error;
  }
  expect(killCount).toBe(1);
  expect(receivedArgs).toEqual(["--clipboard"]);
  expect(receivedOptions).toMatchObject({
    stdio: ["pipe", "ignore", "ignore"]
  });
  expect(receivedOptions).not.toHaveProperty("shell");
  expect(String(failure)).toContain("slow-copy timed out after 5ms");
});
test("uses the configured model and completion defaults when available", async () => {
  const configuredModel = {
    provider: "configured-provider",
    id: "gpt-5.6-sol"
  };
  const h = harness([response("stop", [text("  improved prompt  ")])], undefined, model, [configuredModel]);
  expect(await polishPrompt("original", h.ctx)).toBe("improved prompt");
  expect(h.calls[0].model).toBe(configuredModel);
  expect(h.calls[0].options).toMatchObject({
    reasoningEffort: "high",
    serviceTier: "priority"
  });
  expect(h.calls[0].context.tools).toEqual([]);
});
test("falls back to the current model when the configured model is unavailable", async () => {
  const h = harness([response("stop", [text("  improved prompt  ")])]);
  expect(await polishPrompt("original", h.ctx)).toBe("improved prompt");
  expect(h.calls[0].model).toBe(model);
});
test("prefers the current provider for duplicate bare model ids", async () => {
  const currentModel = { provider: "z-provider", id: "current-model" };
  const otherProvider = { provider: "a-provider", id: "gpt-5.6-sol" };
  const currentProvider = { provider: "z-provider", id: "gpt-5.6-sol" };
  const h = harness([response("stop", [text("  improved prompt  ")])], undefined, currentModel, [otherProvider, currentProvider]);
  expect(await polishPrompt("original", h.ctx)).toBe("improved prompt");
  expect(h.calls[0].model).toBe(currentProvider);
});
test("orders bare model matches deterministically after provider preference", async () => {
  const currentModel = { provider: "missing-provider", id: "current-model" };
  const laterProvider = { provider: "z-provider", id: "gpt-5.6-sol" };
  const earlierProvider = { provider: "a-provider", id: "gpt-5.6-sol" };
  const h = harness([response("stop", [text("  improved prompt  ")])], undefined, currentModel, [laterProvider, earlierProvider]);
  expect(await polishPrompt("original", h.ctx)).toBe("improved prompt");
  expect(h.calls[0].model).toBe(earlierProvider);
});
test("falls back when an unavailable qualified model is configured", () => {
  const h = harness([], undefined, model, [
    { provider: "other-provider", id: "missing-model" }
  ]);
  expect(resolveConfiguredModel("missing-provider/missing-model", model, h.ctx.backend)).toBe(model);
});
test("falls back when available-model lookup throws", async () => {
  const h = harness([response("stop", [text("  improved prompt  ")])], undefined, model, () => {
    throw new Error("secret lookup failure");
  });
  expect(await polishPrompt("original", h.ctx)).toBe("improved prompt");
  expect(h.calls[0].model).toBe(model);
});
test("omits serviceTier when fastMode is false", () => {
  const options = completionOverrides({
    model: "gpt-5.6-sol",
    thinkingLevel: "high",
    fastMode: false
  });
  expect(options.reasoningEffort).toBe("high");
  expect("serviceTier" in options).toBe(false);
});
test("reuses the configured model and completion defaults for retries", async () => {
  const configuredModel = {
    provider: "configured-provider",
    id: "gpt-5.6-sol"
  };
  const h = harness([
    response("toolUse", [toolCall({ query: "secret" })]),
    response("stop", [text("  fallback prompt  ")])
  ], undefined, model, [configuredModel]);
  expect(await polishPrompt("original", h.ctx)).toBe("fallback prompt");
  expect(h.calls.map((call) => call.model)).toEqual([
    configuredModel,
    configuredModel
  ]);
  for (const call of h.calls) {
    expect(call.options).toMatchObject({
      reasoningEffort: "high",
      serviceTier: "priority"
    });
  }
});
test("returns useful text from toolUse without retrying", async () => {
  const d = diagnostics();
  const h = harness([
    response("toolUse", [
      text("  useful prompt  "),
      toolCall({ secret: "tool-args" })
    ])
  ]);
  expect(await polishPrompt("original", h.ctx, { logger: d.logger })).toBe("useful prompt");
  expect(h.calls).toHaveLength(1);
  expect(d.entries).toHaveLength(1);
});
test("retries a toolUse without text and accepts stop text", async () => {
  const d = diagnostics();
  const h = harness([
    response("toolUse", [toolCall({ query: "secret" })]),
    response("stop", [text("  fallback prompt  ")])
  ]);
  expect(await polishPrompt("original", h.ctx, { logger: d.logger })).toBe("fallback prompt");
  expect(h.calls).toHaveLength(2);
  expect(d.entries).toHaveLength(1);
  expect(h.calls.every((call) => Array.isArray(call.context.tools) && call.context.tools.length === 0)).toBe(true);
  expect(h.calls[1].context.systemPrompt).toContain("no tools are available");
});
test("every polishing request requires a task-specific definition of done", async () => {
  const h = harness([
    response("toolUse", [toolCall({ query: "secret" })]),
    response("stop", [text("fallback prompt")])
  ]);
  await polishPrompt("original", h.ctx, { logger: () => {} });
  const cursor = harness([
    (calls) => {
      const { open, close } = cursorBoundaries(calls[0].context.systemPrompt);
      return response("stop", [text(`${open}cursor prompt${close}`)]);
    }
  ], undefined, cursorModel);
  await polishPrompt("original", cursor.ctx, { logger: () => {} });
  const prompts = [...h.calls, ...cursor.calls].map((call) => call.context.systemPrompt);
  expect(prompts).toHaveLength(3);
  for (const prompt of prompts) {
    expect(prompt).toContain('**Define "done" (always required).**');
    expect(prompt).toContain('"How can the model determine that this task is complete?"');
    expect(prompt).toContain(`Derive every
  criterion from the INPUT PROMPT`);
    expect(prompt).toContain("never generic boilerplate");
    expect(prompt).toContain(`When success criteria are
  missing or ambiguous`);
    expect(prompt).toContain(`without inventing facts, data, requirements, or
  thresholds`);
    expect(prompt).toContain("Contains an explicit, task-specific definition of done");
  }
});
test("reports malformed tool responses after retry without leaking details", async () => {
  const d = diagnostics();
  const malformed = response("toolUse", [
    {
      type: "toolCall",
      id: "secret-id",
      name: "secret-tool",
      arguments: "secret-arguments"
    }
  ]);
  const h = harness([malformed, malformed]);
  await expect(polishPrompt("secret-original", h.ctx, { logger: d.logger })).rejects.toThrow("malformed or incomplete tool response");
  expect(d.entries).toHaveLength(2);
  expect(JSON.stringify(d.entries)).not.toContain("secret-original");
  expect(JSON.stringify(d.entries)).not.toContain("secret-arguments");
});
test("reports valid but unsupported tool requests after retry", async () => {
  const d = diagnostics();
  const call = toolCall({ secret: "secret-arguments" });
  const h = harness([response("toolUse", [call]), response("toolUse", [call])]);
  await expect(polishPrompt("original", h.ctx, { logger: d.logger })).rejects.toThrow("requested unavailable tools");
  expect(h.calls).toHaveLength(2);
  expect(d.entries).toHaveLength(2);
  expect(d.entries.map((entry) => entry.attempt)).toEqual([1, 2]);
});
test("converts a retry that ignores abort into a controlled timeout", async () => {
  const never = new Promise(() => {});
  const d = diagnostics();
  const h = harness([response("toolUse", []), never]);
  await expect(polishPrompt("secret-original", h.ctx, { timeoutMs: 5, logger: d.logger })).rejects.toThrow("timed out");
  expect(h.calls).toHaveLength(2);
  expect(JSON.stringify(d.entries)).not.toContain("secret-original");
});
test("handles provider rejection, provider error, and aborted response safely", async () => {
  const cases = [
    {
      completion: () => Promise.reject(new Error("secret-provider-error")),
      message: "request failed"
    },
    {
      completion: response("error", [], "secret-provider-error"),
      message: "request failed"
    },
    {
      completion: response("aborted", [], "secret-provider-error"),
      message: "cancelled"
    }
  ];
  for (const item of cases) {
    const d = diagnostics();
    const h = harness([item.completion]);
    await expect(polishPrompt("secret-original", h.ctx, { logger: d.logger })).rejects.toThrow(item.message);
    expect(JSON.stringify(d.entries)).not.toContain("secret-original");
    expect(JSON.stringify(d.entries)).not.toContain("secret-provider-error");
  }
});
test("outer cancellation rejects even when the provider ignores abort", async () => {
  const controller = new AbortController;
  const never = new Promise(() => {});
  const h = harness([never], controller.signal);
  const pending = polishPrompt("original", h.ctx, {
    timeoutMs: 500,
    logger: () => {}
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
    { completion: response("mystery", []), message: "request failed" }
  ];
  for (const item of cases) {
    const h = harness([item.completion]);
    await expect(polishPrompt("original", h.ctx, { logger: () => {} })).rejects.toThrow(item.message);
  }
});
test("diagnostics contain only safe metadata", async () => {
  const d = diagnostics();
  const h = harness([
    response("toolUse", [
      text("safe"),
      toolCall({ secret: "secret-tool-args" })
    ])
  ]);
  await polishPrompt("secret-original-prompt", h.ctx, { logger: d.logger });
  const entry = d.entries[0];
  expect(Object.keys(entry).sort()).toEqual([
    "attempt",
    "contentCount",
    "event",
    "model",
    "provider",
    "stopReason",
    "textCount",
    "toolCallCount"
  ]);
  expect(JSON.stringify(d.entries)).not.toContain("secret-original-prompt");
  expect(JSON.stringify(d.entries)).not.toContain("secret-tool-args");
});
test("Cursor strips screenshot-style reasoning outside the bounded prompt", async () => {
  const h = harness([
    (calls) => {
      const { open, close } = cursorBoundaries(calls[0].context.systemPrompt);
      return response("stop", [
        text([
          "I inspected the screenshot and reasoned about the layout:",
          "┌────────────────────┐",
          "│ secret trace       │",
          "└────────────────────┘",
          `${open}bounded prompt${close}`,
          "post-boundary reasoning"
        ].join(`
`))
      ]);
    }
  ], undefined, cursorModel);
  expect(await polishPrompt("original", h.ctx)).toBe("bounded prompt");
});
test("Cursor ignores structured thinking and returns bounded final text", async () => {
  const h = harness([
    (calls) => {
      const { open, close } = cursorBoundaries(calls[0].context.systemPrompt);
      return response("stop", [
        { type: "thinking", thinking: "secret trace" },
        text(`${open}final prompt${close}`)
      ]);
    }
  ], undefined, cursorModel);
  expect(await polishPrompt("original", h.ctx)).toBe("final prompt");
});
test("Cursor retries unbounded text with the same boundary and no tools", async () => {
  const h = harness([
    () => response("stop", [text("unbounded first response")]),
    (calls) => {
      const first = cursorBoundaries(calls[0].context.systemPrompt);
      const second = cursorBoundaries(calls[1].context.systemPrompt);
      expect(second).toEqual(first);
      return response("stop", [
        text(`${second.open}bounded retry${second.close}`)
      ]);
    }
  ], undefined, cursorModel);
  expect(await polishPrompt("original", h.ctx)).toBe("bounded retry");
  expect(h.calls).toHaveLength(2);
  expect(h.calls.map((call) => call.context.tools)).toEqual([[], []]);
});
test("Cursor rejects two unbounded responses without exposing traces", async () => {
  const d = diagnostics();
  const h = harness([
    response("stop", [text("secret first trace")]),
    response("stop", [text("secret retry trace")])
  ], undefined, cursorModel);
  let error;
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
  const duplicate = (calls) => {
    const { open, close } = cursorBoundaries(calls[0].context.systemPrompt);
    return response("stop", [
      text(`${open}first${open}nested${close}${close}`)
    ]);
  };
  const h = harness([duplicate, duplicate], undefined, cursorModel);
  await expect(polishPrompt("original", h.ctx)).rejects.toThrow("malformed content");
});
test("Cursor rejects malformed toolUse with bounded text", async () => {
  const h = harness([
    (calls) => {
      const { open, close } = cursorBoundaries(calls[0].context.systemPrompt);
      return response("toolUse", [
        text(`${open}bounded prompt${close}`),
        toolCall("malformed-arguments")
      ]);
    }
  ], undefined, cursorModel);
  await expect(polishPrompt("original", h.ctx)).rejects.toThrow("malformed or incomplete tool response");
});
test("Cursor keeps malformed thinking responses controlled", async () => {
  const h = harness([
    (calls) => {
      const { open, close } = cursorBoundaries(calls[0].context.systemPrompt);
      return response("stop", [
        {
          type: "thinking",
          thinking: "secret trace",
          thinkingSignature: 42
        },
        text(`${open}valid final${close}`)
      ]);
    }
  ], undefined, cursorModel);
  await expect(polishPrompt("original", h.ctx)).rejects.toThrow("malformed content");
});
