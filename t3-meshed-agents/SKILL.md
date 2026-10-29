---
name: t3-meshed-agents
description: "Explicitly stand up a configurable meshed team in T3 Code with each member in its own T3 delegate (child) thread under the orchestrator, an optional Oracle, and independently selected worker models. T3 Code only; not Herdr or ordinary subagent requests."
disable-model-invocation: true
---

# T3 Meshed Agents

Invoke `/t3-meshed-agents` (Claude Code) or `$t3-meshed-agents` (Codex) with the flags below, or explicitly ask to read this file and stand up the team. The current thread is the orchestrator, renamed to `<squad name> -- Orchestrator` (fallback `Orchestrator` when no name is given); spawn only workers (named after Star Wars characters) and the optional Oracle, each with `delegate_task` as its own child thread of this thread. Never use `create_threads` or `t3_thread_launch` for members. Every member, orchestrator included, messages every other member directly by threadId; delegation sets ownership, not routing.

## Configure and preflight

Resolve `T3_MESH_SKILL_DIR` to the directory containing this loaded `SKILL.md`; `t3-mesh.mjs` lives beside it. Use absolute paths, independent of the checkout. Require Node.js ≥18.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--workers N` | `4` | Positive worker count, excluding orchestrator and Oracle. |
| `--worker-model inst:model[,inst:model...]` | `codex:gpt-6.1-sol` | One selection for all workers, or exactly N selections in worker order. |
| `--oracle inst:model` | `codex:gpt-6-astra` | Independent Oracle selection. |
| `--no-oracle` | Unset | Omit Oracle; mutually exclusive with `--oracle`. |
| `--prompts-dir DIR` | This skill directory | Existing `orchestrator.md`, `workers.md`, and, with Oracle, `oracle.md`. |

Split selections at the first colon: `inst` is a providerInstanceId, and the remaining text is the exact model ID. Never substitute unavailable models: if a requested model, or `delegate_task` spawning on it, is unavailable, stop and ask the user. Runs live beneath `$T3_MESH_ROOT` or `/tmp`.

Examples, after resolving the skill directory (run only the requested configuration):

```bash
node "$T3_MESH_SKILL_DIR/t3-mesh.mjs" plan
node "$T3_MESH_SKILL_DIR/t3-mesh.mjs" plan --workers 2 --worker-model codex:gpt-6.1-sol,claudeAgent:claude-sonnet-5-5 --oracle codex:gpt-6-astra
node "$T3_MESH_SKILL_DIR/t3-mesh.mjs" plan --no-oracle --workers 2
```

1. Discover the t3-code MCP tools; load deferred tools through ToolSearch when available. Require `orchestrator_capabilities`, `delegate_task`, `task_status`, and `t3_thread_send`. If absent, make one bounded direct capabilities call before reporting the missing transport. In ACP with `T3_ACP_MCP_NODE`, use the supported `acp-mcp-call` transport for these same tools.
2. Call `orchestrator_capabilities`. If caller `interactionMode` is `plan`, stop and tell the user to switch to default mode. Require delegated tasks and thread messaging. For every requested providerInstanceId, require an existing provider with empty `constraints` and a matching `models[].id`. Delegate threads = workers + optional Oracle; require ≤20 and any delegation limit capabilities advertise.
3. Ask for the squad name (`AskUserQuestion` in Claude Code, or a plain question otherwise); if none is given, fall back to `Orchestrator`.
4. Read the selected prompts directory's `orchestrator.md` completely and adopt its guidance for this run, subject to repository and safety rules. Keep the current model. Role guidance is loaded conversationally in T3, not injected as a system prompt. Ignore role-file harness CLI/launch instructions: use T3 tools, never Pi/Claude/Cursor CLI. Change effort only through the member's own `t3_thread_configure` using capabilities option IDs, as described below.

## Stand up across incoming-message turns

Use the helper for plans, names, rosters, bootstraps, tokens, and matrices. Generate none of those by hand in the shell; zsh arrays are 1-based. Pass JSON through structured tool arguments and save responses through a safe file writer, without shell interpolation.

1. **Plan and delegate.** Run `plan` with the requested flags once. Retain printed `run`, `dir`, and `delegateTasks`; the helper writes `<dir>/plan.json`. For each entry, call `delegate_task` with its `args` verbatim (stable `clientRequestId`, `title`, `target`, `mode="async"`, standby `task`); these calls are independent, so issue them together. Omit runtime/options/isolation overrides so members inherit caller settings and share the checkout. Save each raw response JSON object (containing `taskId`, `childThreadId`, `providerInstanceId`, `model`) to that entry's `save` path (unwrap an MCP content envelope if necessary; preserve returned fields).
   The standby task only loads the role file and checks tools; its `STANDBY <run> FROM <name> tools=ok` completion notification is a tool check, not a gate. `tools=missing` is a blocker for that member.
   If a call fails or its result is uncertain, retry with the same `clientRequestId` (idempotent) or read `task_status`; never spawn a member under a new request ID while an earlier one may exist. Report partial spawns.
2. **Bootstrap.** Capture the caller's exact threadId from `orchestrator_capabilities.parentThreadId` and run:

   ```bash
   node "$T3_MESH_SKILL_DIR/t3-mesh.mjs" bootstrap --run "$T3_MESH_RUN" --orchestrator-thread "$T3_ORCHESTRATOR_THREAD"
   ```

   Set these task variables from retained `run`, caller threadId, and `dir`. Bootstrap reads the saved `delegate-<name>.json` responses and validates presence, unique opaque `childThreadId`s, `taskId`s, and provider/model selections; stop on mismatch. Retain its `members`, each containing `threadId` (the child thread), `taskId`, `boot`, `go`, and `ready` objects with `message` and `clientRequestId`. Send each `boot` through `t3_thread_send` using that exact threadId, message, clientRequestId, and `mode="queue"`. **End the turn.** Members perform setup and communication only until READY; no repository exploration, tests, or edits.
3. **Verify role receipts.** As `BOOT_ACK <run> FROM <name> TO orchestrator role=<Role> sha256=<hash> model=<model>` arrives, validate run/name/role against `plan.json`, hash against that member's planned sha256, and model against its planned model. Corroborate exact providerInstanceId and model with that member's `task_status`. Acknowledge a failed/missing gate as a blocker; start pair checks only when every member passes.
4. **Start pairs.** Send every retained `go` object through `t3_thread_send` with its threadId and `mode="queue"`. Each message includes the orchestrator's own PING. Record only ACKs actually received, matching run, exact token, sender, and recipient against `pairs.json`/`roster.json`. **End the turn.** Members ping peers directly; orchestrator relaying cannot verify a mesh.
5. **Collect evidence.** Append every received `PAIR_REPORT` line verbatim to `<dir>/reports.log`. When all orchestrator outbound ACKs arrive, append its own report using the actual received tokens:

   ```text
   PAIR_REPORT <run> FROM orchestrator complete=true acks_received=[token,...] pings_answered=[]
   ```

   Members report `complete=true` only after all outbound ACKs arrive and all inbound PINGs are answered, including zero-outbound members. Accept PING/ACK only when run/token/sender/recipient match the assigned pair; ignore and log mismatches. Re-ACK duplicate valid PINGs; repeated GO resends only unacknowledged PINGs. Never ACK an ACK or fabricate another member's receipt.
   If progress stalls, send `PAIRS_STATUS? <run>` directly to missing members, using a fresh request ID per status round, then end the turn. Preserve partial evidence and report unresolved gates after a bounded recovery attempt.
6. **Verify matrix.** Run:

   ```bash
   node "$T3_MESH_SKILL_DIR/t3-mesh.mjs" matrix --run "$T3_MESH_RUN"
   ```

   Require exit 0, `passed == total == n*(n-1)/2`, and empty `errors`, where n includes the orchestrator and optional Oracle. The helper writes `<dir>/pair-matrix.txt`; PASS requires the sender's `acks_received` and recipient's `pings_answered` for the same exact token. Exit 2 means incomplete/invalid verification: inspect `pairs[].missing` and `errors`, recover evidence, and rerun only after new evidence.
7. **Release and confirm.** After every gate passes, send each retained `ready` object with its threadId and `mode="queue"` (never steer READY into a live turn; it must run as its own final turn so the member ends idle); end the turn. Require `READY_ACK <run> FROM <name>` from every member before declaring Operational. Repeated READY is idempotent. Then read `task_status` once for every send task that returned `delivery="steered"` during standup, so no member stays shown as Running; a member whose thread is still running after READY_ACK is a blocker, not Operational. Then rename the caller's own thread with `t3_thread_update` (`action="rename"`, `title="<squad name> -- Orchestrator"`, or plain `Orchestrator` if no name was given, threadId omitted, `clientRequestId="<run>-rename-orchestrator"`), and list it under that title in the roster. Wire messages keep the lowercase `orchestrator` member name. Keep the team idle and available for a later user-authorized assignment.
8. **Persist the charter.** Compaction or a long idle can drop this skill from context, but persistent memory is reloaded. So write a squad **charter** to the harness's persistent memory: the auto-memory directory plus its `MEMORY.md` index in Claude Code, or the harness's memory store elsewhere. If the harness has no persistent memory, save it to `<dir>/charter.md` and tell the user it will not survive a reboot. Fill in this template:

   ```markdown
   I orchestrate the <squad name> T3 squad from thread "<squad name> -- Orchestrator" (<orchestrator threadId>), run <run>, set up <date>. This applies only in that thread; other threads in this project are not the orchestrator.
   Mission: <current user objective, or "awaiting assignment">.
   Worker target: providerInstanceId <inst>, model <model>, effort <effort>.
   Rules: every implementation task, review-comment fix, test run, and GUI task goes to a worker; I brief, verify, integrate, and report. <Rules the user set for this mission.>
   Rehydrate: list the live roster with t3_thread_list (includeSubagents=true), then re-read "Hold the role" in <absolute path>/SKILL.md and <absolute path>/orchestrator.md before acting.
   ```

   The charter holds the role, the mission, the worker target and the rules. Member thread IDs and statuses go stale, so leave them to the live roster. Update the charter when the mission, worker target or user rules change, and delete it when the squad disbands.

`steered`, `queued`, or `started` means delivery accepted, not receipt. Await evidence through incoming-message turns: do not poll, sleep, or use `t3_thread_wait` while expecting inbound messages (incoming messages interrupt it). Preserve stable send clientRequestIds on retries.

## Report and assign next

Return these sections:

1. **Roster** — table of name, role, exact threadId (child thread for members), taskId, provider/model, role-file path/hash, and readiness; include current orchestrator and mark Oracle not applicable when omitted.
2. **Communication verification** — n, expected `n*(n-1)/2`, passed pairs, failures, and matrix path.
3. **READY acknowledgments** — received and missing members.
4. **Overall status** — Operational only when role/model, full pair matrix, and every READY ACK pass; otherwise Partially operational or Blocked with exact unmet gates.
5. **Charter** — where it was saved, or why it could not be.
6. **Next assignment** — send bounded user-authorized work directly to roster threadIds with `t3_thread_send`, `mode="auto"`, and distinct stable request IDs; include ownership, acceptance criteria, and verification. Require terminal reports back to the orchestrator.

Members are delegate child threads that inherit the caller's project, branch, worktree, and runtimeMode; they share one checkout. Later turns go to their `childThreadId` via `t3_thread_send`; each turn's final text returns to the orchestrator as a task notification, but only explicit `t3_thread_send` envelopes count as protocol evidence. Stop a member with `task_cancel <taskId>`. Assign disjoint files and retain orchestration, integration, and final decisions. Role guidance maps old pane/target terms to T3 threadIds and messaging to `t3_thread_send`; use T3 tools throughout.

After READY, consult the Oracle using its loaded `oracle.md` `ORACLE_QUERY`/`ORACLE_ACK`/`ORACLE_RESULT` protocol over direct thread messages. An ACK is receipt, not advice; the orchestrator decides. A member may raise its own effort using `t3_thread_configure`, retaining its provider/model and using provider-specific option IDs from capabilities. This tool configures only the calling thread; never change models to simulate effort.

## Hold the role

The orchestrator role lasts beyond standup. Compaction, idle gaps and harness defaults wear it down, so hold it with these steps:

- **Rehydrate** at the first turn after compaction or a long idle, before any other tool call. Read the charter, run `t3_thread_list` with `includeSubagents=true` for the live roster, and re-read `orchestrator.md`.
- **Delegate small fixes too.** The squad role overrides harness defaults that say to fix small review findings yourself. Review comments, CI failures and follow-up fixes are work orders for a worker. Limit your own tool calls to reads that scope a brief or verify a result.
- **Replace unreachable members.** A member whose provider instance is disabled or removed cannot take turns, so `t3_thread_send` to it fails. Confirm the charter's worker target in `orchestrator_capabilities` and spawn a replacement with `delegate_task`. Archive the unreachable thread, and update the charter if the target changed.
- **Archive integrated workers.** Once a worker's output is merged into a PR or otherwise accepted, archive its thread with `t3_thread_organize` (`action="archive"`; `unarchive` reverses it). The lineage then shows only members that can still take work. Keep a finished worker only while a likely follow-up needs its context, and tell the user which ones you kept and why.

For helper validation without launching threads, run:

```bash
node "$T3_MESH_SKILL_DIR/t3-mesh.mjs" selftest
```
