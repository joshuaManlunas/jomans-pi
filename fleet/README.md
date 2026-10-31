# Fleet skill

An [Agent Skill](https://agentskills.io/specification) that makes the invoking
agent an orchestrator: it scopes a task, dispatches workers, reviews their
results, and synthesizes them. It routes through Orca orchestration in an
Orca-managed Pi session, and native subagents everywhere else. In Claude Code,
workers are the `fleet-worker-*` agent definitions in `claude-code/agents/`,
or, in T3 Code, any model T3 offers through `delegate_task` when
`claudeCode.delegate` is set.

## Install

```sh
node /path/to/fleet/scripts/install.mjs ~/.agents/skills --claude-agents ~/.claude/agents
```

This copies the skill to `<skills-directory>/fleet` and, with
`--claude-agents`, the worker definitions into that agents directory. Leave
out `--claude-agents` on hosts other than Claude Code. The installer checks
every target first and refuses to overwrite anything, so a conflict leaves
nothing half-installed. Agent definitions load at session start, so open a new
session afterwards.

## Use

- `/fleet <task>` orchestrates the task through workers.
- `/fleet setup` (or `--setup`) walks you through choosing the worker model
  and effort, then updates `config.json` and the worker definitions.

The worker profile is `config.json` (Codex/Pi: `model`, `provider`,
`thinking`; Claude Code: `claudeCode`, including the optional `delegate`)
together with the installed `fleet-worker-*.md` files.

## Development

```sh
npm test   # route probe, SKILL.md contract, and installer tests (Node 20+)
```
