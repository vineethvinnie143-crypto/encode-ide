# Architecture decision records

Each record states one decision, the forces behind it and what follows from it. Records are
never rewritten after they are accepted: a later decision supersedes an earlier one and both
say so.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-pnpm-monorepo-and-in-house-test-tooling.md) | A pnpm monorepo with in-house test tooling | Accepted |
| [0003](0003-own-code-above-the-platform.md) | Own code above the platform | Accepted |
| [0004](0004-command-approval-from-one-grammar.md) | Command approval from one grammar and one policy | Accepted |
| [0005](0005-programs-from-absolute-path-entries.md) | Programs resolve only from absolute PATH entries | Accepted |
| [0006](0006-subagents-inherit-their-parents-authority.md) | Subagents inherit their parent's authority | Accepted |
| [0007](0007-web-fetch-asks-per-site.md) | web_fetch asks per site and never reaches private addresses | Accepted |
| [0008](0008-api-keys-in-the-os-keychain-only.md) | API keys in the OS keychain only | Accepted |
| [0009](0009-compaction-keeps-every-tool-call-answered.md) | Compaction keeps every tool call answered | Accepted |
| [0010](0010-renderer-isolation.md) | A sandboxed renderer that only the app's page can use | Accepted |
| [0011](0011-agent-commands-run-in-the-os-shell.md) | The agent's commands run in the OS shell | Accepted |
| [0012](0012-windows-first-ci.md) | Windows-first CI with a sandboxed end-to-end smoke | Accepted |
| [0013](0013-own-icons-tokens-and-bundled-fonts.md) | Own icons, one token set and bundled fonts | Accepted, amends 0003 |
| [0014](0014-one-command-registry-and-no-project-switch-under-a-running-agent.md) | One command registry, and no project switch under a running agent | Accepted |
| [0015](0015-one-tab-model-for-the-side-and-bottom-panels.md) | One tab model for the side and bottom panels | Accepted |
| [0016](0016-windows-fonts-by-default-our-own-one-setting-away.md) | Windows' fonts by default, eNCode's own one setting away | Accepted, amends 0013 |
| [0017](0017-the-thread-draws-once-per-frame-and-only-what-changed.md) | The thread draws once per frame, and only what changed | Accepted |
| [0020](0020-the-free-tier-runs-behind-our-own-gateway.md) | The free tier runs behind our own gateway | Accepted |
| [0021](0021-sessions-are-rotating-device-bound-refresh-tokens.md) | Sessions are short-lived tokens with rotating, device-bound refresh tokens | Accepted |
| [0022](0022-connect-openrouter-with-pkce-on-a-loopback-listener.md) | Connect OpenRouter with PKCE on a loopback listener | Accepted |
| [0023](0023-failover-is-silent-and-only-a-clean-reply-is-committed.md) | Failover is silent, and only a clean reply is committed | Accepted |
| [0024](0024-a-model-is-free-only-when-the-listing-and-the-bill-say-so.md) | A model is free only when the listing and the bill say so | Accepted |
| [0030](0030-the-agent-runs-in-a-host-that-clients-drive.md) | The agent runs in a host that clients drive over a message port | Accepted |
| [0031](0031-sessions-are-append-only-logs.md) | Sessions are append-only logs | Accepted |
| [0032](0032-claude-code-tool-contracts-and-reminders.md) | Claude Code's tool contracts, and reminders instead of a changing prompt | Accepted |
| [0033](0033-the-editor-is-our-own-engine.md) | The editor is our own engine: text model, core and view | Accepted |
| [0034](0034-documents-live-outside-the-ui-store.md) | Open documents live outside the UI store, and "unsaved" is derived from the text | Accepted |
| [0035](0035-openrouter-presets-with-server-tools-go-through-the-messages-api.md) | A preset whose server tool chat-completions refuses is asked on the Messages API | Accepted |
| [0040](0040-permission-rules-are-judged-over-parsed-commands.md) | Permission rules are judged over parsed commands | Accepted |
| [0041](0041-folder-settings-grant-only-when-approved.md) | A folder's settings grant only what the user approved | Accepted |
| [0042](0042-hooks-in-claude-codes-format-fail-closed.md) | Hooks in Claude Code's format, and a broken guard denies | Accepted |
| [0043](0043-checkpoints-record-what-the-file-tools-change.md) | Checkpoints record what the file tools change, and rewinding never overwrites silently | Accepted |
| [0044](0044-an-in-house-mcp-client-with-per-server-approval.md) | An in-house MCP client, with per-server approval | Accepted |
| [0050](0050-the-desktop-is-used-through-one-tool-one-application-and-one-chat-at-a-time.md) | The desktop is used through one tool, one application and one chat at a time | Accepted |
| [0051](0051-tester-builds-carry-their-commit-keep-a-scrubbed-log-and-report-in-one-file.md) | Tester builds carry their commit, keep a scrubbed log and report in one file | Accepted |
| [0052](0052-every-model-call-goes-through-the-router-keys-are-asked-for-by-origin.md) | Every model call goes through the router, and keys are asked for by origin | Accepted |
| [0053](0053-the-windows-desktop-helper-is-our-own-program-built-on-the-machine-from-source-in-the-repository.md) | The Windows desktop helper is our own program, built on the machine from source in the repository | Accepted |
| [0054](0054-computer-use-is-opt-in-visible-while-it-runs-and-stoppable-from-anywhere.md) | Computer use is opt-in, visible while it runs, and stoppable from anywhere | Accepted |

## Template

```markdown
# NNNN. Title in the imperative or as a statement

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context
What forces are at play, and what was wrong or missing.

## Decision
What we do, precisely enough to check code against it.

## Consequences
What gets easier, what gets harder, and what is still open.
```
