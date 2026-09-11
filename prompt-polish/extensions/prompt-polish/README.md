# Prompt Polish configuration

Edit `polish.config.json` beside `index.ts`:

```json
{
  "model": "gpt-5.6-sol",
  "thinkingLevel": "high",
  "fastMode": true
}
```

## Fields

- `model`: non-empty model name. Default: `gpt-5.6-sol`.
- `thinkingLevel`: one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Default: `high`.
- `fastMode`: boolean fast-mode preference. Default: `true`; `true` sends `serviceTier: "priority"`, while `false` omits `serviceTier` because Pi has no valid `"standard"` tier.

## Prompt preview

After polishing, the editor keeps its compact native view and shows
accessible expand and copy controls. Press `Ctrl+Shift+E` to open the full
unchanged prompt in a scrollable preview; press `Ctrl+Shift+E` or `Esc` to
collapse it. Click `Copy polished prompt` or press `Ctrl+Shift+Y` to copy the
exact generated prompt, including whitespace and line breaks. In the expanded
view, Pi's configured `app.message.copy` key (default `Ctrl+X`) also copies it.
Copy success and failure are reported without changing the editor or preview.

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
