# prompt-polish for Claude Code

Write a rough prompt, press **✨ Polish prompt**, and get back a clearer
version in the same box, ready to edit or send.

prompt-polish adds a button just above Claude Code's prompt box. Pressing it
sends your draft to Claude Sonnet, which rewrites it the way Claude Code
works best with:

- the goal stated up front, and whether Claude should make changes or just
  advise
- your file paths, @-mentions, commands, error messages and code blocks kept
  exactly as you wrote them
- clear scope, a concrete way to check the work, and "confirm with me first"
  for anything risky
- a task-specific **Done when:** line at the end

It's a light edit, not padding. It won't invent files, requirements or
numbers you didn't give. It never answers or runs your prompt; it only
rewrites the text in the box. You review the result and decide whether to
send it.

## Requirements

- A recent [Claude Code](https://claude.com/claude-code) release that
  supports plugin hooks modules (tested on 2.1.304)
- The terminal (CLI) or the Claude desktop app. The band above the prompt
  isn't drawn in the VS Code extension or on mobile.

## Install

At the prompt of a Claude Code session in your terminal:

```
/plugin install prompt-polish --marketplace OWNER/REPO
```

Answer `y` to add the marketplace, then press Enter to install at the user
scope (every project). You should see `Installed prompt-polish. Plugin is now
active.`, and the button appears right away.

From a shell instead:

```sh
claude plugin install prompt-polish --marketplace OWNER/REPO
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the
prompt box, then **Plugins**, **Add marketplace** with `OWNER/REPO`, then
**Add plugin**. A plugin installed from the terminal at the user scope also
loads in the desktop app.

### From a local clone

```sh
git clone https://github.com/OWNER/REPO.git
claude plugin marketplace add ./REPO
claude plugin install prompt-polish@prompt-polish
```

## Usage

1. Type a draft in the prompt box as usual, e.g. `fix the login redirect bug`.
2. Press **✨ Polish prompt** above the box:
   - **Mouse:** click it.
   - **Keyboard:** press `ctrl+x` then `tab` to move focus to the band, then
     `enter`. `esc` takes you back to the prompt.
3. While it works the button reads `⠋ Polishing prompt…`. That usually takes
   a few seconds and gives up after 90.
4. The polished prompt replaces your draft. Edit it if you like, then send it.

Good to know:

- **Your edits are safe.** If you change the draft while it's being
  polished, the plugin leaves your text alone and tells you so.
- **An empty box does nothing** except show "Nothing to polish".
- **Slash commands stay first.** A draft starting with `/review` or another
  command keeps it, unchanged, at the start.
- **Your language and voice are kept.** A draft in another language stays in
  that language, written in your first person.
- **The original isn't kept.** The plugin saves no history, so copy a draft
  first if you might want it back.
- **Hide the band** with `ctrl+x ctrl+a` or its `[-]` mark. Surveys that
  Claude Code shows in the same spot take priority, and the button comes back
  after them.

## Privacy and cost

Each polish makes one request to Claude Sonnet through your own Claude Code
login. It counts toward your usage the same as any other request (up to about
4,000 output tokens). The request contains only your draft and the
plugin's rewriting instructions: no conversation history, files or tool
access. Nothing goes anywhere else, and the plugin stores nothing.

## Update and uninstall

Get the latest version:

```sh
claude plugin marketplace update prompt-polish
claude plugin update prompt-polish@prompt-polish
```

Then start a new session (or run `/reload-plugins` in an open one).

Remove it:

```sh
claude plugin uninstall prompt-polish@prompt-polish
claude plugin marketplace remove prompt-polish
```

## Troubleshooting

- **No button.** Check that `claude plugin list` shows
  `prompt-polish@prompt-polish` as enabled, then run `/reload-plugins`.
  The button isn't drawn while a survey is showing, or in VS Code or on
  mobile.
- **"Polish failed: …" toast.** The model request didn't complete: a network
  or API error, no reply, or the 90-second timeout. Your draft is unchanged;
  press the button again.
- **Two Polish buttons.** Another copy of prompt-polish is installed from a
  different marketplace. Remove one with `claude plugin uninstall
  prompt-polish@<marketplace>`.
- **Anything else.** Start Claude Code with `claude --debug`; the debug log
  names the plugin and the reason when a hook fails or isn't drawn.

## Development

This folder is both the plugin and a one-entry marketplace (`prompt-polish`,
`"source": "./"`). Installed from a local folder,
Claude Code reads the plugin straight from that folder, so after an edit
`/reload-plugins` picks it up with no reinstall or version bump.

```sh
claude plugin validate .   # manifest, marketplace and hooks module
claude plugin test .       # hooks/polish.test.ts against the engine
claude --plugin-dir .      # a one-off session that hot-reloads on save
```

A `--plugin-dir` session also writes the API types into
`.claude-plugin/types/` (git-ignored), which `tsconfig.json` extends, so
`bunx tsc -p .` type-checks after that.

People who installed from GitHub run the copy made at install time, so they
only get a change through `claude plugin update`. Bump `version` in
`.claude-plugin/plugin.json` with each release so the update sees it.

| File | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | the plugin manifest |
| `.claude-plugin/marketplace.json` | the marketplace listing this folder |
| `hooks/hooks.json` | names the hooks module |
| `hooks/register.tsx` | the button and the polish flow |
| `hooks/polish-prompt.ts` | the rewriting instructions and `<polished>` extraction |
| `hooks/polish.test.ts` | tests on the terminal and desktop surfaces |
| `types/index.d.ts` | the plugin's state contract (`isBusy`, `frame`) |

To change how prompts get rewritten, edit `SYSTEM` in
`hooks/polish-prompt.ts`. To change the model, effort or timeout, edit the
`$.model.complete` call in `hooks/register.tsx`.
