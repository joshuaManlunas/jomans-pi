# Herdr Squad Recipes

Sample invocations and prompts for standing up Claude Code, Codex, Cursor, and Pi squads with `herdr-meshed-agents`, then putting them to work.

## How a squad is composed

A squad has three independently chosen parts:

| Part | Chosen by | Options |
| --- | --- | --- |
| Orchestrator | The agent you invoke the skill from (the current executor) | Claude Code, Codex, Cursor, or Pi, in a herdr-core terminal (`HC_TERMINAL_ID` set) |
| Workers | `worker_count`, `worker_model[:effort]`, `--kind`, `--effort` | 1 or more; every Worker shares one kind, one model, and one effort |
| Oracle | `--oracle`, `--oracle-model[:effort]`, `--oracle-effort` | None, or exactly one Claude Code, Codex, Cursor, or Pi advisor with its own model and effort |

Constraints worth knowing before you pick a recipe:

- **The count excludes everyone else.** `worker_count` counts Workers only. A complete squad of the current executor, 2 Workers, and 1 Oracle has 4 members.
- **`--kind` never switches the executor.** It sets the harness of every Worker, so one run has one Worker kind. Get a mixed team by making the executor, the Workers, and the Oracle different kinds.
- **The Oracle is independent.** `--oracle` picks its harness and `--oracle-model` its model; `--oracle-model` alone infers the harness from the model family. Omit the model and that harness keeps its own default, whatever the Workers use.
- **Kinds are inferred.** Without `--kind`, GPT/`codex`/`o<digit>` models run on Codex and Claude-family models on Claude Code; anything else defaults to Claude Code. Pi runs only when you write `--kind pi` or `--oracle pi`.
- **Effort rides with the model.** `gpt-6.1-sol:high` means model `gpt-6.1-sol` at high effort (Codex `model_reasoning_effort`, Claude `--effort`, Pi `--thinking`). Cursor has no effort flag; pick a Cursor model slug that encodes it.
- **Names are chosen at runtime.** Workers get Star Wars names (`leia`, `yoda`, ...), the orchestrator becomes `orchestrator` (or `orchestrator2`, ...), and the Oracle becomes `oracle` (or `oracle2`, ...). Each pane header and Agents row shows the name (`leia · worker`) once `herdr-mods/install.mjs` has run; the standup runs it if needed. Read the final Squad Roster before you address anyone by name.
- **Models.** Claude Code takes aliases such as `sonnet`, `opus`, `fable` or a full model ID (`claude-fable-5-1`). Codex takes a model name such as `gpt-6.1-sol` (needs `codex login`). Cursor takes an ID from `cursor-agent --list-models` (for example `composer-2.5`). Pi takes a fully qualified `provider/id` from `pi --list-models` whose provider passes `pi auth check`. Omit the model and each harness keeps its default.
- **Standup only.** The skill stands up and verifies the mesh, then stops at READY. No project work starts until you send a separate assignment.

## Selector vs executable

`--kind` and `--oracle` take a harness selector, not an executable name. Only these four selectors exist:

| Selector | Harness | Executable behind it | Role file delivered as |
| --- | --- | --- | --- |
| `claude` | Claude Code | `claude` | `--append-system-prompt-file` at launch |
| `codex` | Codex CLI | `codex --no-daemon` | initial prompt at launch |
| `cursor` | Cursor CLI | `cursor-agent` (also installed as `agent`) | first message after launch |
| `pi` | Pi | `pi` | `--system-prompt` at launch |

Write `--kind cursor`, never `--kind agent` or `--kind cursor-agent`; any other value is rejected before a terminal is created. The separate cmux `/meshed-agents` extension stays Pi-only and takes none of these flags.

## Executor invocation forms

The skill takes `[worker_count] [worker_model[:effort]] [--kind claude|codex|cursor|pi] [--effort level] [--oracle claude|codex|cursor|pi] [--oracle-model slug[:effort]] [--oracle-effort level]`. The same `<arguments>` work from every executor; only the way you start the skill differs. The skill sets `disable-model-invocation: true`, so Pi and Claude Code start it with a slash command, not a plain-language request:

```text
/skill:herdr-meshed-agents <arguments>
/herdr-meshed-agents <arguments>
Read <HERDR_MESH_SKILL_DIR>/SKILL.md and stand up a squad with the arguments: <arguments>
```

These are the Pi slash form, the Claude Code slash form, and the plain request for Codex and Cursor executors (their slash-skill syntax is not relied on). A natural-language description ("3 gpt-6.1-sol:high workers with a claude-fable-5-1:medium oracle") is translated into these arguments before parsing. `<HERDR_MESH_SKILL_DIR>` is the absolute path of this skill's directory.

## Canonical argument combinations

Every executor works with every Worker kind and Oracle choice. The arguments depend only on the Worker and Oracle choice, so these copy-ready lines cover the common shapes, shown in the Claude Code form (Pi's adds `skill:`). Each uses 2 Workers, and the Oracle's model and effort are independent of the Workers'.

```text
/herdr-meshed-agents 2
/herdr-meshed-agents 2 sonnet
/herdr-meshed-agents 2 sonnet --oracle-model opus:high
/herdr-meshed-agents 2 gpt-6.1-sol:high
/herdr-meshed-agents 2 gpt-6.1-sol:high --oracle-model claude-fable-5-1:medium
/herdr-meshed-agents 2 sonnet:medium --oracle-model gpt-6.1-sol:xhigh
/herdr-meshed-agents 2 gpt-6.1-sol --effort low --oracle codex --oracle-effort max
/herdr-meshed-agents 2 composer-2.5 --kind cursor
/herdr-meshed-agents 2 composer-2.5 --kind cursor --oracle-model opus
/herdr-meshed-agents 2 sonnet --oracle cursor --oracle-model composer-2.5
/herdr-meshed-agents 2 openrouter/openai/gpt-6.1-sol:high --kind pi
```

The first line uses the Claude Code default model. The `gpt-*` lines run on Codex by inference. The last line runs only when Pi is wanted explicitly and its provider passes `pi auth check`.

Squad size grows with the count: `n = W + 1 (+1 with an Oracle)` members and `n × (n − 1) / 2` verified pairs. The commands above (2 Workers + Oracle) make 4 members and 6 pairs; 4 Workers + Oracle makes 6 members and 15 pairs.

## Codex members

Codex has no system-prompt-file or `--name` flag. The helper therefore starts each Codex Worker or Oracle with `codex --no-daemon -C <caller folder> -c suppress_unstable_features_warning=true -m <model> -c model_reasoning_effort="<effort>" "<role bootstrap>"`, which carries the role bootstrap as the initial prompt so it can't be dropped while Codex boots. The member reads only its role file and reports `ROLE_LOADED <role> FROM <name> PATH "<path>"` to the orchestrator with `hc send`. The orchestrator validates that tagged message (`role-loaded --from <terminal>`) before any pair test or READY. `--no-daemon` is required, or Codex commands run outside hc. Codex's sandbox allows the `hc send` and evidence-file writes the protocol needs.

## Cursor members

Cursor's CLI has no system-prompt or `--name` flag, so the skill starts a Cursor Worker or Oracle with the helper's `["cursor-agent"]` argv in a pane created by `herdr-app do pane.split --pane <pane> --argv ...` and then loads its role file in conversation. The member must report `ROLE_LOADED <role> FROM <name> PATH "<path>"` (the exact role-file path as a quoted string) to the orchestrator with `hc send` before any pair test or READY, and the final report says the role was loaded in conversation, not injected as a system prompt. Cursor may show trust, approval, or authentication prompts; the orchestrator asks you before answering them. Omit the model to preserve your configured Cursor default (`auto` is only one example of a default). Effort may be encoded in a model slug, so `--effort` is rejected for Cursor and the skill never rewrites a model to change thinking.

## Recipes by purpose

### Smallest working squad

One Worker on the harness default. Good for checking a fresh install end to end.

```text
/herdr-meshed-agents 1
```

### Everyday pair

Two Workers, no Oracle. The default when you just want parallel hands.

```text
# 2 Claude Code Workers, default model
/herdr-meshed-agents

# 2 Codex Workers on gpt-6.1-sol at high effort
/herdr-meshed-agents 2 gpt-6.1-sol:high
```

### Cross-harness second opinion

Workers on one harness, the Oracle on another. Models are chosen independently of harnesses, so pick the Oracle's model to differ from the Workers' when you want a different view; the same provider can serve both harnesses.

```text
# Codex does the work, Claude Code on fable advises
/herdr-meshed-agents 3 gpt-6.1-sol:high --oracle-model claude-fable-5-1:medium

# Claude Code does the work, Codex advises at max effort
/herdr-meshed-agents 3 sonnet --oracle-model gpt-6.1-sol:max
```

### Cheap hands, strong advisor

Fast, low-cost Workers for volume; a top model reserved for decisions.

```text
/herdr-meshed-agents 4 haiku --kind claude --oracle claude --oracle-model opus
```

### Heavyweight review squad

Strong Workers and a strong Oracle for security-sensitive or hard-to-reverse changes.

```text
/herdr-meshed-agents 3 opus:high --oracle-model gpt-6.1-sol:xhigh
```

### Cursor-based squads

```text
# Cursor Workers, default model, no Oracle
/herdr-meshed-agents 2 --kind cursor

# Claude Code does the work, a Cursor Oracle advises
/herdr-meshed-agents 3 sonnet --kind claude --oracle cursor --oracle-model <cursor-model>

# Cursor does the work, Claude Code on opus advises
/herdr-meshed-agents 3 --kind cursor --oracle claude --oracle-model opus
```

### Fully mixed team

A Claude Code orchestrator, Codex Workers, and a Cursor Oracle: three harnesses in one squad.

```text
/herdr-meshed-agents 2 gpt-6.1-sol:high --oracle cursor --oracle-model composer-2.5
```

### Invocations the helper rejects

These fail before any pane is created, with the helper's message reported verbatim:

```text
# model without a count
/herdr-meshed-agents sonnet
# count must be positive
/herdr-meshed-agents 0
# an Oracle model that names no known family needs --oracle
/herdr-meshed-agents 2 --oracle-model mystery-model
# --kind must be claude, codex, cursor, or pi
/herdr-meshed-agents 2 --kind agent
# effort given twice
/herdr-meshed-agents 2 gpt-6.1-sol:high --effort low
# Cursor has no effort flag
/herdr-meshed-agents 2 composer-2.5 --kind cursor --effort high
```

## Prompts after READY

Send these to the orchestrator once the final report says `Operational`. Substitute the Worker names from the Squad Roster.

### Assign work

```text
Squad assignment. Objective: add rate limiting to the public API.
- leia: implement the token-bucket middleware in src/middleware/ with unit tests.
- yoda: add integration tests in tests/api/ covering the 429 path and headers.
Don't modify src/routes/. Done means all tests pass and lint is clean.
Report each worker's outcome, files changed and verification results.
```

### Let the orchestrator decompose

```text
Squad assignment: migrate the settings screen from class components to hooks.
Decompose it, delegate to the workers with non-overlapping file ownership,
review and integrate their output, and report when the full test suite passes.
```

### Set worker thinking levels

```text
Squad assignment: fix the intermittent deadlock in the job scheduler.
Put leia on the investigation at max thinking. Keep yoda on default thinking
writing a reproduction test. Raise yoda only if the test can't reproduce it.
```

```text
yoda's last output missed the edge cases. Re-dispatch the same brief at a
higher thinking level before rewriting it, and tell me which level you used.
```

### Consult the Oracle

```text
Before assigning the caching work, consult the Oracle on Redis versus
in-process LRU for our session store. Give it the constraints: two app
instances, a 50 ms p99 budget, no new infrastructure this quarter.
Share its recommendation and your decision with the rationale.
```

```text
leia and yoda disagree on the error-handling approach. Get the Oracle's
tiebreak, decide, and record why.
```

### Cross-review between harnesses

With a Claude Code orchestrator and Codex Workers (or the reverse), each side checks the other:

```text
Have leia implement the parser and yoda review leia's diff against the spec
before you integrate. Then ask the Oracle whether the review missed anything
in the error paths.
```

### Status and wrap-up

```text
Squad status: what's each worker doing, what's blocked, and what's left?
```

```text
Wrap up: confirm every assignment is integrated and verified, list any
unverified areas, and leave the squad running.
```
