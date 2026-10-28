# Optional portable runtime

Plain-text polishing uses only `SKILL.md` and its polishing contract. These
ES modules provide the extension's deterministic safeguards to integrations
with an existing completion backend. They require Node.js 20+ and only built-in
modules; no SDK, credentials, network client, or model backend is bundled.

## Completion API

```js
import { polishPrompt } from '/path/to/prompt-polish/scripts/polish.mjs';

const improved = await polishPrompt(original, {
  model: { provider: 'my-provider', id: 'my-model' },
  backend: {
    listModels() { return availableModels; }, // synchronous; may return []
    async complete(model, request, options) {
      // Translate to your existing provider's API. Never execute tool calls.
      // request: { systemPrompt, messages: [{ role, content, timestamp }], tools: [] }
      // options: { signal, reasoningEffort?, serviceTier? }
      // Return a normalized completion, e.g.:
      return { stopReason: 'stop', content: [{ type: 'text', text: generatedText }] };
    },
  },
  signal: abortController.signal, // optional
}, { timeoutMs: 60_000, logger: metadata => safeLog(metadata) });
```

`original` is the exact prompt text. The request envelope delimits it as
`INPUT_PROMPT`, leaves `CONTEXT` empty (as in the extension), and identifies
the resolved polishing model as `TARGET_MODEL`. For user-supplied context or
a different target model, use the instruction-only workflow, or include those
explicit details in `original`; this helper preserves the canonical envelope.
The completion adapter maps its own response into the documented normalized
format; it is not an implicit adapter for any particular provider SDK.

### Model preferences

Configuration is loaded from `assets/polish.config.json` relative to this
module, independent of the working directory. Defaults are copied from the
canonical source: model `gpt-5.6-sol`, thinking level `high`, fast mode `true`.
The model identifier is a preference, not an availability claim. Missing or
malformed files use defaults; missing/invalid fields fall back independently.
Valid thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
`off` omits `reasoningEffort`; fast mode requests `serviceTier: 'priority'`,
while false omits that option. An adapter must map supported options or omit
unsupported preferences without claiming they took effect.

A qualified `provider/id` must match both fields. A bare id prefers the current
provider, then sorts matches deterministically by provider/id. Unavailable or
invalid references, failed model lookup, and non-array model lists fall back
to the current model. No current model produces `No model selected`. An agent
without model-selection facilities simply uses its current model; do not
invent or force a model switch.

### Response contract

- `stopReason`: `stop`, `toolUse`, `length`, `pending`, `deferred`, `error`, or
  `aborted`. Unknown reasons are controlled failures.
- `content`: an array of text blocks `{type:'text', text:string}`, thinking
  blocks `{type:'thinking', thinking:string, thinkingSignature?:string,
  redacted?:boolean}`, and tool calls `{type:'toolCall', id:string,
  name:string, arguments:object}`. Arguments must be a non-array object.
- Thinking is excluded. Text blocks join with newlines and trim only at the
  outside. Malformed blocks fail validation; incomplete/truncated/error/aborted
  responses never replace the draft. Provider error details are not exposed.
- Every request has `tools: []`. A valid `toolUse` with usable text returns
  that text without running tools. A `toolUse` without usable text retries
  exactly once, with the same message/model/preferences and an explicit
  no-tools reminder. A second tool-only request fails in a controlled way.
- Each attempt defaults to a 60-second deadline; a finite positive override
  is supported. Timeout and cancellation reject even if a backend ignores
  its abort signal. They are not retried automatically.
- For a backend identified as `cursor`, a fresh 32-byte random nonce bounds
  output. Exactly one matching opening and closing boundary is required;
  only their inner text is returned. Split text blocks concatenate without
  separators. Unbounded `stop` text retries once with the same boundary;
  duplicate/missing boundaries after retry fail without leaking traces.
- Diagnostics contain only event/provider/model/attempt/stop reason and
  content/text/tool counts, never prompt text, reasoning, arguments, or raw
  provider errors. Logger failure cannot affect completion behavior.

## Session API

```js
import { PolishSession } from '/path/to/prompt-polish/scripts/session.mjs';
const session = new PolishSession({
  readDraft: () => draft,
  writeDraft: text => { draft = text; },
  // Optional synchronous callback. The host chooses a private session store.
  saveHistory: oldestFirstEntries => store(oldestFirstEntries),
  notify: (message, severity) => showStatus(message, severity),
});
session.start(savedOldestFirstEntries); // resume; never writes the draft
await session.polish(completionContext, completionOptions);
session.preview(); // toggles expanded; returns exact latest text
await session.copy();
session.restore(0); // newest entry -> draft, without submission
session.submit(); // hides preview/copy controls; preserves history
session.invalidate(); // cancel before switching sessions
session.start(otherBranchEntries); // clear state and load that branch
session.stop(); // clear transient state on shutdown
```

`history` is newest first; persistence callbacks receive oldest first for
replay. `polished`, `expanded`, `controlsVisible`, and `running` describe state;
these modules render no UI. `complete` and `writeClipboard` constructor
callbacks allow a host to substitute completion or clipboard facilities.
`polish()` reports failures via `notify` and returns undefined, preserving the
draft; `polishPrompt()` instead throws controlled errors. Callback functions
are trusted host facilities: notification/read/write callbacks should not
throw, and storage must be synchronous to avoid cross-session writes.
