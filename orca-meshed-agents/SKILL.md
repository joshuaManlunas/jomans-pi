---
name: orca-meshed-agents
description: "Explicitly stand up a configurable meshed team in Orca with each member as its own supervised Orca orchestration worker (a Dispatch on one Run owned by the current terminal), an optional Oracle, and independently selected worker agents and models. Orca only; not Herdr, ordinary subagent requests, or unsupervised handoffs."
disable-model-invocation: true
---

# Orca Meshed Agents

Invoke `/orca-meshed-agents` (Claude Code) or `$orca-meshed-agents` (Codex) with the flags below, or explicitly ask to read this file and stand up the team. Run it from an agent inside an Orca terminal. That terminal is the orchestrator and owns one Orca Run; its tab is renamed `<squad name> -- Orchestrator` (fallback `Orchestrator` when no name is given), and each member's tab `<squad name> -- <Name> (Worker)` or `<squad name> -- Oracle`. Start only workers (named after Star Wars characters) and the optional Oracle, each with `orca orchestration worker-start` as its own supervised worker on that Run. Never use `orca worktree create --agent`, `orca agent launch`, `orchestration dispatch --inject`, or a non-Orca subagent tool for members. Every member, orchestrator included, messages every other member directly by mailbox address: members are `dispatch:<dispatchId>`, the orchestrator is `run:<runId>`. Supervision sets ownership, not routing.

## Configure and preflight

Resolve `ORCA_MESH_SKILL_DIR` to the directory containing this loaded `SKILL.md`; `orca-mesh.mjs` lives beside it. Use absolute paths, independent of the checkout. Require Node.js ≥18.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--squad NAME` | Unset | Squad name from step 3, used as the tab-title prefix; omit when the user gave none. |
| `--workers N` | `4` | Positive worker count, excluding orchestrator and Oracle. |
| `--worker-model agent[:model][,...]` | `codex:gpt-6.1-sol` | One selection for all workers, or exactly N selections in worker order. |
| `--worker-effort L[,L...]` | Unset | Launch effort: one level for all workers, or exactly N. Each needs an explicit model. |
| `--oracle agent[:model]` | `codex:gpt-6-astra` | Independent Oracle selection. |
| `--oracle-effort L` | Unset | Oracle launch effort; needs an explicit Oracle model. |
| `--no-oracle` | Unset | Omit Oracle; mutually exclusive with `--oracle` and `--oracle-effort`. |
| `--prompts-dir DIR` | This skill directory | Existing `orchestrator.md`, `workers.md`, and, with Oracle, `oracle.md`. |

Split selections at the first colon: `agent` is an Orca agent id enabled on this host (such as `claude`, `codex`, `cursor`, `antigravity`, `muse`, `opencode`), and the remaining text is the exact opaque provider model ID. A bare `agent` omits `--model`, so that member runs its agent's configured default. Never substitute unavailable agents, models, or efforts: Orca has no listing for them and validates at launch, so if `worker-start` refuses one or its receipt's `launch.effective` differs from the request, stop and ask the user. Runs live in `.orca-mesh/` at the workspace root (the git root when there is one, else the current directory), which survives reboots and ignores itself via its own `.gitignore`; `$ORCA_MESH_ROOT` overrides that location.

Examples, after resolving the skill directory and binding the Run (run only the requested configuration):

```bash
node "$ORCA_MESH_SKILL_DIR/orca-mesh.mjs" plan --orca-run "$ORCA_RUN_ID" --orca-cli orca
node "$ORCA_MESH_SKILL_DIR/orca-mesh.mjs" plan --orca-run "$ORCA_RUN_ID" --orca-cli orca --squad Hedwig --workers 2 --worker-model codex:gpt-6.1-sol,claude:claude-sonnet-5-5 --oracle codex:gpt-6-astra
node "$ORCA_MESH_SKILL_DIR/orca-mesh.mjs" plan --orca-run "$ORCA_RUN_ID" --orca-cli orca --no-oracle --workers 2
```

1. Resolve the Orca executable once, as the `orchestration` skill does: `ORCA_CLI_COMMAND` if set; otherwise `orca-dev` in a dev checkout exposing `ORCA_DEV_REPO_ROOT`; otherwise `orca-ide` on Linux outside an Orca terminal (never bare `orca` there); otherwise `orca`. Below, `ORCA` means that executable; substitute it, and pass it to `plan --orca-cli`. If it cannot run, report its exact error and stop.
2. Run `ORCA status --json`; if Orca is not running, run `ORCA open --json` and retry. If a command fails with `runtime_access_denied`, re-run it with escalated permissions instead of restarting Orca. Load the version-matched guide with `ORCA skills get orchestration` and keep its safety floor for the whole run; this skill only adds the mesh protocol on top of it. If orchestration commands are refused as disabled, tell the user to enable orchestration in Orca Settings → Experimental and stop. If the current agent is in a read-only or plan mode, stop and tell the user to switch to its default mode.
3. Ask for the squad name (`AskUserQuestion` in Claude Code, or a plain question otherwise); if none is given, fall back to `Orchestrator`. In the same question, state the resolved agent/model/effort for every member. The defaults in the table are this skill's named models and deliberately count as explicit selections: Orca's guide otherwise omits `--model` unless the user names one. The user can still switch any member to a bare agent.
4. Read the selected prompts directory's `orchestrator.md` completely and adopt its guidance for this run, subject to repository and safety rules. Keep the current model. Role guidance is loaded conversationally, not injected as a system prompt. Ignore role-file instructions to drive other harness CLIs: use Orca orchestration commands throughout. Effort is set only at launch, as described below.

## Stand up across message waits

Use the helper for plans, names, rosters, bootstraps, resends, tokens, retry IDs, commands, and matrices. Generate none of those by hand in the shell; zsh arrays are 1-based. Each helper entry carries `argv` and a shell-quoted `command`; run it verbatim and never splice values into it yourself. Save receipts through a safe file writer or `> <save path>` redirection, without shell interpolation.

**Waiting.** Wherever a step says *wait*, process the Run inbox as the orchestration guide's coordinator loop does:

```text
ORCA orchestration check --wait --types "status,worker_done,escalation,question" --timeout-ms 300000 --json
ORCA orchestration check --ack <delivery_id> --wait --types "status,worker_done,escalation,question" --timeout-ms 300000 --json
```

Keep `--timeout-ms` below your shell tool's command limit. Process every message in a returned Delivery, then acknowledge that whole batch with `--ack` on the next check. Before ending any turn, acknowledge the last processed Delivery (`ORCA orchestration check --ack <delivery_id> --json`) so no batch stays outstanding. Members follow the same drain rule, written into their standby and bootstrap files: Orca will not wake an agent for new mail while one of its Deliveries is unacknowledged. A timeout or empty result is a checkpoint, not a failure. Protocol envelopes arrive as `status` mail: the subject carries the envelope line and, for multi-line envelopes, the body carries the full envelope. During standup, a member's `worker_done` or `escalation` means its membership ended or is blocked; treat it as a blocker for that member and follow the guide's recovery reference.

1. **Bind and plan.** Run `ORCA orchestration run-create --objective "Meshed agent squad: <squad name>" --json` once. Retain the Run id (`result.run.id`) and your own terminal handle (`result.run.coordinator_handle`). Run `plan` with `--orca-run <run id>`, `--orca-cli <ORCA>`, `--squad <squad name>` when one was given, and the requested flags, once. Retain printed `run`, `dir`, and `workerStarts`; the helper writes `<dir>/plan.json` and one `standby-<name>.txt` per member. For each entry, run its `command` (a `worker-start` with a standby `--spec`, `--task-title`, `--worktree current`, `--agent`, optional `--model`/`--effort`, a stable `--retry-request`, and `--json`); these starts are independent, so issue them together. Add no placement or setup overrides, so members share the orchestrator's workspace. Save each command's raw JSON stdout to that entry's `save` path (`start-<name>.json`), whether it succeeded or not.
   The standby task only loads the role file and checks Orca messaging; its `STANDBY <run> FROM <name> tools=ok` mail is a tool check, not a gate. `tools=missing` is a blocker for that member.
   `worker-start` exits 0 only for `ready`. If one exits non-zero or its result is uncertain, never relaunch under a new request: read the receipt's `failedStage` and `residualResources`, check `ORCA orchestration request-show --request <retryRequest> --json`, re-run the same `command` (same `--retry-request`) only when Orca reports the request `pending`, and otherwise load the guide's `references/recovery-and-cleanup.md`. Report partial starts.
2. **Bootstrap.** Run:

   ```bash
   node "$ORCA_MESH_SKILL_DIR/orca-mesh.mjs" bootstrap --run "$ORCA_MESH_RUN"
   ```

   Set the variable from the retained `run`. Bootstrap reads the saved `start-<name>.json` receipts. It validates `state: ready`, the bound Run id, unique `dispatchId`s and `taskId`s, the launched agent, and any requested model/effort against `launch.effective`; stop on mismatch. Carry its `warnings` (agent verified only from `launch.requested`, unresolved terminal handle) into the roster. Retain its `members`, each containing `address` (`dispatch:<dispatchId>`), `dispatchId`, `taskId`, `handle`, `title`, a `rename` command (null when the handle is unresolved), and `boot`, `go`, `ping`, `ready`, and `disband` send commands, plus `orchestrator.title`. Run each non-null `rename` command first: Orca labels worker tabs `worker-<taskId>` regardless of `--task-title`, so without it the user cannot tell members apart. Report a refused or skipped rename; it is never a gate. Then run each `boot` command. **Wait.** Members perform setup and communication only until READY; no repository exploration, tests, or edits.
3. **Verify role receipts.** As `BOOT_ACK <run> FROM <name> TO orchestrator role=<Role> sha256=<hash> model=<model>` arrives, validate run/name/role against `plan.json`, hash against that member's planned sha256, and model against its planned model, if one was planned; otherwise record the reported model. Corroborate with `ORCA orchestration worker-show --dispatch <dispatchId> --json`: the Dispatch is that member's and still active. Treat a failed or missing gate as a blocker; start pair checks only when every member passes.
4. **Start pairs.** Run every retained `go` and `ping` command; the `ping` is the orchestrator's own PING to that member. Record only ACKs actually received, matching run, exact token, sender, and recipient against `pairs.json`/`roster.json`. **Wait.** Members ping peers directly at their `dispatch:` addresses; relaying through the orchestrator cannot verify a mesh.
5. **Collect evidence.** Append every received `PAIR_REPORT` line verbatim to `<dir>/reports.log`. When all orchestrator outbound ACKs arrive, append its own report using the actual received tokens:

   ```text
   PAIR_REPORT <run> FROM orchestrator complete=true acks_received=[token,...] pings_answered=[]
   ```

   Members report `complete=true` only after all outbound ACKs arrive and all inbound PINGs are answered, including zero-outbound members. Accept PING/ACK only when run/token/sender/recipient match the assigned pair; ignore and log mismatches. Re-ACK duplicate valid PINGs; repeated GO resends only unacknowledged PINGs. Never ACK an ACK or fabricate another member's receipt.
   Replay versus resend: re-run a retained command unchanged only to recover a send whose result was lost; its stable `--retry-request` replays the recorded outcome and enqueues nothing new. To deliberately send a protocol message again (a repeated GO, PING, READY, or BOOTSTRAP), run `node "$ORCA_MESH_SKILL_DIR/orca-mesh.mjs" resend --run "$ORCA_MESH_RUN" --name <member> --kind <boot|go|ping|ready|disband> --round <n>`, using a new round number each time, and run its `command`. The envelope is identical; only the retry ID is fresh.
   If progress stalls, send `PAIRS_STATUS? <run>` directly to missing members' `dispatch:` addresses (`ORCA orchestration send --to <address> --type status --subject "PAIRS_STATUS? <run>" --json`), then wait. After three consecutive empty waits, run `ORCA orchestration worker-list --run <run id> --json` and act only on positive evidence, as the guide requires; `unverifiable` liveness never authorizes stop, retry, or release. Preserve partial evidence and report unresolved gates after a bounded recovery attempt.
6. **Verify matrix.** Run:

   ```bash
   node "$ORCA_MESH_SKILL_DIR/orca-mesh.mjs" matrix --run "$ORCA_MESH_RUN"
   ```

   Require exit 0, `passed == total == n*(n-1)/2`, and empty `errors`, where n includes the orchestrator and optional Oracle. The helper writes `<dir>/pair-matrix.txt`; PASS requires the sender's `acks_received` and recipient's `pings_answered` for the same exact token. Exit 2 means incomplete or invalid verification: inspect `pairs[].missing` and `errors`, recover evidence, and rerun only after new evidence.
7. **Release and confirm.** After every gate passes, run each retained `ready` command, then wait. Require `READY_ACK <run> FROM <name>` from every member before declaring Operational. Repeated READY is idempotent. Then run `ORCA orchestration worker-list --run <run id> --json` once: every member's row must be live with its Dispatch still active; a member that has settled, exited, or is still working after READY_ACK is a blocker, not Operational. Then rename the orchestrator's own tab with `ORCA terminal rename --terminal <coordinator_handle> --title "<orchestrator.title>" --json`, using bootstrap's `orchestrator.title` (`<squad name> -- Orchestrator`, or plain `Orchestrator` if no name was given). Always pass the retained handle explicitly, because omitting `--terminal` targets whichever tab is active in the worktree. If Orca refuses, report the rename as skipped. List the orchestrator under that title in the roster. Wire messages keep the lowercase `orchestrator` member name. Keep the team idle and available for a later user-authorized assignment.

A successful `send` proves durable enqueue, not receipt. Orca notifies an idle agent when mail reaches its Dispatch mailbox, but only when none of its Deliveries is outstanding, and the notice is best-effort: only an envelope sent back counts as evidence. Members never poll; they drain, end their turn, and wake on mail.

Squad Dispatches stay active while members idle between assignments. This is deliberate and departs from Orca's one-Task-per-unit-of-work loop: membership is the Task, assignments are mail, and `worker_done` arrives only at disband. Do not release, stop, or retry an idle member because it is idle.

## Report and assign next

Return these sections:

1. **Roster** — table of name, role, exact address (`dispatch:<id>` for members, `run:<id>` for the orchestrator), taskId, terminal handle (or unresolved), agent/model/effort (effective, or requested-only per bootstrap `warnings`), role-file path/hash, and readiness; include the current orchestrator and mark Oracle not applicable when omitted.
2. **Communication verification** — n, expected `n*(n-1)/2`, passed pairs, failures, and matrix path.
3. **READY acknowledgments** — received and missing members.
4. **Overall status** — Operational only when role/model, full pair matrix, and every READY ACK pass; otherwise Partially operational or Blocked with exact unmet gates.
5. **Next assignment** — send bounded user-authorized work directly to roster addresses: write each brief to `<dir>/assign-<assignment-id>-<name>.md`, then `ORCA orchestration send --to dispatch:<id> --type status --subject "ASSIGN <run> <assignment-id> FROM orchestrator TO <name>" --body "Read <brief path> completely and follow it." --json`, with a distinct assignment id per member and task. Include ownership, acceptance criteria, and verification in the brief. Require `ASSIGN_ACK` on receipt and a `TASK_REPORT <run> <assignment-id> FROM <name> status=<...>` back to the orchestrator on every terminal state, then wait for them.

Members are supervised workers on the orchestrator's Run that share its workspace, branch, and checkout. Later work goes to their `dispatch:` address via `orchestration send`; their terminal output and final turn text are never protocol evidence, only explicit envelopes are. Members ask blocking questions with their preamble's `orchestration ask`; answer with `ORCA orchestration reply --id <message_id> --body "<answer>" --json`. Assign disjoint files and retain orchestration, integration, and final decisions. Role guidance maps pane/target terms to roster addresses and messaging to `orchestration send`; use Orca orchestration commands throughout.

**Disband** only when the user ends the squad: run each retained `disband` command and wait. Each member sends `worker_done` exactly once; validate it against that member's active Dispatch, then run `ORCA orchestration worker-release --dispatch <dispatchId> --json`. Finish when `ORCA orchestration worker-list --run <run id> --terminal-state reclaimable --json` returns none. To stop one member early at the user's request, run `ORCA orchestration worker-stop --dispatch <dispatchId> --json`. Never substitute `terminal close`.

After READY, consult the Oracle using its loaded `oracle.md` `ORACLE_QUERY`/`ORACLE_ACK`/`ORACLE_RESULT` protocol over direct mail: the header line goes in `--subject`, the full envelope in `--body`. An ACK is receipt, not advice; the orchestrator decides. Orca sets effort only at launch (`worker-start --effort` needs `--model` and cannot reuse a terminal), so a running member's effort cannot be raised in place. To run work at a higher level, start a separate supervised worker for that task with the same model and a higher `--effort`, using the guide's normal `worker-start --spec` loop. That worker settles with its own `worker_done` and is not a mesh member. Never change models to simulate effort.

For helper validation without launching workers, run:

```bash
node "$ORCA_MESH_SKILL_DIR/orca-mesh.mjs" selftest
```
