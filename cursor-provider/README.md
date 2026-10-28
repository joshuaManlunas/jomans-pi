# pi-cursor-provider

A [Pi](https://github.com/earendil-works/pi) extension that adds Cursor models as a native Pi provider (`cursor-agent`). Each turn runs through Cursor's **local SDK agent loop** ([`@cursor/sdk`](https://cursor.com/docs/api/sdk/typescript)) in your working directory. Cursor Cloud is available only as an explicit opt-in.

## Install

Requires Node.js 22.13+ and Pi 0.87+.

```bash
pi install /path/to/cursor-provider      # local checkout
pi -e /path/to/cursor-provider/extensions/cursor-provider/index.ts   # one-off trial
```

## Authentication

```text
/login cursor-agent
```

Pi prompts for a Cursor API key (create one at cursor.com → Dashboard → Integrations). The key is validated by listing models before it is saved to Pi's credential store (`~/.pi/agent/auth.json`, mode `0600`), and the model list is refreshed immediately.

- `CURSOR_API_KEY` in the environment is used when no stored key exists.
- `/logout` → `cursor-agent` deletes the stored key. `/cursor-agent logout` reminds you to also unset `CURSOR_API_KEY` if it is set.
- The key is never written to `cursor-provider.json`; an `apiKey` field there is ignored with a warning.

## Models and caching

Cursor models appear in Pi's normal model selector (`/model`, `--model cursor-agent/<id>`).

- Startup never waits on the network: Pi restores the last published list from its models store.
- Each session start triggers a non-blocking background refresh, which fetches only when the list is older than 6 hours (`modelCacheTtlMs`) and is skipped under `--offline` / `PI_OFFLINE`. Models from a first refresh are selectable from the next Pi launch (or immediately in the interactive `/model` picker). After 7 days without a successful refresh, `/cursor-agent status` marks the list as stale.
- A failed refresh (offline, auth error) keeps the previous list and records the redacted error.
- `/cursor-agent models refresh` forces a refresh; `/cursor-agent models` shows the count, source and last check time.

Metadata comes only from Cursor's `models.list` response:

- A model with several `context` values becomes one Pi model per value (`gpt-5@1m`, for example); the default value keeps the plain ID.
- Thinking levels appear only when Cursor reports a reasoning parameter (`reasoning_effort`, `effort`, `reasoning`, `thinking`).
- Cursor does not report context windows for most models or token prices for any. Unreported windows use a 200k placeholder; costs show as 0.

## Commands and modes

| Command | Effect |
| --- | --- |
| `/cursor-agent status` | Runtime, mode, auth source, model cache state, settings path |
| `/cursor-agent models [refresh]` | Show or force-refresh the model list |
| `/cursor-agent mode <agent\|fast\|plan>` | Switch mode from the next message; saved in the session |

- **agent**: the default SDK agent mode.
- **fast**: selects the model's `fast` variant when Cursor offers one; otherwise the same as agent.
- **plan**: SDK `plan` mode (the agent plans and does not edit).

Flags for one run: `--cursor-agent-mode <mode>`, `--cursor-agent-runtime <local|cloud>`, `--cursor-agent-mcp-bridge`.

## Local vs cloud

Local is the default. Cloud runs in a Cursor VM against a remote repository and must be chosen explicitly:

```json
{ "runtime": "cloud", "cloud": { "repository": "https://github.com/you/repo", "startingRef": "main", "autoCreatePR": false } }
```

A local failure is reported as an error. **The provider never falls back to cloud.** Pi shows a warning at session start whenever cloud is active.

## Sessions

Each assistant message carries a `cursor-agent:<agentId>:<runId>` response ID. On the next turn the provider continues the live agent. After a restart it resumes the agent only if its latest run matches that ID; otherwise it starts a fresh agent with a deterministic transcript of the conversation. After each run, a compact run card (model, mode, runtime, status, continuity, Cursor tool activity) is saved in the session and rendered on restore.

## Images

Images attached in Pi are sent to Cursor as base64 PNG, JPEG, GIF or WebP up to 20 MB each (`maxImageBytes`). Cursor does not report image support per model, so all models accept images unless listed in `textOnlyModels`. An invalid, oversized or unsupported image fails the turn with a message that names the problem.

## Pi tool bridge (MCP)

Disabled by default. When enabled, Cursor can call your **active, non-builtin** Pi tools (tools from other extensions) through the SDK's in-process custom-tool MCP server. The bridge opens no port or socket, lives only for the current run, and is torn down when the run completes or is aborted, when the conversation moves on without tool results, and at session shutdown. Pi's built-in tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) are excluded unless named in `include`, because Cursor already has its own.

```json
{ "mcpBridge": { "enabled": true, "include": ["web_search"], "exclude": [], "callTimeoutMs": 600000 } }
```

`exclude` always wins over `include`.

## Settings reference

`~/.pi/agent/cursor-provider.json` (optional; invalid fields fall back to defaults with a warning):

| Key | Default | Notes |
| --- | --- | --- |
| `runtime` | `"local"` | `"cloud"` requires `cloud.repository` |
| `mode` | `"agent"` | `agent`, `fast`, `plan` |
| `cloud` | `{ "autoCreatePR": false }` | `repository`, `startingRef`, `autoCreatePR` |
| `mcpBridge` | disabled | see above |
| `settingSources` | SDK default | `project`, `user`, `team`, `mdm`, `plugins`, `all` |
| `textOnlyModels` | `[]` | base model IDs without `@context` |
| `maxImageBytes` | 20 MB | per image |
| `modelCacheTtlMs` | 6 h | background refresh interval |

## Troubleshooting

- **"No Cursor API key is configured"**: run `/login cursor-agent` or export `CURSOR_API_KEY`.
- **Authentication failed**: the key was revoked or mistyped; log in again.
- **Model not found / no metadata**: run `/cursor-agent models refresh`; the model may have been retired.
- **Cursor SDK unavailable**: reinstall the package; `@cursor/sdk` needs Node 22.13+.
- **Cloud error about `cloud.repository`**: set it, or set `"runtime": "local"`.
- **Stale model list**: check network access, then refresh.

## Security

- Keys live only in Pi's credential store or your environment and are redacted from every error message.
- Cloud is never selected automatically.
- The tool bridge is off by default, exposes only tools you have active, and uses no network interface.
- Local runs execute Cursor's agent with your user permissions in the current directory. Use plan mode to review before edits.

## Compatibility

Built and tested against `@cursor/sdk` 1.0.32 and Pi 0.87.1 (`@earendil-works/pi-coding-agent`). The Cursor SDK is new; newer SDK versions may change model parameters or run events.

References: [Cursor TypeScript SDK](https://cursor.com/docs/api/sdk/typescript), [Cursor Cloud Agent API](https://cursor.com/docs/cloud-agent/api/endpoints), [fitchmultz/pi-cursor-sdk](https://github.com/fitchmultz/pi-cursor-sdk) (MIT; design reference only).

## Development

```bash
npm install --ignore-scripts --legacy-peer-deps
npm run check        # typecheck + biome + bun test
npm run pack:check
```

## License

MIT
