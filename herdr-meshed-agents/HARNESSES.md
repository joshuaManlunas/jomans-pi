# Herdr harness troubleshooting

## Launch arguments

`mesh-config.mjs launch-args` is authoritative. Compare the launch response to its JSON output when a harness starts with an unexpected model, effort, or role. These shapes show how each harness receives the role. Use `oracle.md` for the Oracle and `workers.md` for Workers. The helper supplies model and effort flags for values supplied in the invocation.

| Harness | Agent argv shape |
| --- | --- |
| Claude Code | `["claude","--append-system-prompt-file","<role-file>","--name","<name>","--model","<model>","--effort","<effort>"]` |
| Codex | `["codex","--no-daemon","-C","<cwd>","-c","suppress_unstable_features_warning=true","-m","<model>","-c","model_reasoning_effort=\"<effort>\"","<role bootstrap>"]` |
| Cursor | `["cursor-agent","--model","<model>"]` |
| Pi | `["pi","--system-prompt","<role-file>","--name","<name>","--model","<provider/id>","--thinking","<effort>"]` |

- **Claude Code.** `--append-system-prompt-file` preserves the default prompt and appends the role. In Claude Code 2.1.318, `claude --help` mentions the file flag only in the `--bare` description. If the installed CLI rejects the flag at launch, report its exact error.
- **Codex.** `--no-daemon` keeps commands inside hc. `-C` sets the caller's working directory and the config override suppresses the startup warning. The launch argv carries the role bootstrap as the initial prompt so the member receives it during startup.
- **Cursor.** `cursor-agent --help` exposes model selection. Deliver the role with the conversation step in [SKILL.md](SKILL.md#3-deliver-role-guidance-and-standup-cards).

## Codex sends and blocked members

Codex's sandbox blocks the hc core socket. Run `hc` and `herdr-app` commands with sandbox escalation from the first attempt. The user's approval settings govern escalation. If a send returns exit 5 or `unavailable`, the message was unsent. Retry the same command with escalation. Report any other send failure and preserve its output. A member that still cannot send prints `ROLE_BLOCKED <reason>` during role loading or `MESH_BLOCKED <reason>` during standup as its last line.

Use `hc get` and `hc read` on the affected member to identify its prompt or error. If progress requires a person to answer an approval, trust, or authentication prompt, ask the user and preserve their existing launch permissions. A command-group usage exit may still indicate an installed CLI, so check the specific subcommand's help.

## Why squad members are pane siblings

`hc run --parent <executor>` with `herdr.space` and `herdr.tab` labels can open a pane without moving focus, but it always lands next to the tab's last pane. `terminal.keep` places relative to the focused pane. `pane.split` accepts an exact anchor and direction, which lets the split plan preserve the requested geometry and user focus.

Herdr assigns real terminal parentage at launch. The skill records logical parentage with `mesh.parent`. The mesh-aware Agents list nests members by that label or by real hc `parent` and displays each once. Real hc children otherwise appear twice when they have a pane in the shipped Agents list, and their lifetime follows their parent unless launched with `--outlive-parent`.
