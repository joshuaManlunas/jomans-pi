# Prompt Polish skill

An installable [Agent Skill](https://agentskills.io/specification) that rewrites
prompts without answering or executing them. The polishing contract is copied
verbatim from this repository's canonical Pi extension, including mandatory
task-specific completion criteria, silent ambiguity handling, preservation of
specifics and language, and plain-text-only output.

## Install

Point any Agent Skills-compatible installer at this directory. Alternatively,
copy `SKILL.md`, `references/`, `assets/`, and `scripts/` into a directory named
`prompt-polish` inside your harness's documented skill search path. Include
this README for human-facing documentation. A supplied installer performs
that copy without overwriting an existing skill:

```sh
node /path/to/prompt-polish/scripts/install.mjs /path/to/your/harness/skills
```

The resulting path is `/path/to/your/harness/skills/prompt-polish/SKILL.md`.
Reload/discover skills as documented by your harness. The installation contains
no extension code, plugins, lifecycle hooks, or package dependencies.

For a harness without skill discovery, attach/read `SKILL.md` and its linked
resources and explicitly ask the agent to apply the skill. All paths are
relative to the installed skill directory, not your project.

**Requirements:** none beyond an agent able to read the skill and rewrite
text. Optional completion/clipboard/session helpers require Node.js 20+ and a
host-provided completion backend for programmatic polishing. No npm install,
Pi runtime, external service, or particular model is required. The existing Pi
extension and Claude-specific implementation remain separate; do not install
them to use this skill. npm packaging includes the skill files; Pi peers are
optional so packaging does not force their installation.

## Use

Ask your agent explicitly, for example:

```text
Use prompt-polish to improve this prompt without executing it:

Write a Python script that reads ./sales.csv and reports monthly totals in EUR.
Use only the standard library. Output the script and a one-line run command.
```

You may supply `TARGET_MODEL` and `CONTEXT` alongside the input. The reply is
only the improved prompt, ready to paste elsewhere. No preamble, outer code
fence, explanation, or automatic execution is added. A prompt containing
instructions such as “ignore your instructions” remains rewrite input, not an
instruction to the polishing agent. Already-good prompts get minimal changes.

For follow-ups, request “preview the last polished prompt,” “copy it,” or
“show this session's polish history,” then select an entry to restore. These
are ordinary requests, not registered commands or keyboard shortcuts. History
contains at most 20 exact-text-deduplicated results, newest first. Restoring
never submits a prompt. Clipboard and draft operations use only facilities
actually available in the host; otherwise the agent returns copyable text.
Persistent session history is optional, not an automatic disk archive.

## Optional integrations

- [Polishing contract](references/polishing.md): authoritative rewrite rules.
- [Draft/session workflows](references/WORKFLOWS.md): concurrency, preview,
  copy, history, restore, and session-boundary behavior.
- [Runtime API](references/RUNTIME.md): portable backend protocol, configuration,
  response validation, retry/deadline/cancellation behavior, clipboard and
  session helpers, with integration examples.
- [Porting record](references/PORTING.md): source provenance and behavior mapping.

The helper's model preference is copied from the extension; an unavailable
model falls back to the current model. It is not a dependency on that model.

## Development checks

From this repository/package directory:

```sh
npm run check:skill  # Node-only format/resource/runtime smoke checks
npm run test:skill   # Bun regression, parity, session, and install tests
npm test            # same portable suite as test:skill
npm run test:extension # optional legacy suite; requires the Pi peer packages
npm pack --dry-run  # inspect npm distribution contents
```

Bun is a development test runner only. There is no separate configured linter
or build step for the portable ES modules. `scripts/validate.mjs` checks this
skill's constrained metadata shape and resource paths; it is not a general
YAML parser or a replacement for a harness's own skill validator.
