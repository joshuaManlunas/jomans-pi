---
name: fleet
description: Delegate user-invoked execution to workers (Orca orchestration in Pi inside Orca, native otherwise), then review, integrate, and synthesize. `setup` configures the worker model.
disable-model-invocation: true
---

# Fleet

The invoking executor is the **orchestrator and adviser**. It owns goal
framing, decomposition, worker prompts, judgment, independent validation,
integration, and synthesis. It delegates almost all task execution without
waiting for a reminder.

## Setup mode

When the first word of the arguments is `setup` or `--setup`, read
[Fleet setup](references/setup.md) and follow it in place of every section
below. Setup edits the worker profile locally and dispatches no workers.

## Delegation rule

After minimal scoping, dispatch at least one worker through the selected
runtime route for every actionable workstream, including a single-workstream
task. Workers own
repository discovery, research, implementation, repair, tests, and the
commands needed for their assignment. Keep local work to orchestration,
independent review and validation, and the smallest integration or conflict
resolution needed to combine worker results. Re-dispatch substantive fixes.

Respect an explicit user override such as “do this yourself” or “no
delegation.” A status, coordination, or final-synthesis turn needs no new
worker when no execution remains. Select the runtime route below before checking
worker availability. If that route is unavailable, report the exact blocker
rather than silently executing the assignment, switching routes or models,
or creating a thread.

Fleet scope persists for the active task and its continuations until the user
overrides it. A worker failure or an incomplete result is a reason to
re-dispatch, not to take over the work. Retry a failed assignment once with a
concrete correction. If the same blocker persists, report the evidence and ask
for the decision needed to unblock that workstream; continue independent work.
Further retries require new evidence or a changed prerequisite. This does not
authorize direct execution, a model change, or a separate thread.

## Runtime routing — select once before dispatch

In Pi, run `node <skill-dir>/scripts/dispatch-route.mjs`, substituting this
skill's directory for `<skill-dir>`. The probe only prints a route; it never
spawns workers. It uses Pi's CLI/RPC marker `PI_CODING_AGENT=true` and the same
non-empty `ORCA_PANE_KEY` guard as Orca's managed Pi extensions. A non-empty
`CLAUDECODE` takes precedence so an inherited Pi marker cannot change Claude
Code's existing path. Other hosts keep the native path without this probe.

- **`orca`** — Read [Orca dispatch](references/orca.md), load the discovered
  `orchestration` skill, and use its version-matched supervised worker loop.
  This is the spawning path, not a fallback for a missing native tool. Skip
  native dispatch and the Claude Code subsection below on this route.
- **`native`** — Use the existing config/native dispatch and Threads guidance
  below, unchanged. Do not load or invoke Orca orchestration on this route.
- **Probe failure or unexpected output** — Stop and report the exact error;
  no dispatch has been authorized.

Keep exactly one route for the active task, including follow-ups and retries.
Never execute both routes for a workstream or fall back after an Orca error or
uncertain start. Resolve that attempt using the orchestration skill's recovery
contract before any retry; it takes precedence over the generic retry rule.
The presence of an Orca executable, a running app, or other Orca variables alone
is not evidence that this Pi session is Orca-managed.

Validation: `node --test <skill-dir>/tests/dispatch-route.test.mjs`. Runtime
contract sources and Orca-specific checks are in [Orca dispatch](references/orca.md).

## Config and native dispatch

Read `config.json` beside this skill before dispatching and preserve its worker
profile:

- Read `model`, `provider`, and `thinking` from config. Select that exact
  model through the configured provider; for Pi, the fully qualified selector
  is `<provider>/<model>`. Set `reasoning_effort` to `thinking` for native
  tools, or the runtime equivalent. If the runtime cannot select
  this provider/model and effort, report the blocker instead of substituting.
- Use `fork_turns: "none"` by default, or a bounded positive value when a
  bounded inherited prefix materially helps the assignment.
- Worker speed inherits the host default. Omit speed and service-tier
  overrides from native worker and thread calls.

Keep the current session model for orchestration. Do not replace it with the
worker profile.

### Claude Code

Claude Code sets the `CLAUDECODE` environment variable. Before dispatching,
check it with `printenv CLAUDECODE`. When it is non-empty, use
`config.json` → `claudeCode` in place of the profile above:

- Dispatch with the `Agent` tool and `subagent_type` set to one of the
  `claudeCode.workers` definitions in `~/.claude/agents/`. Each one pins
  its worker model in `model:` and a fixed `effort`.
- Omit the Agent tool's `model` parameter. A per-call `model` overrides the
  worker definition, and the `sonnet` alias can resolve to an older model on
  other providers.
- The Agent tool has no per-call effort parameter, so the worker you choose
  sets the effort. Pick it separately for each assignment:
  - `low` for mechanical edits, lookups, and renames.
  - `medium` for routine, well-specified implementation.
  - `high` for multi-file changes or unclear debugging.
  - `xhigh` for subtle correctness, concurrency, security, or architecture
    work.

  Never exceed `claudeCode.maxThinking`. Record the chosen level in the
  Dispatch output.
- Codex-only fields (`reasoning_effort`, `fork_turns`, the `[1m]` suffix) do
  not apply. If a worker definition is missing, report that blocker.

## Workflow

1. **Scope** — Actionable goal, constraints, affected surface, definition of done; inspect only enough to split work.

2. **Decompose** — Parallelize independent workstreams; queue dependents until prerequisites exist. One worker per workstream; queue overflow as slots free. Workers must not run Fleet or spawn sub-workers.

3. **Dispatch** — Use only the selected runtime route: Orca dispatch per `references/orca.md`, or native `spawn_agent` (Claude Code: `Agent` with a Fleet worker `subagent_type`). Give self-contained prompts (goal, scope, constraints, success check, return path). On the native route, pass configured model, reasoning, and fork on every call (in Claude Code, the worker definition carries them). Launch independent workers together; record worker IDs before deep work.

4. **Coordinate** — Hub-and-spoke through the orchestrator: wait, answer questions, deliver prerequisites, follow up on weak or failed work.

5. **Review and integrate** — Inspect every result and changed file; run minimal checks; re-dispatch fixes to the same worker profile.

6. **Synthesize** — Report result, evidence, blockers, and next action with dispatch IDs, tasks, models, and any overrides.

## Threads

This section applies only to the native route. Native workers are the default.
Use Codex threads only when the user explicitly asks for separate or new tasks
and the host permits thread
creation. Fleet cannot self-authorize thread creation or use threads as an
automatic worker fallback. Preserve the configured model and thinking when a
user-authorized thread is created. Establish communication first: require an
exact `READY` handshake, wait for it, then deliver the full assignment. Treat
the thread as dispatched only after the assignment succeeds and the thread
has a working return path.

## Output

1. Plan — goal, workstreams, dependencies, and checks.
2. Dispatch — selected route, worker ID (Orca: Task and Dispatch IDs), task, effective model/reasoning, and exceptions.
3. Results — worker evidence, validation, integration status, and blockers.
4. Next action — only if work remains or the user must decide.
