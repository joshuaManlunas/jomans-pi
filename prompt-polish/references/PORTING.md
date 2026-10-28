# Porting record

## Canonical material inspected

The source of truth is `extensions/prompt-polish/index.ts`, `config.ts`,
`polish.config.json`, `README.md`, `index.test.ts`, and `config.test.ts` in this
repository. The working-tree extension already had local modifications;
this port uses that actual source, not an older committed version. It does
not modify those files. `assets/source-provenance.json` records SHA-256 hashes
of the inspected source snapshot for detecting subsequent divergence.

Format references: the local `writing-for-agents/SKILL.md` and
`SKILL-MECHANICS.md`, the local `ponytail/SKILL.md` example, and the
[Agent Skills specification](https://agentskills.io/specification). The skill
uses the portable specification's required `name`/`description` and optional
string-valued `metadata`, rather than host-specific invocation/tool metadata.
Explicit-polishing activation is expressed in instructions because an
invocation-disabling extension field is not universally supported.

## Behavior mapping

| Canonical behavior | Portable implementation |
| --- | --- |
| Entire `SYSTEM_PROMPT`, including analyze/enhance/ambiguity/self-check/hard rules | Verbatim `references/polishing.md`, mandatory before rewriting; loaded by `scripts/polish.mjs` for programmatic calls |
| INPUT_PROMPT, optional target/context semantics | Skill inputs; programmatic helper retains the extension's original empty-context request envelope |
| Config normalization and module-relative defaults | `scripts/config.mjs` and `assets/polish.config.json` |
| Model lookup, provider preference, deterministic fallback, thinking/priority options | `scripts/polish.mjs`, against a caller-supplied backend rather than a model registry |
| No tools, text/thinking/tool validation, one retry, deadlines and cancellation | Adapted non-UI completion code in `scripts/polish.mjs`; original regression cases in `tests/polish.test.js` |
| Cursor output isolation and trace-safe diagnostics | Original nonce-boundary and safe-metadata algorithms retained in the optional runtime |
| Improve editor without submitting, busy/empty guards and progress state | Explicit skill workflow; `PolishSession.polish()` with caller-owned draft/status callbacks |
| Editor changed during completion | Compare captured draft before replacement; preserve newer draft and save result to history |
| Full unchanged-text preview, collapse, scrolling | Explicit preview request; host UI or copyable plain text; controller supplies text/visibility state |
| Copy exact prompt and bounded browser/native/OSC52 fallbacks | `scripts/clipboard.mjs`, without the dynamic Pi clipboard import |
| Newest-first exact-text deduplication, 20 items, restore without submit | Original `addPolishHistoryItem`; portable `PolishSession` replay/restore and workflow instructions |
| Persist/reload branch history; warn once on storage failure | Explicit session-owned storage callback/replay; memory-only fallback; no Pi custom-entry format required |
| Session change cancels/discards stale work; shutdown resets state | Host-neutral `invalidate()`, `start(entries)`, and `stop()` calls; explicit conversation boundaries when no host UI exists |
| Submission closes preview/copy but retains history | `submit()` and workflow instructions; submission version prevents pending work reopening controls |
| Success, copy/restore, empty-state and failure notifications | Preserved outside the enhanced prompt; prompt-only response contract remains intact |

The JavaScript helpers were derived from canonical TypeScript with types
removed, not reconstructed from memory. Configuration and completion logic
retain their original structure. `PolishSession` adapts the extension's
closure-based state machine into an explicit reusable controller. Its
persistence callback receives a bounded oldest-first snapshot instead of an
append-only stream of Pi custom entries. No history is migrated implicitly.

## Deliberate platform substitutions

Pi registration, fixed shortcuts, TUI rendering/layout/mouse handlers,
spinner animation, session hooks, branch traversal, and `appendEntry` are not
portable runtime contracts. They become explicit user operations, caller-owned
UI/storage callbacks, and session-boundary methods. A text-only host cannot
acquire unsent drafts or observe branch events by reading a skill; this port
makes no such claim. The semantic safeguards remain available without those
facilities, and no runtime import resolves a Pi package.

Likewise a skill cannot enforce a provider-level deadline or independently
retry its own generation. Those deterministic protections live in the optional
runtime for hosts with a completion backend. Instruction-only use applies the
same rewrite contract through the current model, without pretending it can
switch models or control a host's transport.

## Updating

Compare the canonical files against the recorded hashes before carrying
changes forward. Keep the polishing contract verbatim, adapt changed non-UI
logic and regression cases, and update the behavior map and hashes together.
The optional provenance test checks equality when the canonical source tree
is present; installed skills never need that tree to run.
