# background-task

A Pi extension for running shell tasks without blocking the current turn.

## Security

Pi packages have full system access. Review this source before installing it, and use a trusted local checkout or a pinned Git revision. Tasks run with the current user's permissions; do not pass untrusted input to a shell command.

## Install

From a local checkout:

```bash
pi install /absolute/path/to/background-task
pi -e /absolute/path/to/background-task
```

From a Git source (replace the placeholders with a reviewed source):

```bash
pi install git:<host>/<owner>/<repo>@<tag-or-commit>
pi -e git:<host>/<owner>/<repo>@<tag-or-commit>
```

From an npm-compatible source, when one is available:

```bash
pi install npm:<package-name>
```

The Git and npm examples intentionally make no repository or publication claim.

## Usage

Start a task; the command returns a stable ID for the current Pi session:

```text
/background start -- npm run build
/background run -- ./scripts/check.sh
background npm run build
```

The plain `background ...` form is shorthand for starting a task. Manage that task with its session-local ID:

```text
/background list
/background inspect bg-1
/background stop bg-1
/background forget bg-1
```

IDs remain stable while the Pi session lives. They are not durable identifiers across a process restart.

`forget` removes a selected finished task and its captured output from session history. It refuses active tasks. Forgotten IDs are never reused in the session; inspecting or forgetting them again reports an unknown task. Finished tasks remain inspectable until explicitly forgotten or the session ends.

## Runtime boundaries

- stdout and stderr are captured in bounded buffers; excess output is truncated rather than retained without limit.
- Active tasks are cleaned up on shutdown, `/reload`, `/new`, `/resume`, and `/fork`.
- On POSIX, cleanup signals the task's process group with `SIGTERM`, then `SIGKILL` after the termination grace period.
- On Windows, cleanup uses `taskkill` for the shell's process tree, adding forced termination after the grace period.
- Task history is in memory only; restarting Pi loses history and session-local IDs.
- Commands beginning with `list`, `inspect`, `stop`, `forget`, `run`, or `start` should use `background run -- <command>` to avoid management-subcommand ambiguity.
- A command that self-daemonizes, double-forks, or otherwise detaches descendants may outlive cleanup. Use non-detaching commands when lifecycle cleanup matters.

## Validation

Run `bun run test` for the regression tests and `bun run bench:output` for the original-versus-bounded output append comparison. The benchmark reports runtime, chunk sizes, median batch latency, and retained backing storage; it makes no end-to-end latency claim.
