# herdr-meshed-agents run issues

Running log of errors and friction from a `/herdr-meshed-agents` standup.

- **Date:** 2026-11-04
- **Invocation (natural language):** `3 gpt-6.1-sol:high workers with 1 claude-fable-5.1:medium oracle`
- **Mapped to helper args:** `3 openrouter/openai/gpt-6.1-sol:high --kind pi --oracle claude --oracle-model claude-fable-5-1`
- **Executor:** Claude Code (Opus 5.5) in hc terminal `t12`
- **Skill dir:** `/Users/joshuamanlunas/.agents/skills/herdr-meshed-agents` (identical to this repo copy)
- **Herdr docs source:** `hc --skill` + `~/.config/herdr-app/AGENTS.md`. The legacy `herdr` skill was NOT used.

Severity: **blocker** (stopped the run), **workaround** (needed a deviation), **friction** (worked, but cost time or was misleading).

## Issues

### 1. No way to pass effort/thinking to the helper — workaround
- **What:** `mesh-config.mjs launch-args` has no `--effort`/`--thinking` flag ("no effort/permission/thinking flags", line ~99), and SKILL.md §2.3 says to launch on harness defaults. The user explicitly asked for `:high` Workers and a `:medium` Oracle.
- **Workaround:**
  - Pi Workers: the effort goes in the model slug (`openrouter/openai/gpt-6.1-sol:high`), which pi's `--model` supports (`optional ":<thinking>"`), so the helper passes it through untouched.
  - Claude Oracle: the slug can't carry effort, so I appended `--effort medium` by hand to the helper's argv.
- **Suggested fix:** add `--effort <level>` to `launch-args` (claude → `--effort`, pi → `--thinking`, cursor → reject or document a slug suffix), and let the parse grammar accept `model:effort` per role.

### 2. Natural-language invocation does not match the parse grammar — friction
- **What:** The skill's positional/flag grammar has no slot for an Oracle effort, and no way to say "workers with 1 oracle" without `--oracle <kind>`. I mapped the request by hand: "gpt" → `--kind pi`, "claude-fable" → `--oracle claude`.
- **Suggested fix:** document how to map `<model>:<effort>` and add an `--oracle-effort` option, or accept `--oracle-model slug:effort`.

### 3. pi `openai-codex` provider not authenticated; only OpenRouter has gpt-6.1-sol — workaround
- **What:** `pi --list-models gpt-6.1-sol` lists only `openrouter/openai/gpt-6.1-sol*`. `pi auth check --provider openai-codex --json` returns `{"status":"not_ready","reason":"credentials_not_configured"}`. All 351 listed models are `openrouter`. The `hc --skill` manual's example uses `pi --provider openai-codex --model gpt-6.1-sol`, which would fail here.
- **Workaround:** used the fully qualified `openrouter/openai/gpt-6.1-sol:high`. A bare `gpt-6.1-sol` is fuzzy and would also match `gpt-6.1-sol-pro`.
- **Suggested fix:** in SKILL.md step 1.5, run `pi auth check --provider <p> --json` for the resolved provider, and prefer a fully qualified `provider/id`.

### 4. `--append-system-prompt-file` not listed in `claude --help` options — friction
- **What:** The helper emits `claude --append-system-prompt-file <path>`, but `claude --help` lists only `--append-system-prompt <prompt>`. The `-file` variant shows up only inside the `--bare` description ("--append-system-prompt[-file]"). SKILL.md says "confirm the flag with `claude --help`", which by itself suggests the flag doesn't exist.
- **Status:** checked at Oracle launch (see later entries).

### 5. User forbade Pi mid-run; Codex is not a supported `--kind` — workaround
- **What:** The user said "DO NOT USE Pi use the claude-code or codex only". Claude Code can't run GPT models, so GPT-6.1-sol Workers have to be Codex. `mesh-config.mjs` rejects it: `role-bootstrap --kind codex` → `Invalid kind "codex": expected pi, claude, or cursor.` (exit 2). `parse` and `launch-args` have the same whitelist.
- **Workaround:** hand-built Worker argv `["codex","--no-daemon","-C","<repo>","-m","gpt-6.1-sol","-c","model_reasoning_effort=\"high\"","<role-bootstrap instruction>"]`:
  - `--no-daemon`: the `hc --skill` manual says Codex needs it, or its commands run outside hc.
  - Codex has no system-prompt-file or `--name` flag, so I loaded the role in conversation through the Cursor path (`role-bootstrap --kind cursor` text). It goes in as the initial `[PROMPT]` because "a send to a booting agent can be dropped".
  - The identity comes from `hc label mesh.name=…`.
- **Suggested fix:** add `codex` as a first-class kind: `--no-daemon`, `-m`, `-c model_reasoning_effort=…`, role loaded in conversation (or `-c developer_instructions=…`), with model resolution against `~/.codex/config.toml` / `codex login status`. Then drop Pi from the recommended GPT path, or put it behind the user's preference.

### 6. `pane.split` has no folder/cwd argument — friction
- **What:** `herdr-app commands` lists `pane.split` args as `direction, pane, argv, mod, props`, with no `folder`. SKILL.md §2.2 says to create panes "in the caller's current tab and cwd" but gives no way to set the cwd. Also, `hc get t12` reports `.cwd=/Users/joshuamanlunas` (the shell's launch dir), while the executor actually runs in `.foreground.cwd`, the repo.
- **Workaround:** Codex gets `-C <repo>`. For Claude, I relied on the inherited pane cwd (checked after launch).

### 7. Geometry rule vs "split from the caller pane" — friction
- **What:** §2.2 says to split "suitable large panes right or down rather than repeatedly making narrow columns", but the command template always uses `--pane <captured-caller-pane-id>`. With 4 new panes, splitting the caller 4 times gives slivers.
- **Workaround:** split the caller twice, then split those new panes (a 2×2-ish grid).

### 4 (resolved). `--append-system-prompt-file` works
- The Oracle launched cleanly with `["claude","--append-system-prompt-file",".../oracle.md","--name","oracle","--model","claude-fable-5-1","--effort","medium"]`. Banner: "Fable 5.1 with medium effort". Only the docs gap remains (the flag isn't in `claude --help`).

### 8. `hc wait <t>` returns early when *any* terminal messages the caller — friction
- **What:** `hc --skill` says "`hc wait <t>` waits for just that terminal". In practice `hc wait t13` returned `{"reason":"message","from":"t16",...,"terminal":"t13","status":"working"}`, because a different member's `hc send t12` interrupted it. That happened on almost every wait.
- **Impact:** waits can't be scoped to one member, so every incoming PING/ACK/BOOT_ACK cost one wait→record→wait cycle. It's harmless, but the 120s-per-check bound in SKILL.md §4.3 becomes "until the next message".
- **Suggested fix:** document this in SKILL.md, or have hc add a flag for waiting on a terminal without message interruption.

### 9. Every Codex Worker shows "⚠ 1 warning" — friction (benign)
- **What:** Codex startup warning: "Under-development features enabled: context_management … set `suppress_unstable_features_warning = true` in ~/.codex/config.toml". Viewing it needs `hc keys <t> f2`. I dismissed it on `leia` with `esc`.
- **Suggested fix:** set `suppress_unstable_features_warning = true`, or pass `-c suppress_unstable_features_warning=true` in a future Codex launch argv.

### 10. The Cursor-path role bootstrap replies on-screen, not over hc — friction
- **What:** The `role-bootstrap` instruction says "reply with exactly one line: ROLE_LOADED …" but doesn't say to send it with `hc send`. So the executor has to scrape `hc read` and pipe the line into `role-loaded` by hand. That worked for Codex, but the validation is copy-from-screen.
- **Suggested fix:** have the instruction include `hc send <executor> 'ROLE_LOADED …'` so the line arrives as a tagged message.

### 11. Minor scope note — `leia` searched MEMORY.md during role load
- **What:** During role bootstrap, `leia`'s Codex session ran a search over a MEMORY.md for "Herdr|ROLE_LOADED|workers.md|leia", which is outside "read workers.md". It's read-only and harmless, but it's a small standup-boundary drift.

## Outcome
- The mesh is **Operational**. Run `mesh-20261104175803-8329`: 5 members, 10/10 pairs PASS, 4/4 READY_ACKs.
- Evidence dir: `/private/tmp/claude-501/-Users-joshuamanlunas-Projects--LOCAL-NPM-herdr-meshed-agents/30b05253-c20d-4daa-99f6-e7471b91cd23/scratchpad/mesh-20261104175803-8329`.


### 12. Roster names invisible in Herdr — fixed
- **What (reported by the user, with a screenshot):** pane headers read only "Claude Code"/"Codex" plus the folder, and every Agents row read "_LOCAL_NPM · Herdr meshed agents skill via hc". The cause: the shipped `pane` header mod shows `program.name` for agents, and the `agents` mod labels each agent with its *tab's* lead title. Neither reads the hc terminal name or the `mesh.name`/`mesh.role` labels the skill sets.

## Fixes (2026-11-04)

All edits are in this folder and synced to `~/.agents/skills/herdr-meshed-agents`. `node --test mesh-config.test.mjs` passes 10/10.

| # | Fix |
|---|---|
| 1 | `parse` accepts `--effort` / `--oracle-effort` and a `model:effort` suffix. `launch-args --effort` maps to `claude --effort`, `pi --thinking`, and `codex -c model_reasoning_effort="…"`. Levels are validated per kind; Cursor rejects effort. |
| 2 | Kind is inferred from the model family (GPT/codex/o-series → `codex`, Claude family → `claude`). `--oracle-model` alone implies an Oracle. SKILL.md has a "Natural-language requests" mapping rule. The request from this run is now literally `3 gpt-6.1-sol:high --oracle-model claude-fable-5-1:medium`. |
| 3 | SKILL.md §1.5: Pi needs a fully qualified `provider/id` plus `pi auth check --provider <p> --json` = ready, and never a silent fallback. The default kind is `claude`, never Pi (user: "DO NOT USE Pi"); Pi runs only on an explicit `--kind pi`. A rule in the Invocation section says to respect harness bans. |
| 4 | SKILL.md §1.2 documents that `--append-system-prompt-file` is missing from `claude --help` but works (verified 2.1.318). |
| 5 | `codex` is a first-class kind in `parse`, `launch-args`, and `role-bootstrap`: `--no-daemon`, `-C <cwd>`, `-m`, effort, and the role bootstrap as the initial prompt (`deliver: "launch-prompt"`). Needs `--executor`. Verified with a live probe. |
| 6 | SKILL.md documents that `pane.split` has no folder (a new pane inherits its source pane's folder), that the caller cwd is `.foreground.cwd` and not `.cwd`, and that Codex gets `-C`. The post-launch check now includes `.foreground.cwd`. |
| 7 | New `split-plan --count --cols --rows` helper: largest-pane-first, splits along the visually longer side, an 80×16 minimum, and a `Layout capacity` error instead of slivers. SKILL.md §2.2 uses it. |
| 8 | SKILL.md §3 "Receiving messages": `hc wait <t>` returns `reason: "message"` on *any* message to the executor. Record the message and re-wait; the 120s bound is per check. |
| 9 | Codex argv includes `-c suppress_unstable_features_warning=true` (verified: no "⚠ 1 warning" on a live probe). |
| 10 | The role bootstrap tells the member to report via `hc send <executor> '<ROLE_LOADED line>'`. `role-loaded --from <terminal>` validates the hc-tagged message and its sender terminal. Verified live: `{"loaded":true,"from":"t18"}`. |
| 11 | The role bootstrap says "read the whole file … and nothing else: no other files, memory, searches, or repository exploration". The live probe read only `workers.md`. |
| 12 | New `herdr-mods/install.mjs`: clones `pane`→`mesh-pane` and `agents`→`mesh-agents` via `mod.clone`, applies anchored patches (marker `mesh-names v1`), runs `herdr-app check`, and retargets only a user-owned layout, with a backup. It's idempotent and has `--check` and `--uninstall`. SKILL.md §1.7 runs it, and it never blocks standup. Installed and verified on the live squad: headers show `leia · worker`, and Agents rows show `_LOCAL_NPM · leia · worker`. |
| — | Standalone fallback pointer in SKILL.md now names this source folder instead of the stale `jomans-pi-meshed-agents` copy. |

### 13. Squad members not nested under the orchestrator — fixed (delegated to the squad)
- **What (user, screenshot):** in the Agents list, ahsoka, leia, yoda, and oracle were top-level rows beside the orchestrator, though they are its delegates. The cause: `pane.split` terminals have no hc `parent`, and the Agents mod nests only by `parent`.
- **Work split:**
  - A1 (leia) investigated real parentage.
  - A2 (yoda) implemented the mesh-agents v2 patch.
  - A3 (ahsoka) wrote `herdr-mods/install.test.mjs`.
  - Q1: the Oracle advised Option C.
  - The orchestrator reviewed, installed live, and updated SKILL.md.
- **Findings (A1):**
  - `hc run --parent t12 --label herdr.space/tab` gets a pane without a focus change, but it always lands right of the tab's last leaf, with no way to set an anchor.
  - `terminal.keep` places relative to the focused pane.
  - There is no reparent API.
  - A child with a pane is listed both as a pane and as a sub_agent.
  - Children die with the parent unless started with `--outlive-parent`.
- **Decision:** Option C. Members carry a `mesh.parent=<executor>` label. mesh-agents v2 nests by `parent` OR `mesh.parent`, hides nested members from the top level, keeps them in `agent.next` order, and focuses a nested member's pane when its row is clicked. Real hc parentage stays open for later if Herdr adds anchored adoption; the v2 mod already lists real children once.
- **Verified:** `node --test` passes 19/19 (helper 10, installer 9). Both patched mods pass `herdr-app check`. The live upgrade went v1→v2 with no app errors, and a screenshot shows leia/yoda/ahsoka/oracle nested under `_LOCAL_NPM · orchestrator`.

### 14. Codex sandbox blocks the hc core socket — documented
- **What (seen in yoda's history):** "The sandbox blocked access to the Herdr core". Every `hc send`/`hc get`/`herdr-app check` from a Codex member needs a sandbox escalation, which the user's Codex approval reviewer decides. One send (P08) was auto-rejected ("authorization changed before approval could be applied") and retried. `herdr-app check` inside the sandbox hung on macOS services until it was rerun with an escalation.
- **Fix:** SKILL.md §2.3 documents this. Members retry rejected sends, the orchestrator asks the user when a member is `blocked`, and the skill never adds bypass flags on its own.
- **Open:** if a machine's Codex setup has no automatic approval reviewer, every hc command will block on a person. A permanent fix would need a Codex sandbox config that allows the hc socket; that's the user's call.
