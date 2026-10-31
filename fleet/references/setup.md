# Fleet setup

Setup configures the worker profile. Run it locally with no workers, and do
not run runtime routing or the Fleet workflow. Ask questions with the host's
interactive question tool (Claude Code: `AskUserQuestion`) when one exists,
and as plain chat questions otherwise.

The worker profile lives in two places:

- **Claude Code**: the `model:` and `description:` frontmatter of each agent
  named in `config.json` → `claudeCode.workers` (in `~/.claude/agents/`). The
  `claudeCode.maxThinking` field caps the worker effort. `claudeCode.model`
  mirrors the agent files and is not read during dispatch. In T3 Code, an
  optional `claudeCode.delegate` (`providerInstanceId`, `model`,
  `effortOption`) sends workers to that model through `delegate_task` in
  place of the agent files.
- **Codex / Pi**: the top-level `model`, `provider`, and `thinking` fields of
  `config.json`.

## Steps

1. **Read the current profile.** Read `config.json` and every worker agent
   file. Show the user the current Claude Code model, any `claudeCode.delegate`,
   and `maxThinking`, and
   the current Codex/Pi `provider`/`model` and `thinking`. If the agent files
   disagree with each other or with `claudeCode.model`, point that out. A
   missing worker file is a blocker: report it and stop.
2. **Pick the profile.** Ask whether to configure Claude Code workers,
   Codex/Pi workers, or both. Recommend the current host's profile
   (`printenv CLAUDECODE` is non-empty in Claude Code).
3. **Pick the model.** For each chosen profile, ask which model to use. Put
   the current model first, and allow a free-form answer.
   - Claude Code: offer the latest Claude model IDs from your environment
     info. A Claude model needs a full model ID such as `claude-opus-5-5`.
     Reject aliases (`sonnet`, `opus`) and the `[1m]` suffix, and ask again.
     Choosing a Claude model goes in the agent files and removes
     `claudeCode.delegate`.
   - Claude Code with a non-Claude model: this needs T3 Code's
     `orchestrator_capabilities`; without it, explain that the agent files
     only accept Claude models and ask again. Search it for the model, and if
     more than one provider instance offers it, ask which one to use. Record
     that `providerInstanceId`, the model `id`, and the `id` of the model's
     effort option (for example `reasoningEffort`) as `claudeCode.delegate`.
     Leave the agent files as they are.
   - Codex/Pi: ask for the model and its provider together, defaulting to the
     current provider. Store `model` without the provider prefix. Pi's
     selector is `<provider>/<model>`.
4. **Pick the effort.** Ask only where the profile uses it, with the current
   value first.
   - Claude Code: `maxThinking`, which must be one of the `claudeCode.workers`
     keys. With a delegate, it must also be one of the effort option's
     values.
   - Codex/Pi: `thinking`, which must be an effort level the runtime accepts.
5. **Show the changes.** List every file and field you will change, with its
   old and new value:
   - Claude Code: in each worker file, `model:` and the model name in
     `description:`. For example, `claude-opus-5-5` gives
     `Fleet worker (Claude Opus 5.5, high effort)`; keep each file's own
     effort. In `config.json`, `claudeCode.model` (set to the agent files'
     model ID), `claudeCode.delegate` (added, changed, or removed), and
     `claudeCode.maxThinking`.
   - Codex/Pi: `config.json` `model`, `provider`, and `thinking`.
6. **Apply.** Edit only those lines and fields; every other byte stays as it
   was. These files may be symlinks into a git checkout: edit them in place
   with a file-edit tool, not `sed -i`, which replaces a link with a copy.
   Afterwards, re-read the files and confirm that all of the worker files
   and `claudeCode.model` name the same model and that `config.json` is still
   valid JSON.
7. **Report.** List what changed. For Claude Code changes, tell the user that
   agent definitions load when a session starts, so the new model takes
   effect in a new session.

Setup is done when every chosen profile has its new values, the worker files
and `claudeCode.model` agree, and the user has the report.
