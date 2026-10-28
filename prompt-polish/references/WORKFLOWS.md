# Draft and session workflows

These operations accompany polishing; they never execute the input prompt.
Use ordinary conversation or host-provided UI. The portable controller in
`scripts/session.mjs` implements the state transitions when an integration
can provide callbacks. It requires no lifecycle hooks or command registration.

## Draft polishing

- Keep one active polishing operation per session. A second request reports
  `Prompt improvement already running`. An empty draft reports
  `Enter a prompt first` without making a request.
- Capture the draft, session identity/generation, and submission version before
  starting. A host may show `Improving prompt…` outside the prompt output.
  Clear busy state on success or failure.
- On success, retain the original, improved text, and timestamp in history.
  Apply the improved text only if the draft still exactly matches the captured
  original. If edited meanwhile, save the result without replacing the draft
  and report `Editor changed; improved prompt was saved to history but not applied`.
- Failure leaves the original draft and last successful result unchanged.
  Report the controlled failure separately from prompt text; offer retry or a
  different model through the failure message, not a trailing offer on success.
- When the user submits the draft, close the expanded preview and hide active
  preview/copy controls; retain access to history. If a completion is still
  pending, it must not reopen controls after submission.

## Preview and copy

- Preview the last completed or restored prompt, including exact internal
  whitespace and line breaks. Expand/collapse changes visibility, not content.
  Long prompts should be readable in full using available scrolling, paging,
  or plain text. Use an unchanged-text response when no preview UI exists.
- Copy that exact text using an available clipboard facility. Copy from an
  expanded preview uses the previewed text. Copy success/failure leaves the
  draft, preview, and history unchanged. Report `Prompt copied to clipboard`
  or `Prompt copy failed: <reason>` outside the prompt.
- With no completed/restored prompt, preview/copy reports `Polish a prompt first`.
- `scripts/clipboard.mjs` supplies bounded portable clipboard fallbacks if Node
  is available: browser clipboard first; then macOS `pbcopy`, Windows `clip`,
  or Linux Termux/Wayland/X11 tools as indicated by the environment. It uses
  stdin without a shell, tries candidates in order, and limits each attempt
  to five seconds. OSC52 is attempted when local copy fails or the session
  is remote, limited to 100,000 base64 characters. Terminal emission is a
  best-effort copy request, not a verifiable clipboard readback.
- When tools/clipboard access are unavailable, leave copy to the user's host
  copy action on the plain-text prompt. Never claim to have copied it.

## History and restore

- Keep successful entries `{ original, improved, timestamp }`, newest first,
  deduplicated by exact improved text, at most 20 entries. Repeated text moves
  to the front with the latest original/timestamp. Show each entry's first
  line and line count when listing it. Empty history reports
  `No polished prompts saved in this session.`
- Restore the selected entry's exact improved text without repolishing,
  submitting, adding a new entry, or reordering history. Make that result the
  current preview/copy target and report `Polished prompt restored` separately
  from its text. Cancellation of selection changes nothing.
- Maintain memory-only history in the current conversation by default. A host
  with explicit session-scoped storage may save entries there and replay them
  oldest first on resume. On persistence failure, retain memory-only history,
  warn once per session, and continue polishing normally. No external log or
  cross-project prompt archive is implied. Avoid exposing prompt text in logs.
- Before a session switch, fork, or branch navigation, invalidate pending work
  and cancel it where possible. Discard late results from the old session.
  On the new/resumed branch, clear transient state, load only its entries, and
  use the newest result for preview/copy; do not overwrite its draft on load.
  Shutdown clears transient state. Without host session controls, an explicit
  new conversation or history reset is the equivalent boundary.

A text-only harness cannot provide unsent-editor interception, keyboard/mouse
controls, overlays, or automatic branch notifications. Preserve their intent
through explicit requests and state tracking, rather than pretending those
facilities exist. Reading the skill itself never installs an input hook.
