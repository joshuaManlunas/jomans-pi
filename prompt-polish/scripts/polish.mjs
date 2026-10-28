// Adapted from extensions/prompt-polish/index.ts; see references/PORTING.md.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadPolishConfig } from "./config.mjs";
export const SYSTEM_PROMPT = readFileSync(new URL("../references/polishing.md", import.meta.url), "utf8").trimEnd();
const MAX_HISTORY_ITEMS = 20;
const RETRY_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

For this retry only, no tools are available. Output only the enhanced prompt text.`;
function createCursorBoundary() {
  const nonce = randomBytes(32).toString("hex");
  return {
    open: `<prompt-polish-output-${nonce}>`,
    close: `</prompt-polish-output-${nonce}>`
  };
}
function cursorSystemPrompt(boundary, retry) {
  return `${retry ? RETRY_SYSTEM_PROMPT : SYSTEM_PROMPT}

For this Cursor request, the output boundary below is mandatory:
- Opening boundary: ${boundary.open}
- Closing boundary: ${boundary.close}

Emit the enhanced prompt only between those exact boundaries. Emit each
boundary exactly once. Do not emit any text, explanation, reasoning, or
tool call before the opening boundary or after the closing boundary.
${retry ? "This retry has no tools available. Do not emit a tool call. An unbounded response is invalid." : ""}`;
}
const DEFAULT_TIMEOUT_MS = 60000;
export function addPolishHistoryItem(history, item) {
  return [
    item,
    ...history.filter((entry) => entry.improved !== item.improved)
  ].slice(0, MAX_HISTORY_ITEMS);
}

class CompletionFailure extends Error {
  kind;
  constructor(kind) {
    super(kind);
    this.name = "PromptPolishCompletionFailure";
    this.kind = kind;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stopReasonOf(response) {
  const value = isRecord(response) ? response.stopReason : undefined;
  if (value === "stop" || value === "toolUse" || value === "length" || value === "pending" || value === "deferred" || value === "error" || value === "aborted") {
    return value;
  }
  return "unknown";
}
function summarizeResponse(response, boundary) {
  const content = isRecord(response) ? response.content : undefined;
  if (!Array.isArray(content)) {
    return {
      valid: false,
      text: "",
      contentCount: 0,
      textCount: 0,
      toolCallCount: 0,
      validToolCallCount: 0,
      boundaryMatched: false
    };
  }
  let valid = true;
  let textCount = 0;
  let toolCallCount = 0;
  let validToolCallCount = 0;
  const textParts = [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== "string") {
      valid = false;
      continue;
    }
    if (part.type === "thinking") {
      if (typeof part.thinking !== "string" || "thinkingSignature" in part && typeof part.thinkingSignature !== "string" || "redacted" in part && typeof part.redacted !== "boolean") {
        valid = false;
      }
      continue;
    }
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        valid = false;
        continue;
      }
      textCount += 1;
      textParts.push(part.text);
      continue;
    }
    if (part.type === "toolCall") {
      toolCallCount += 1;
      if (typeof part.id === "string" && typeof part.name === "string" && isRecord(part.arguments)) {
        validToolCallCount += 1;
      } else {
        valid = false;
      }
      continue;
    }
    valid = false;
  }
  const combinedText = boundary ? textParts.join("") : textParts.join(`
`);
  let text = combinedText.trim();
  let boundaryMatched = false;
  if (boundary) {
    const openStart = combinedText.indexOf(boundary.open);
    const openEnd = combinedText.lastIndexOf(boundary.open);
    const closeStart = combinedText.indexOf(boundary.close);
    const closeEnd = combinedText.lastIndexOf(boundary.close);
    if (openStart >= 0 && openStart === openEnd && closeStart >= 0 && closeStart === closeEnd && openStart < closeStart) {
      boundaryMatched = true;
      text = combinedText.slice(openStart + boundary.open.length, closeStart).trim();
    } else {
      text = "";
    }
  }
  return {
    valid,
    text,
    contentCount: content.length,
    textCount,
    toolCallCount,
    validToolCallCount,
    boundaryMatched
  };
}
function hasUnboundedCursorText(summary, boundary) {
  return boundary !== undefined && summary.textCount > 0 && !summary.boundaryMatched;
}
function canReturnToolUseText(summary, boundary) {
  return summary.valid && (!boundary || summary.boundaryMatched) && summary.validToolCallCount === summary.toolCallCount;
}
function emitDiagnostic(logger, model, attempt, stopReason, summary) {
  const diagnostic = {
    event: "prompt-polish",
    provider: model.provider,
    model: model.id,
    attempt,
    stopReason,
    contentCount: summary.contentCount,
    textCount: summary.textCount,
    toolCallCount: summary.toolCallCount
  };
  try {
    (logger ?? ((value) => console.warn(value)))(diagnostic);
  } catch {}
}
function timeoutMsOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}
function errorForFailure(kind) {
  if (kind === "timeout")
    return new Error("Prompt improvement timed out; the original prompt was not changed. Retry or switch models.");
  if (kind === "cancelled")
    return new Error("Prompt improvement was cancelled; the original prompt was not changed. Retry or switch models.");
  return new Error("Prompt improvement request failed; the original prompt was not changed. Retry or switch models.");
}
function errorForStop(reason) {
  if (reason === "aborted")
    return errorForFailure("cancelled");
  if (reason === "length")
    return new Error("Prompt improvement was truncated; the original prompt was not changed. Retry or switch models.");
  if (reason === "pending" || reason === "deferred")
    return new Error("Prompt improvement did not complete; the original prompt was not changed. Retry or switch models.");
  return new Error("Prompt improvement request failed; the original prompt was not changed. Retry or switch models.");
}
function malformedError() {
  return new Error("Prompt improvement returned malformed content; the original prompt was not changed. Retry or switch models.");
}
function emptyError() {
  return new Error("Prompt improvement returned no usable text; the original prompt was not changed. Retry or switch models.");
}
function malformedToolError() {
  return new Error("Prompt improvement returned a malformed or incomplete tool response; the original prompt was not changed. Retry or switch models.");
}
function unsupportedToolError() {
  return new Error("Prompt improvement requested unavailable tools; the original prompt was not changed. Retry or switch models.");
}
function isModelLike(value) {
  return isRecord(value) && typeof value.provider === "string" && typeof value.id === "string";
}
function compareModels(left, right) {
  if (left.provider !== right.provider)
    return left.provider < right.provider ? -1 : 1;
  if (left.id === right.id)
    return 0;
  return left.id < right.id ? -1 : 1;
}
export function resolveConfiguredModel(modelRef, fallback, registry) {
  const lookup = registry;
  let available;
  try {
    const models = lookup.listModels();
    if (!Array.isArray(models))
      return fallback;
    available = models.filter(isModelLike);
  } catch {
    return fallback;
  }
  const separator = modelRef.indexOf("/");
  if (separator > 0 && separator < modelRef.length - 1) {
    const provider = modelRef.slice(0, separator);
    const id = modelRef.slice(separator + 1);
    return available.find((candidate) => candidate.provider === provider && candidate.id === id) ?? fallback;
  }
  if (separator !== -1)
    return fallback;
  const matches = available.filter((candidate) => candidate.id === modelRef).sort(compareModels);
  return matches.find((candidate) => candidate.provider === fallback.provider) ?? matches[0] ?? fallback;
}
export function completionOverrides(config) {
  return {
    ...config.thinkingLevel === "off" ? {} : { reasoningEffort: config.thinkingLevel },
    ...config.fastMode ? { serviceTier: "priority" } : {}
  };
}
function completeWithDeadline(runtime, model, context, requestOptions, parentSignal, timeoutMs) {
  const controller = new AbortController;
  let timeout;
  let onParentAbort;
  let settled = false;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (timeout !== undefined)
        clearTimeout(timeout);
      if (parentSignal && onParentAbort)
        parentSignal.removeEventListener("abort", onParentAbort);
    };
    const finish = (action) => {
      if (settled)
        return;
      settled = true;
      cleanup();
      action();
    };
    const abort = (kind) => {
      controller.abort();
      finish(() => reject(new CompletionFailure(kind)));
    };
    onParentAbort = () => abort("cancelled");
    if (parentSignal?.aborted) {
      abort("cancelled");
      return;
    }
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    timeout = setTimeout(() => abort("timeout"), timeoutMs);
    let request;
    try {
      request = Promise.resolve(runtime.complete(model, context, {
        ...requestOptions,
        signal: controller.signal
      }));
    } catch {
      finish(() => reject(new CompletionFailure("provider")));
      return;
    }
    request.then((value) => finish(() => resolve(value)), () => finish(() => reject(new CompletionFailure("provider"))));
  });
}
async function completeAttempt(runtime, model, context, requestOptions, ctx, options, attempt, logger) {
  try {
    return await completeWithDeadline(runtime, model, context, requestOptions, ctx.signal, timeoutMsOf(options.timeoutMs));
  } catch (error) {
    const kind = error instanceof CompletionFailure ? error.kind : "provider";
    emitDiagnostic(logger, model, attempt, kind === "timeout" ? "timeout" : kind === "cancelled" ? "aborted" : "error", {
      valid: false,
      text: "",
      contentCount: 0,
      textCount: 0,
      toolCallCount: 0,
      validToolCallCount: 0,
      boundaryMatched: false
    });
    throw errorForFailure(kind);
  }
}
export async function polishPrompt(original, ctx, options = {}) {
  if (!ctx.model)
    throw new Error("No model selected");
  const config = await loadPolishConfig();
  const model = resolveConfiguredModel(config.model, ctx.model, ctx.backend);
  const requestOptions = completionOverrides(config);
  const boundary = model.provider === "cursor" ? createCursorBoundary() : undefined;
  const message = {
    role: "user",
    content: [
      {
        type: "text",
        text: `# Begin

INPUT_PROMPT:
<input_prompt>
${original}
</input_prompt>

CONTEXT:
<context>

</context>

TARGET_MODEL: ${model.provider}/${model.id}`
      }
    ],
    timestamp: Date.now()
  };
  const runtime = ctx.backend;
  const context = {
    systemPrompt: boundary ? cursorSystemPrompt(boundary, false) : SYSTEM_PROMPT,
    messages: [message],
    tools: []
  };
  const response = await completeAttempt(runtime, model, context, requestOptions, ctx, options, 1, options.logger);
  const summary = summarizeResponse(response, boundary);
  const reason = stopReasonOf(response);
  const shouldRetry = reason === "toolUse" && !summary.text || reason === "stop" && hasUnboundedCursorText(summary, boundary);
  if (reason === "toolUse" || shouldRetry) {
    emitDiagnostic(options.logger, model, 1, reason, summary);
    if (!shouldRetry) {
      if (!canReturnToolUseText(summary, boundary))
        throw malformedToolError();
      return summary.text;
    }
    const retryResponse = await completeAttempt(runtime, model, {
      systemPrompt: boundary ? cursorSystemPrompt(boundary, true) : RETRY_SYSTEM_PROMPT,
      messages: [message],
      tools: []
    }, requestOptions, ctx, options, 2, options.logger);
    const retrySummary = summarizeResponse(retryResponse, boundary);
    const retryReason = stopReasonOf(retryResponse);
    if (retryReason === "toolUse") {
      emitDiagnostic(options.logger, model, 2, retryReason, retrySummary);
      if (retrySummary.text) {
        if (!canReturnToolUseText(retrySummary, boundary))
          throw malformedToolError();
        return retrySummary.text;
      }
      if (hasUnboundedCursorText(retrySummary, boundary))
        throw malformedError();
      if (!retrySummary.valid || retrySummary.toolCallCount === 0 || retrySummary.validToolCallCount !== retrySummary.toolCallCount) {
        throw malformedToolError();
      }
      throw unsupportedToolError();
    }
    if (hasUnboundedCursorText(retrySummary, boundary)) {
      emitDiagnostic(options.logger, model, 2, retryReason, retrySummary);
      throw malformedError();
    }
    return handleNonToolResponse(retryReason, retrySummary, model, 2, options.logger);
  }
  return handleNonToolResponse(reason, summary, model, 1, options.logger);
}
function handleNonToolResponse(reason, summary, model, attempt, logger) {
  if (reason === "stop") {
    if (!summary.valid) {
      emitDiagnostic(logger, model, attempt, "stop", summary);
      throw malformedError();
    }
    if (!summary.text) {
      emitDiagnostic(logger, model, attempt, "stop", summary);
      throw emptyError();
    }
    return summary.text;
  }
  emitDiagnostic(logger, model, attempt, reason, summary);
  if (reason === "aborted")
    throw errorForFailure("cancelled");
  if (reason === "error" || reason === "unknown")
    throw errorForFailure("provider");
  throw errorForStop(reason);
}
