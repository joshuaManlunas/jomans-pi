# prompt-polish

Rewrites a rough prompt into a sharper one without answering or running it.
Every rewrite keeps your paths, code, and language, invents nothing, stays
within a length budget, and ends with a task-specific `Done when:` line.

One rewrite contract,
[`skills/prompt-polish/references/polishing.md`](skills/prompt-polish/references/polishing.md),
drives three front ends:

| Front end | Where | What it does |
| --- | --- | --- |
| Agent Skill | [`skills/prompt-polish/`](skills/prompt-polish/SKILL.md) | Ask any skills-capable agent to polish a prompt; it replies with the rewrite in a copyable block. |
| Pi extension | [`extensions/prompt-polish/`](extensions/prompt-polish/README.md) | Polishes the Pi editor draft in place, with preview, copy, and history. Loads the contract from the skill folder. |
| Claude Code plugin | [`claude-code/`](claude-code/README.md) | A ✨ Polish button above the prompt box. Carries its own Claude Code-specific copy of the rules, because the plugin installs from that folder alone. |

The contract has a core (preserve specifics, add nothing, goal first, length
budget, `Done when:`) and two profiles. The **agentic** profile covers act
versus advise, where to look, scope, concrete verification, and
confirm-before-destructive. The **single-shot** profile covers
self-containment, output format, and grounding. The profile is chosen from
`TARGET_MODEL`, or from the draft when no target is given.

## Default model

The Pi extension and the Claude Code plugin both polish with Claude Opus 5.5:

- Pi: `extensions/prompt-polish/polish.config.json` (see its README for the
  provider-qualified id).
- Claude Code: `claude-opus-5-5` in `claude-code/hooks/register.tsx`.

The skill uses whatever model the agent is already running.

## Install the skill

Copy the skill folder into your harness's skill directory, then reload skills:

```sh
cp -R skills/prompt-polish ~/.agents/skills/prompt-polish
```

The folder holds only `SKILL.md` and `references/polishing.md`. It needs no
scripts, packages, or particular model. Then ask, for example:

```text
Polish this prompt: fix the login redirect bug in src/auth/callback.ts
```

The reply is the rewritten prompt in one fenced block, plus at most one line
naming an assumption. Follow-ups such as "show the last one" or "copy it"
work from the conversation history. Copying uses `pbcopy`, `clip`, or
`wl-copy`/`xclip` when the agent has a shell.

For the Pi extension, add this package's path to `packages` in
`~/.pi/agent/settings.json`. For the Claude Code plugin, see
[`claude-code/README.md`](claude-code/README.md).

## Changing the rules

Edit `skills/prompt-polish/references/polishing.md`. The skill and the Pi
extension pick the change up directly. Carry any change that matters for
Claude Code into `SYSTEM` in `claude-code/hooks/polish-prompt.ts`, then run
the eval.

## Checks

```sh
npm test              # bun: skill metadata/links + Pi extension suite
npm run test:skill    # skill metadata and links only
npm run test:extension
npm run eval          # live: 9 drafts through `claude -p` (one call each)
(cd claude-code && claude plugin validate . && claude plugin test .)
```

The Pi suite imports the optional `@earendil-works/pi-*` peers, so install
them (or link a global Pi install's `node_modules/@earendil-works`) before
running it.

`npm run eval` sends nine drafts through the contract with Claude Opus 5.5.
Set `POLISH_EVAL_MODEL` to use another model, or pass case names to run a
subset. The drafts are a one-line fix, a question, an already-good prompt,
an injection, a Spanish draft, a code block, a slash command, a destructive
operation, and gibberish. Each rewrite is checked for kept paths and code, no
invented paths or numbers, the length budget, kept language, a `Done when:`
line, and not being answered. The length check sits close to what the model
produces, so a run can land a few words over on one case.
