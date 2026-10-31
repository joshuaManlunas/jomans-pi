# Fleet dispatch in Pi inside Orca

Use only after the runtime probe selected `orca`. Fleet still owns scoping,
prompts, review, integration, and synthesis; Orca owns worker launch and lifecycle.

## Load the supported interface

Read the discovered **`orchestration` skill** from its advertised path. Follow
its executable-resolution rules (`ORCA_CLI_COMMAND`, then dev/platform rules)
and load the full compact guide with the selected executable:

```text
ORCA skills get orchestration
ORCA skills get orchestration --reference references/coordinator-loop.md
```

Here `ORCA` is the skill's executable placeholder, not a literal command or a new
environment variable. Use that same executable throughout. The coordinator-loop
reference defines supported model/effort options; follow the skill's documented
older-version handling if references are unsupported.

A missing skill, unavailable executable, disabled orchestration, or unsupported
worker profile is a blocker on this route. Report the exact error. Keep this
route selected; native tools, Codex threads, handoff commands, and direct
execution are not alternate launch paths.

## Dispatch and supervise

1. Read Fleet's sibling `config.json`. Preserve its actual `model`, `provider`,
   and `thinking` values, not a model name cached in prose. Keep the invoking Pi
   session's model unchanged.
2. Follow the guide's runtime confirmation and Run binding. As coordinator,
   create one Run for the objective, not one per worker. Respect a live injected
   Task/Dispatch preamble; a dispatched Fleet worker must not run Fleet or
   spawn helpers.
3. The default OpenRouter profile requires a Pi worker, not a Claude worker.
   Verify that the version-matched guide supports Pi model/provider and effort
   overrides before starting. The Pi model selector is
   `<config.provider>/<config.model>`; preserve `config.thinking` as the effort.
   If Pi launch preferences are unsupported (including guides listing only
   Claude/Codex/Cursor/Antigravity/Muse/OpenCode overrides), report that blocker
   without launching a different agent or model.

   Use only the guide's supported supervised start syntax with the assignment,
   including scope,
   ownership, constraints, acceptance checks, and a return path. These are
   Orca's existing launch flags; do not send native `reasoning_effort` or
   `fork_turns` fields. Keep the prompt self-contained instead of assuming
   inherited context. Omit speed/service-tier overrides. If the exact profile
   is unsupported, report the refusal without translating or changing it.
4. Launch each independent workstream once before waiting. Record the Run,
   Task, and Dispatch IDs and compare `launch.requested` with
   `launch.effective`; report a discrepancy rather than claiming the requested
   profile was used. A start error or unknown outcome may have created a
   worker: inspect its receipt and load `references/recovery-and-cleanup.md`
   through the orchestration skill before retrying. Never launch a native
   worker for the same assignment.
5. Use the guide's `check`/reply/ack loop and worker obligations. Require
   `worker_done` with Task/Dispatch IDs, explicit outcome, changed files, and
   validation evidence. Validate against the expected active Dispatch, inspect
   every changed file, and run independent checks. A timeout or empty delivery
   is a checkpoint, not proof the worker stopped or permission to duplicate it.
6. Re-dispatch substantive repairs through this same route and profile only
   after the guide authorizes the next attempt. Reuse, retain, or release each
   settled worker per the guide before ending the coordinator turn. Include
   the route, lifecycle IDs, effective profile, evidence, and blockers in
   Fleet's synthesis.

## Contract evidence and validation

The installed interfaces used to establish this route are:

- Pi's `@earendil-works/pi-coding-agent/dist/cli/setup.js` and
  `dist/rpc-entry.js` set `PI_CODING_AGENT = "true"`.
- Orca's managed `~/.pi/agent/extensions/orca-prefill.ts` and
  `orca-titlebar-spinner.ts` guard on `process.env.ORCA_PANE_KEY`.
  No pane-key format, worktree ID, hook credential, or app-presence heuristic
  is needed.
- The discovered `orchestration/SKILL.md` defines executable resolution and
  `skills get orchestration`. Its version-matched guide defines
  `orchestration worker-start`, lifecycle accounting, and recovery.

Fleet is an instruction skill, not a Pi extension registering a spawn tool.
The probe is deliberately read-only and returns exactly one route. Run
`node --test <skill-dir>/tests/dispatch-route.test.mjs` for isolated environment
cases and routing-guidance checks. Run `node --check` on both JavaScript files.
Validate skill discovery with Pi's installed skill loader when available.
No live worker is required for these checks; a real dispatch needs an enabled,
reachable Orca runtime and an installed agent supporting the configured profile.
