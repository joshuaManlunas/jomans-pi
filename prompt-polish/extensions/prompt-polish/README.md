# Prompt Polish configuration

Edit `polish.config.json` beside `index.ts`:

```json
{
  "model": "openrouter/anthropic/claude-opus-5.5",
  "thinkingLevel": "high",
  "fastMode": false
}
```

## Fields

- `model`: non-empty model name or `provider/id`. Default: `openrouter/anthropic/claude-opus-5.5` (Claude Opus 5.5). Qualified names split at the first `/`, so the model ID here is `anthropic/claude-opus-5.5`. If the configured model is unavailable, polishing uses the session's current model.
- `thinkingLevel`: one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Default: `high`.
- `fastMode`: boolean fast-mode preference. Default: `false`; `true` passes `serviceTier: "priority"`, while `false` omits `serviceTier`. In the installed Pi 1.5.2 catalog, OpenRouter's Claude Opus 5.5 uses `anthropic-messages`. That adapter does not handle `serviceTier` or send a `service_tier` field, so this option cannot request priority for the default model and is disabled by default.

## Rewrite contract and delivery

The extension reads `skills/prompt-polish/references/polishing.md` from the
package root as its single rewrite contract. The contract and configuration
paths resolve relative to the extension module, independent of the working
directory, including when Pi loads the package from a local path. The
contract must be present; there is no embedded fallback.

`TARGET_MODEL` in each request names the session's current model (`ctx.model`),
which will receive the polished prompt. The configured polishing model
performs the rewrite. `CONTEXT` stays empty.

Every provider receives a delivery block after the contract requiring exactly
one opening and one closing boundary with a fresh random nonce for each
attempt. Only the text inside those boundaries can reach the editor or
history; outside text and structured thinking are discarded. Unbounded stop
text and tool-only responses retry once with no tools. An invalid retry
fails closed and leaves the editor and history unchanged.

For empty or unintelligible input, the delivery block overrides the contract's
one-line request with empty boundaries. Empty bounded output fails without
another retry, leaves the editor and history unchanged, and reports that no
prompt was found to rewrite. A blank editor is rejected locally before making
a request.

## Prompt preview

After polishing, the editor keeps its compact native view and shows
accessible expand and copy controls. Press `Ctrl+Shift+E` to open the full
unchanged prompt in a scrollable preview; press `Ctrl+Shift+E` or `Esc` to
collapse it. Click `Copy polished prompt` or press `Ctrl+Shift+Y` to copy the
exact generated prompt, including whitespace and line breaks. In the expanded
view, Pi's configured `app.message.copy` key (default `Ctrl+X`) also copies it.
Copy success and failure are reported without changing the editor or preview.

## Definition of done

Every polished prompt includes a concrete, task-specific `Done when:`
criterion that explains how the target model can tell the task is complete.
Derive it from the user's input and context, not generic boilerplate. If
success criteria are missing or ambiguous, use reasonable, verifiable
criteria implied by the request and state anything that could not be
verified, without inventing facts or requirements. Use one line for a simple
ask or question and a two-to-four item checklist for multi-part work. Keep an
existing `Done when:`.

## Session history

Successful polished prompts are saved as session-scoped Pi custom entries and
rehydrated on session start and branch navigation. Exact duplicate completed
text is shown once, newest first. `Ctrl+Shift+H` or the `Polish history`
control opens a keyboard- and mouse-selectable list; `↑`/`↓` navigate, `Enter`
restores the selected prompt to the editor without submitting it, and `Esc`
cancels. An empty session history shows a graceful empty state.

Submitting a prompt closes the expanded preview and removes its collapse/copy
instructions while retaining the history control. If session persistence is
unavailable, history remains in memory for the current runtime and a warning
is shown.

The loader resolves this file relative to the extension module, not the
process working directory. A missing or malformed file uses all defaults.
Missing or invalid fields fall back independently, so valid sibling settings
are preserved.

The package manifest publishes the `extensions/` tree, which includes this
JSON file.
