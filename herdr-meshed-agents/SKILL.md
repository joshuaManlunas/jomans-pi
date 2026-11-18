---
name: herdr-meshed-agents
description: "Stand up and verify a configurable squad of Claude Code, Codex, Cursor, or Pi workers, plus an optional advisory Oracle, in Herdr, with direct full-mesh messaging and Star Wars names shown in Herdr's pane headers and Agents list. Requires HC_TERMINAL_ID and a meshed-agents install; not for ordinary Herdr window control (use `hc --skill` and `~/.config/herdr-app/AGENTS.md` instead)."
disable-model-invocation: true
compatibility: Requires Claude Code, Codex, Cursor, or Pi CLI (per agent kind), Node.js for the mesh-config helper, a Herdr-managed caller terminal with HC_TERMINAL_ID set, `hc --skill` plus `~/.config/herdr-app/AGENTS.md`, and the role prompt files listed below.
---

# Herdr Meshed Agents

## Resource resolution

The skill is one directory. This file holds the standup procedure; each role's guidance lives beside it. Workers and the Oracle receive native system-prompt guidance for Claude Code and Pi, or conversational guidance for Codex and Cursor; the current executor adopts its orchestrator guidance in-session:

| File | Loaded by |
| --- | --- |
| `SKILL.md` | The executor, as the standup procedure |
| `orchestrator.md` | The executor, as its Orchestrator-Adviser role guidance (step 1.4) |
| `workers.md` | Every Worker: system prompt at launch for Claude Code and Pi (step 2.3); initial prompt at launch for Codex (step 2.3); loaded in conversation for Cursor (step 3) |
| `oracle.md` | The Oracle, same loading as Workers (step 2.5; only with an Oracle) |
| `mesh-config.mjs` | Deterministic parsing, naming, launch argv, pane geometry, standup planning and verification, and Oracle envelopes |
| `HARNESSES.md` | Read [HARNESSES.md](HARNESSES.md) when a launch or send fails, or a member shows blocked. |
| `mesh-config.test.mjs` | Maintainers: `node --test mesh-config.test.mjs` after changing the helper; not loaded during standup |
| `herdr-mods/install.mjs` | The executor, once per machine (step 1.7): mesh-aware Herdr pane header and Agents list that show roster names and nest members under their orchestrator |
| `herdr-mods/install.test.mjs` | Maintainers: `node --test herdr-mods/install.test.mjs` checks every patch anchor against the shipped Herdr mods (run it after a Herdr update); not loaded during standup |
| `EXAMPLES.md` | The user, as squad recipes and post-READY prompts; not loaded during standup |

Resolve `HERDR_MESH_SKILL_DIR` once, before any other step, and use the resolved value everywhere below:

1. **Packaged or synced copy**: when `mesh-config.mjs` exists beside this loaded `SKILL.md`, that directory is `HERDR_MESH_SKILL_DIR`. A local directory takes precedence over the pointer below.
2. **Standalone copy**: otherwise use the explicit absolute pointer below.

Confirm `mesh-config.mjs`, `orchestrator.md`, and `workers.md` (plus `oracle.md` when an Oracle is requested) exist in `HERDR_MESH_SKILL_DIR`. When a check fails, report the exact missing path as the blocker; the current working directory is never a source for these paths.

Standalone fallback pointer (the source copy; `~/.agents/skills/herdr-meshed-agents` is a synced copy of it):

```text
HERDR_MESH_SKILL_DIR=/Users/joshuamanlunas/Projects/_LOCAL_NPM/herdr-meshed-agents
```

Stand up a fully operational agent-harness squad (Claude Code, Codex, Cursor, or Pi) using tools, not a plan or simulated success. The current executor is the Orchestrator-Adviser; launch only the Workers and the optional Oracle. This skill is Herdr-specific; the cmux `/meshed-agents` extension stays Pi-only and has no Oracle.

## Invocation and parameters

```text
/herdr-meshed-agents [worker_count] [worker_model[:effort]] [--kind claude|codex|cursor|pi] [--effort level] [--oracle claude|codex|cursor|pi] [--oracle-model slug[:effort]] [--oracle-effort level]
/skill:herdr-meshed-agents <same arguments>
```

The first form is how Claude Code invokes a skill; the second is Pi's. Codex and Cursor executors have no slash-skill syntax this skill relies on: ask them plainly to read this `SKILL.md` and execute the standup with the given argument array (for example, `Read <HERDR_MESH_SKILL_DIR>/SKILL.md and stand up a squad with the arguments: 2 gpt-6.1-sol:high`), unless the skill is natively installed. The arguments are identical, and every executor kind works with every Worker and Oracle combination. `--kind` sets one harness for all Workers, so a single run cannot mix Worker kinds; a mixed team comes from choosing different kinds for the executor, the Workers, and the Oracle. `EXAMPLES.md` beside this file has a combination matrix, purpose-based recipes, and sample prompts for assigning work after READY.

| Position | Parameter | Default | Meaning |
| --- | --- | --- | --- |
| 1 | `worker_count` | `2` | Optional positive decimal integer; excludes the current executor and the Oracle. Total squad size is `worker_count + 1` plus `1` with an Oracle. |
| 2 | `worker_model[:effort]` | Omitted | Optional model slug for every Worker. A trailing `:<effort>` (`gpt-6.1-sol:high`) is split off as the Workers' effort; other suffixes (`:batch`) stay in the slug. When the model is omitted, omit `--model`/`-m` and `--provider`: preserve the harness's default Worker model, not the executor's model. |
| option | `--kind` | Inferred, else `claude` | Optional Worker harness: `claude` (Claude Code), `codex` (Codex CLI), `cursor` (Cursor CLI), or `pi`. When omitted, the helper infers it from the model family (GPT, `codex`, `o<digit>` models → `codex`; Claude/Opus/Sonnet/Haiku/Fable → `claude`) and otherwise uses `claude`. Pi is used only when requested explicitly. |
| option | `--effort` | Omitted | Optional reasoning effort for every Worker: `claude` low–max; `codex` minimal–max; `pi` off–max. Cursor has no effort flag (it encodes effort in the model slug), so `--effort` with Cursor is invalid. Do not combine it with a `:effort` model suffix. When omitted, the harness default applies. |
| option | `--oracle` | Inferred from `--oracle-model` | Optional advisory Oracle harness, independent of `--kind`. Adds exactly one Oracle beyond `worker_count`. `--oracle-model` alone infers the Oracle's kind from the model family. Without any Oracle option there is no Oracle, and the squad behaves exactly as without one. |
| option | `--oracle-model` | Omitted | Optional model slug for the Oracle only, with the same `:effort` suffix rule. When omitted, the Oracle harness's default model applies, independent of the Workers' model. |
| option | `--oracle-effort` | Omitted | Optional reasoning effort for the Oracle only, validated against the Oracle's kind. |

`--kind` and `--oracle` take harness selectors (`claude` → `claude`, `codex` → `codex`, `cursor` → the `cursor-agent` executable, also installed as `agent`, `pi` → `pi`); write `--kind cursor`, never `--kind agent` or `--kind cursor-agent`. `--kind` sets only the Workers and never switches the current executor, and `worker_count` excludes the executor and the Oracle: the current executor plus 2 Workers plus 1 Oracle is a squad of 4. For example, `/herdr-meshed-agents 3 gpt-6.1-sol:high --oracle-model claude-fable-5-1:medium` asks for 3 Codex Workers on `gpt-6.1-sol` at high effort plus a Claude Code Oracle on `claude-fable-5-1` at medium effort.

**Natural-language requests.** When the user describes the squad in words ("3 gpt-6.1-sol:high workers with 1 claude-fable-5.1:medium oracle"), translate it into this grammar before parsing. Write model IDs exactly as the harness accepts them (`claude-fable-5-1`, not `claude-fable-5.1`), keep a stated effort as the `:effort` suffix, and let the helper infer kinds. Show the user the translated argument array in your first progress note.

Parse only invocation arguments, not surrounding conversation. Before creating any pane, run the helper on the quoted argument array (arguments are data; never use `eval`):

```bash
node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" parse -- <quoted-argument-array>
```

Use its JSON as the single source of truth for the run: `workerCount`, `modelSlug` and `effort` (the Workers'), `kind`, and `oracle` as `{kind, modelSlug, effort}` when requested. On exit 2, report the helper's stderr message verbatim and stop. The helper enforces:

- At most two positionals (`worker_count`, then `worker_model`) plus `--kind`, `--effort`, `--oracle`, `--oracle-model`, `--oracle-effort` (each also as `--flag=value`), in any position.
- `worker_count`: ASCII decimal digits only, integer value greater than zero, leading zeros allowed, default `2`. It excludes the executor and the Oracle. `Invalid worker_count <quoted-input>: expected a positive integer.`
- A model-only invocation is invalid; supply the count first. An explicitly empty model slug is invalid.
- `--kind` / `--oracle`: `claude`, `codex`, `cursor`, or `pi`. `Invalid --kind <quoted-input>: expected claude, codex, cursor, or pi.`
- Effort given both as a suffix and a flag is rejected (`Effort given twice: ...`); an effort the kind does not accept is rejected with that kind's levels.
- `--oracle-model` or `--oracle-effort` whose model names no known family needs an explicit `--oracle`.
- Unknown options, duplicate options, missing option values, and extra positionals are rejected with the helper's usage message.

When no Oracle option is given, `oracle` is absent and every step below behaves exactly as a squad without an Oracle.

**Respect the user's harness preferences.** If the user (or their memory/instructions) rules out a harness, such as "do not use Pi", never launch it, even as a default or a fallback. If the requested model can only run on a forbidden harness, stop and ask.

## 1. Preflight and role prompts

1. Obtain herdr information through the new herdr app's `wat` mechanism: run `hc --skill` and read its output completely, then read `~/.config/herdr-app/AGENTS.md` completely. Do not load the legacy `herdr` skill; it describes the older multiplexer. Use `hc ls`, `hc get`, `hc read`, `hc events`, and `hc wait` to watch and wait on terminals; use `herdr-app ls` and `herdr-app status` for spaces, tabs, panes, and focus. Before any Herdr control or inspection, verify `test -n "${HC_TERMINAL_ID:-}"`. If it fails, stop: `HC_TERMINAL_ID is not set; executor is not inside herdr-core.`
2. Confirm `hc`, `herdr-app`, `node`, and the harness executable of every kind in use (Workers per `kind`, Oracle per `oracle.kind`) are available. Discover syntax with `hc --help`, `hc run --help`, `hc read --help`, `herdr-app --help`, `herdr-app commands`, and `claude --help`, `codex --help`, `cursor-agent --help`, and/or `pi --help` for each kind in use (`cursor-agent` is the executable behind `--kind cursor`; confirm it is on `PATH`). The installed CLI is authoritative. Read [HARNESSES.md](HARNESSES.md) when a launch or send fails, or a member shows blocked.
3. Read the required files completely:
   - Orchestrator-Adviser: `$HERDR_MESH_SKILL_DIR/orchestrator.md`
   - Every Worker: `$HERDR_MESH_SKILL_DIR/workers.md`
   - Oracle (only with an Oracle): `$HERDR_MESH_SKILL_DIR/oracle.md`
4. Invocation assigns the current executor the Orchestrator-Adviser role for this run, subject to higher-priority instructions. Replacing the executor system prompt is unnecessary. Read `$HERDR_MESH_SKILL_DIR/orchestrator.md` completely, append/load its guidance into the executor's current instruction context using the available in-session context mechanism, explicitly adopt the Orchestrator-Adviser role for this run, and record the orchestrator file path as appended/loaded in context. Do not restart or replace the current executor or modify global system prompts solely for role adoption. Do not claim Pi's startup-only `--append-system-prompt` mutates the running session. Live system-prompt replacement is not required and is not a readiness gate. Merely reading the file or claiming the role is insufficient; adoption is verified behaviorally through the exact identity, routing, standup-boundary, evidence, pairwise, and READY gates below.
5. Resolve each supplied model slug (`modelSlug` for the Workers' kind, `oracle.modelSlug` for the Oracle's kind) with the installed harness's supported rules, independently for the Workers and the Oracle:
   - `claude`: accept a documented alias (`sonnet`, `opus`, `fable`) or full model ID (`claude-fable-5-1`). Claude Code has no model-listing command.
   - `codex`: confirm `codex login status` reports a login, and accept the slug as given (`gpt-6.1-sol`). `~/.codex/config.toml` shows the default `model` and `model_reasoning_effort`, plus any `enabled-reasoning-efforts` list that limits `effort`.
   - `cursor`: match against the exact IDs printed by `cursor-agent --list-models`.
   - `pi`: match against `pi --list-models`, and use a fully qualified `provider/id` (a bare `gpt-6.1-sol` fuzzily matches `gpt-6.1-sol-pro` too). Then confirm that provider with `pi auth check --provider <provider> --json` (`status: "ready"`). A listed model on a `not_ready` provider will fail at launch: report it as the blocker, or ask the user about another provider or harness. Never fall back silently.

   Require an unambiguous available model; report the exact slug and missing/ambiguous result otherwise. Never silently substitute a model or persist a new default. Confirm effective model and effort from live launch evidence in §2 and member operation through the standup checks in §4.
6. Capture caller identity using `$HC_TERMINAL_ID`, `herdr-app status` (current space, tab, and focused pane), `hc get "$HC_TERMINAL_ID"` (agent kind, name, labels, and cols/rows for step 2.2), and `hc ls --json` (all live terminals, not just this space). The caller's working directory is `.foreground.cwd`, the agent's own folder. `.cwd` is the hosting shell's launch folder and is often just `~`. Require a Claude Code, Codex, Cursor, or Pi executor (check the agent reported by `hc get`) and retain the exact caller terminal address and its pane from `herdr-app ls`. Before recording the roster or starting bootstrap, choose the executor name by piping the global live-terminal JSON (`hc ls --json`, all spaces) through the helper, which returns the first available of `orchestrator`, `orchestrator2`, `orchestrator3`, ...:

   ```bash
   hc ls --json | node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" role-name --role orchestrator --terminal "$HC_TERMINAL_ID"
   ```

   Use the returned `name`. A candidate owned by another live terminal's address is occupied, while a candidate already owned by this caller is available and should be verified without relabeling. If this caller already has `.labels["mesh.name"]` (or `.name`) equal to the selected name, verify it with `hc get "$HC_TERMINAL_ID"`; otherwise register the name with `hc label "$HC_TERMINAL_ID" mesh.name=<selected-executor-name> mesh.role=orchestrator` on the exact caller terminal, then verify with `hc get "$HC_TERMINAL_ID"` that `.labels["mesh.name"]` equals the resolved executor name, `.labels["mesh.role"]` is `orchestrator`, and the address is exact. Never relabel unrelated terminals. If the label reports a concurrent collision, re-capture `hc ls --json`, rerun the helper, and retry for a bounded number of attempts. On a persistent collision or any other label/get error or mismatch, stop and report the exact blocker. Use the resolved executor name consistently in the roster, bootstrap, all messages, and final report; do not hardcode `orchestrator` after selection. Create a unique run ID and a fresh temporary evidence directory. Record the run ID, parsed configuration (`workerCount`, `modelSlug`, `effort`, `kind`, `oracle`), prompt paths, and captured roster there. Never reuse old ACK evidence.
7. Make roster names visible to the user. Herdr's shipped pane header shows only the program ("Codex", "Claude Code") and its folder, and its Agents list labels every agent in a tab with the tab's lead title, so `mesh.name` labels are otherwise invisible. Check, and install when missing:

   ```bash
   node "$HERDR_MESH_SKILL_DIR/herdr-mods/install.mjs" --check || node "$HERDR_MESH_SKILL_DIR/herdr-mods/install.mjs"
   ```

   The installer does four things:
   - clones the shipped `pane` and `agents` mods as `mesh-pane` / `mesh-agents` and patches them to show `<mesh.name> · <mesh.role>`. The Agents list also nests each member under the agent named by its `mesh.parent` label (or its real hc `parent`) and lists it only there; clicking a nested member that has a pane focuses that pane. Other terminals render as before. A clone from an older installer version (older marker) is replaced; a folder without the marker is refused.
   - runs `herdr-app check` on each clone
   - points the shown layout's pane header and Agents block at the clones, keeping a `<layout>.json.pre-mesh-<time>` backup
   - leaves shipped mods and layouts untouched

   It is idempotent. If the shown layout is shipped (read-only), it stops and prints the `layout.clone` command. Ask the user before running that, because cloning switches their layout. Names are cosmetic: an installer failure is reported in the final report but never blocks standup, and the `mesh.name` labels stay the identity of record. `install.mjs --uninstall` points the layout back at the shipped mods.

Stop on other missing required files, skills, tools, models, or capabilities and report the exact blocker. Leave existing agents and unrelated files untouched.

## 2. Launch Workers and the optional Oracle

1. Choose a different Star Wars character for every Worker, with a unique live roster name matching `[a-z][a-z0-9_-]{0,31}`. Examples: `leia`, `yoda`, `obi-wan`, `ahsoka`, `han-solo`, `chewbacca`, `luke`, `padme`, `lando`, `qui-gon`. If a name is occupied, choose another character; do not rename or replace another agent. Name the Oracle (when `oracle` is set) before its launch, exactly as the executor is named: capture the global live-terminal JSON again and run the helper, which returns the first available of `oracle`, `oracle2`, `oracle3`, ...:

   ```bash
   hc ls --json | node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" role-name --role oracle
   ```

   A name owned by any live terminal is occupied, and no existing agent is renamed or replaced. Use the resolved Oracle name in the launch, roster, bootstrap, every `ORACLE_QUERY`/`ORACLE_ACK`/`ORACLE_RESULT`, and the final report; do not hardcode `oracle` after selection.

2. Create exactly `worker_count` separate sibling panes (plus exactly one more for the Oracle when `oracle` is set, so `worker_count + 1` panes) in the caller's current tab. Get the split order from the helper, using the caller's `cols`/`rows` from `hc get "$HC_TERMINAL_ID"`. Member indices count the Workers first, then the Oracle:

   ```bash
   node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" split-plan --count <worker_count + oracle> --cols <caller-cols> --rows <caller-rows>
   ```

   It returns one `{member, from, direction, size}` step per new pane. Each step splits the largest pane along its visually longer side (terminal cells are about 2.5× taller than wide) and never goes below 80×16 cells, so the squad forms a grid instead of narrow columns. `from` is `"caller"` (the captured caller pane) or the index of an earlier member, whose captured pane ID you substitute. Run the steps in order, each with `herdr-app do pane.split --direction <direction> --pane <pane-id-of-from> --argv '<agent-argv-json>'`. Capture every new `.pane` and `.terminal` from JSON; never predict IDs. Record the roster name, role, and delegating executor right after each split with `hc label <captured-terminal> mesh.name=<member-name> mesh.role=<worker|oracle> mesh.parent=<executor terminal address>`. `mesh.name` is the identity used for verification and is what the mesh-aware pane header shows. `mesh.parent` nests the member under the orchestrator in the mesh-aware Agents list, as the orchestrator's delegate.

   If the helper reports `Layout capacity` or a split fails, report the actual failure and preserve the requested count and workspace.

   `pane.split` takes no folder: a new pane starts in the folder of the pane it splits from. Splitting from the caller or a squad pane therefore keeps the caller's folder. Codex additionally gets `-C <caller-cwd>` (step 2.3).
3. Generate the agent arguments with the helper instead of composing them by hand. Pass `--effort` when `effort` (or `oracle.effort`) is set; for Codex also pass `--cwd <caller .foreground.cwd>` and `--executor <caller terminal address>`. It adds `--model`/`-m` only when a model was supplied, and never adds permission flags:

   ```bash
   node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" launch-args --role worker --kind <kind> --name <worker-name> --prompt-dir "$HERDR_MESH_SKILL_DIR" [--model <resolved-model-slug>] [--effort <effort>] [--cwd <caller-cwd>] [--executor <caller-address>]
   ```

   Pass the resolved `$HERDR_MESH_SKILL_DIR` as `--prompt-dir`. The helper checks the role file and prints the JSON argv array. Pass that exact array as one `--argv` argument to `herdr-app do pane.split`.

   Codex needs sandbox escalation for Herdr commands, starting with the first attempt.

   ```bash
   agent_argv="$(node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" launch-args --role worker --kind codex --name <worker-name> --prompt-dir "$HERDR_MESH_SKILL_DIR" --model gpt-6.1-sol --effort high --cwd "<caller-cwd>" --executor "$HC_TERMINAL_ID")"
   herdr-app do pane.split --direction <direction> --pane <pane-id-of-from> --argv "$agent_argv"
   ```

   Use the same resolved `modelSlug` and `effort` for every Worker; when none was supplied, the helper omits them, and the harness defaults apply. The requested effort is a launch setting, not a change of model; after READY the orchestrator may raise a Worker's level further as `orchestrator.md` describes. Cursor may encode effort in the model slug, so never rewrite the requested model to simulate thinking. If a Worker blocks on a permission, trust, or authentication prompt, ask the user before answering it; never add `--force`, `--trust`, `--dangerously-*`, or other permission flags on your own.
4. Verify each launch response identifies the selected kind (`claude`, `codex`, `cursor`, or `pi`) in the captured pane and carries the required role argument (prompt file for Claude Code and Pi; initial role prompt for Codex), any requested model, and any requested effort. After each successful Worker start, verify with `hc get <captured-worker-terminal>` three things:
   - `.labels["mesh.name"]` equals the Worker name, and the address is exact;
   - `.status.app` is the expected agent;
   - `.foreground.cwd` is the caller's folder.

   Confirm the pane from `herdr-app ls` matches the launch response. Confirm the effective model and effort from live evidence: Claude's banner reads "<Model> with <effort> effort", and Codex's status line reads "<Model> <effort>". Inspect blocked startup with `hc get` and `hc read`; ask the user before answering approval or authentication dialogs.

5. Launch the Oracle (only when `oracle` is set) in its own pane at its `split-plan` step, with the same name and readiness rules, using the helper with `--role oracle`, the Oracle's kind, and its own resolved `oracle.modelSlug` and `oracle.effort` (each omitted when unset, independent of the Workers):

   ```bash
   agent_argv="$(node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" launch-args --role oracle --kind <oracle-kind> --name <oracle-name> --prompt-dir "$HERDR_MESH_SKILL_DIR" [--model <resolved-oracle-model-slug>] [--effort <oracle-effort>] [--cwd <caller-cwd>] [--executor <caller-address>])"
   herdr-app do pane.split --direction <direction> --pane <pane-id-of-from> --argv "$agent_argv"
   hc label <captured-oracle-terminal> mesh.name=<oracle-name> mesh.role=oracle mesh.parent=<executor terminal address>
   ```

   Apply the launch checks in step 4 to the Oracle. Require `hc get <captured-oracle-terminal>` to show the resolved Oracle name and exact address, and `herdr-app ls` to show the same terminal in the captured pane. Verify the kind, role argument, requested model and effort, and effective model and effort from live evidence.

   If `pane.split` reports that the Oracle name is taken (a concurrent collision), and `hc get` shows the new pane is still an available terminal with no agent, re-capture `hc ls --json`, rerun the `role-name` helper, regenerate `launch-args` with the new name, and retry in a new pane for a bounded number of attempts. When no available terminal or name remains, stop and report the exact blocker; never replace or rename an unrelated agent.

Completion: the roster contains exactly one current executor, the requested number of live, separately hosted Workers of the selected kind, and, when requested, exactly one live Oracle of its selected kind. Startup readiness alone is not mesh readiness.

## 3. Deliver role guidance and standup cards

Set `evidence` to the absolute path of the fresh directory from §1.6. Use the receive procedure in §4 throughout standup.

1. Confirm conversational role guidance for every Codex and Cursor member before sending any standup card. Claude Code and Pi receive the role file at launch. For each Codex or Cursor member, get its exact role path and instruction.

   ```bash
   node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" role-bootstrap --role <worker-or-oracle> --kind <kind> --name <member-name> --prompt-dir "$HERDR_MESH_SKILL_DIR" --executor "$HC_TERMINAL_ID"
   ```

   The helper prints `{path, deliver, instruction}`. For `launch-prompt` (Codex), the instruction is already in the launch argv. For `send` (Cursor), pass `instruction` as one argument to `hc send <member-address> <instruction>` using an argument array. The member reads only its role file and routes its `ROLE_LOADED` receipt to the executor.

   Wait up to 120 seconds per member for `<hc from="t1q">ROLE_LOADED ...</hc>`. Pipe that complete tagged block to the validator. Pass the returned `path` verbatim as one argument. The helper compares it as a double-quoted JSON string in the receipt.

   ```bash
   node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" role-loaded --role <worker-or-oracle> --name <member-name> --path <path> --from <member-address>
   ```

   Save the validated role receipts in the evidence directory. Corroborate the role read and adoption with `hc read <member-address> --lines 40`. On timeout or validator exit 2, inspect that member with `hc read` for `ROLE_BLOCKED` or the exact failure. Finish this step when every Codex and Cursor receipt passes and the read is corroborated.

2. Build the standup plan from the verified roster. Save roster JSON as `$evidence/roster.json`, with `run` and a `members` array. Include the executor and every member as objects with `name`, `role` (`orchestrator`, `worker`, or `oracle`), `kind`, `address`, and `pane`.

   ```bash
   node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" standup --evidence "$evidence" \
     < "$evidence/roster.json" > "$evidence/standup.json"
   ```

   The helper writes `plan.json` and `roster.md`. It returns `run`, `pairs`, `bootstraps`, `ready`, `rosterPath`, and `planPath`. Every unordered pair gets a `<run>-p<N>` token. For pairs with the orchestrator, the member sends the PING, which also proves bootstrap receipt. The helper balances the other sends across members. Each generated card contains the run, address-keyed roster, instructions, literal PING, evidence and `PAIRS_DONE` commands, and the card copy path.

3. Create empty `inbox.txt` and `orch-sent.txt` files in the evidence directory. Send all generated bootstraps in one script before waiting for any pair evidence. Pass each `text` as one argv element to the exact `address`, without `--wait`. Keep the same script for the READY batch in §4.

   ```bash
   node - "$evidence/standup.json" bootstraps <<'NODE'
   const { spawnSync } = require("node:child_process");
   const { readFileSync } = require("node:fs");
   const [planPath, group] = process.argv.slice(2);
   for (const { address, text } of JSON.parse(readFileSync(planPath, "utf8"))[group]) {
     console.log(address);
     const sent = spawnSync("hc", ["send", address, text], { stdio: "inherit" });
     if (sent.error) console.error(sent.error.message);
     if (sent.status !== 0) process.exitCode = 1;
   }
   NODE
   ```

   Check the send result for every address. `{"started":true,...}` confirms delivery. On a failed send, read [HARNESSES.md](HARNESSES.md) and inspect the affected member. Continue to pair verification once every card is delivered.

## 4. Verify every pair, then mark READY

1. **Receive messages.** Herdr delivers each message as the executor's next input, tagged `<hc from="t1q">…</hc>`. Squad terminals have a null hc name, so use the address in the tag and resolve the name from the roster. Process every message delivered together, including messages inside paste wrappers and messages that arrived during sends.

   When more messages are needed, wait on any one member terminal with `hc wait <member-address> --timeout <remaining-seconds>`. A message from any member can end that wait with `reason: "message"` and arrives as input. The squad terminals are siblings, so `hc wait --children` returns at once for the squad.

2. **Record and check.** Append every hc message received from the bootstrap batch onward raw to `$evidence/inbox.txt`, preserving tags and embedded newlines. Run the checker.

   ```bash
   node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" standup-check --evidence "$evidence"
   ```

   Send every returned `acksToSend` entry with `hc send <address> <text>`, using one argument for `text`. After each successful send append its exact text as one line to `$evidence/orch-sent.txt`. Rerun the check after logging sends or receiving messages. The original PING sender writes its own `<token>.ack` with the exact ACK line. Use `pairs`, `pairsDone`, `invalid`, and `outstanding` to track evidence and resolve failures. The checker ignores other runs and validates the tag's address against the roster. Preserve the check output with the pair tokens and evidence paths.

3. **Finish pairs.** Repeat steps 1 and 2 until the pairs check returns `done: true`. This requires an exact ACK file for every pair, a `PAIRS_DONE` message from every member, and an empty `acksToSend`. Bound each pending check to 120 seconds total across re-waits. If evidence is missing, inspect the affected terminal with `hc get <member-address>` and `hc read <member-address> --lines 40` for the actual state or `MESH_BLOCKED`. Report unresolved endpoints, tokens, and missing evidence alongside partial results and the panes created.

4. **Verify READY.** After the pairs check passes, send the generated READY texts with the §3 batch script using `ready` in place of `bootstraps`. Append every received message to the same inbox and rerun the checker in the READY phase.

   ```bash
   node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" standup-check --evidence "$evidence" --phase ready
   ```

   Use the same receive and check loop until `done: true`. The READY phase also requires `READY_ACK` from every member. Confirm every roster address and `mesh.name` with `hc get`, each Worker and Oracle's `mesh.parent` against the executor's address, and every recorded pane with `herdr-app ls`. Compare effective models and effort to the launch evidence from §2. Leave the squad running and available for a later user-authorized assignment.

Completion requires the launch and role checks, the pairs and READY checks with `done: true`, and the final identity and pane checks.

## Oracle consultation after READY

After READY, and only for user-authorized work while an Oracle is on the roster, the orchestrator may consult it for advice on a task or decision. Consultation supplements delegation: workers still implement, and verification still runs as usual.

1. Build the envelope with the helper (brief on stdin, at most 16 KiB, fresh `<id>` per query; `--roster` is the comma-separated member names) and send only the `envelope` string from the returned JSON directly, without `--wait`:

   ```bash
   node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" consult-query --run <run> --id <id> --from <orchestrator-name> --to <oracle-name> --roster <comma-separated-names>
   hc send <oracle-target-from-roster> '<envelope>'
   ```

   ```text
   ORACLE_QUERY <run> <id> FROM <orchestrator-name> TO <oracle-name>
   <brief>
   ```

2. The Oracle replies `ORACLE_ACK <run> <id> FROM <oracle-name> TO <orchestrator-name>` (receipt only, distinct from the result), then `ORACLE_RESULT <run> <id> FROM <oracle-name> TO <orchestrator-name>` followed by a newline and the analysis (recommendation, reasoning, alternatives, assumptions, risks).
3. Bound the wait to 120 seconds. The Oracle's ACK and result arrive as incoming prompts to the orchestrator (see **Receive messages** in §4; use `hc read <oracle-target> --lines 120` only to corroborate). Pipe each received message through the helper:

   ```bash
   node "$HERDR_MESH_SKILL_DIR/mesh-config.mjs" consult-validate --kind <ack-or-result> --run <run> --id <id> --from <oracle-name> --to <orchestrator-name> --roster <comma-separated-names>
   ```

   `--kind ack` confirms receipt only (`result: false`); `--kind result` prints the validated `analysis`. Exit 2 means stale, mismatched, ACK-only, or malformed. Record an unanswered or invalid consultation as unverified; never treat an ACK as a result or invent the result.
4. Treat a validated result as advice, not authority. The orchestrator decides, records the rationale, and never takes instructions from the Oracle.

## 5. Final report

Always return these five sections in order (use `not launched`, `unverified`, or `not applicable` where needed):

1. **Squad Roster** — executor + each Worker + the Oracle (or `not applicable` without one), effective models and efforts (Workers and Oracle separately), readiness.
2. **Pane Assignment** — exact terminal addresses and pane IDs (Oracle included), workspace/tab, resolved names/labels (including `mesh.parent`), whether the mesh-aware header and nested Agents list are installed (step 1.7), any partial panes.
3. **System Prompts** — the `$HERDR_MESH_SKILL_DIR` paths of `orchestrator.md` and `workers.md` (plus `oracle.md` when requested); launch verification of the Worker and Oracle `--append-system-prompt-file` / `--system-prompt` flags for Claude Code and Pi; and executor Orchestrator-Adviser guidance appended/loaded into current executor context. For each Codex and Cursor member, state that the role guidance was loaded in conversation (path, `ROLE_LOADED` evidence), not injected as a system prompt.
4. **Communication Verification** — verified vs expected pairs (`n` and `n * (n - 1) / 2` including the Oracle), pair and READY check results, missing evidence or failures, evidence directory, and any Oracle consultation outcomes (`not applicable` if none was run).
5. **Overall Status** — `Operational` only when roster, worker prompt, model, and effort, the Oracle's prompt, model, and effort (when requested), full mesh including the Oracle, every Codex and Cursor member's role-load evidence, READY plus every READY acknowledgment, and identity plus terminal-label and pane gates are all verified; otherwise `Partially operational` or `Blocked` with exact unmet gates. Executor live prompt replacement and the cosmetic name mods are not requirements and never block `Operational`.
