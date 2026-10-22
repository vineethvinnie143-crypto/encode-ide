# Wiring M3 into the core

Status: written with the M3 pull request (permission rules, trust, hooks, checkpoints, MCP
client). **Steps 1 to 3 and 7 below are wired into the app** (ADR 0055): settings and trust, the
shell rules, the approval card's "Always allow", the Permissions screen and the banner above the
composer. **Steps 4 and 5 (hooks, checkpoints and rewind) are wired too** (ADR 0056). **Step 6 (MCP)
is not wired yet**; it is the next pull request and hangs off the same per-folder snapshot
(`@encode/workspace`).

## What was checked already

Before the core merged, a scratch merge of this branch with the core branch type-checked these
assignments, with no change to either side. Nothing in the repository asserts them yet; the
wiring pull request does, by using them:

| This repository | Core's seam |
| --- | --- |
| `ExternalTool` (`@encode/mcp`) | `Tool` (`@encode/tools`) |
| `ToolRegistry` | `ToolSink`, the registry `McpManager` registers into |
| `createCommandHooks(...)` (`@encode/hooks`) | `AgentHooks` (`@encode/core`) |
| `checkpointHooks(service)` | `AgentHooks` |
| `createShellAssessor(...)` (`@encode/permissions`) | `ShellCommandAssessor` |
| `CheckpointService.beforeWrite` | `ToolContext.beforeWrite` |

## Wiring, in order

1. **Settings and trust (done).** `loadSettingsSources({ home, root, read: readText })` then
   `resolveSettings(sources, { folderApproved })`, where `folderApproved` comes from
   `new TrustStore(file, nodeTrustFs, windows).state(rootReal, folderConfigDigest(sources))`
   (`.configApproved`). Show `heldBack` and `problems` in Settings. Reload on file change.
2. **Shell rules (done).** `createShellAssessor({ rules: new RuleSet(rules, { root, home, windows }),
   trusted, probe })` becomes the `ShellCommandAssessor`. `trusted` comes from the trust store:
   git runs unasked only there (threat model R3). Rules for `Read`, `Edit`, `WebFetch` and
   `mcp__*` are asked with `RuleSet.evaluate({ type: 'read' | 'write' | 'web' | 'mcp', ... })`
   from the policies of the file tools, web tools and `external` access.
3. **Approval card (done).** "Always allow" calls `suggestRule(call)`; the buttons save with
   `saveRule({ scope, behavior, text, home, root, fs: nodeTrustFs, trust })` and show the
   result: `approved: false` means the rule is saved but held back until the user reviews the
   folder's settings. Approving an MCP server calls `McpManager.approve(name, digest)`.
4. **Hooks (done).** `workspaceHooks(config)` (`@encode/workspace`) reads the folder's snapshot, builds
   `createCommandHooks(groups, { env, runner, notice })` only from hooks that apply (the person's own, and the
   folder's once trusted and approved) and runs them in the agent's shell and environment. `Workspaces.scope`
   combines `combineHooks(recordingHooks(service), workspaceHooks(config))` (the reviewer gate joins later) with
   the recording hooks **first**; they cannot throw, so a failing store never skips a prompt hook. A hooks entry that cannot be
   read under `PreToolUse` makes the folder `broken` (ADR 0042, 0056). Hooks stop with the turn
   (`HookEvent.signal`).
5. **Checkpoints and rewind (done).** One `CheckpointService` per session, made by `Workspaces.scope` with the
   store under the profile (`userData/checkpoints`): `service.beforeWrite` is `ToolContext.beforeWrite` and fails
   the write when the earlier version cannot be kept. The host offers `checkpoints`, `rewindPlan`, `redoPlan`
   and `rewindApply` through `SessionCheckpoints`; `AgentSession.rewind(entryId)` cuts the conversation before a
   request and returns its text, and applying holds the session's controller so nothing runs meanwhile. The
   rewind dialog (a button on every request) and the notice's Undo are the UI. `pruneStore` runs once per
   folder per program run, in the background.
6. **MCP (next).** `loadMcpConfig({ home, root, read, platform })`, then `new McpManager({ root, home,
   entries, policy, trust, tools: registry, env, onStatus })` and `start()`. Call `update(entries,
   policy)` when `.mcp.json`, `.encode/mcp.json` or the settings change. `McpManager.callTool`
   is what `ExternalTool.run` calls. The approval policy turns `{ type: 'external', server }`
   into the rule query `{ type: 'mcp', server, tool: tool.mcp.ruleTool }`. Add
   `instructions()` to the system prompt as outside text, never as instructions.
7. **Windows details the core owns (done).**
   - The git settings and `withGitSafety` live in `@encode/permissions`; the agent's environment, the
     terminal and the status bar's `git status` use them (and set `GIT_OPTIONAL_LOCKS=0`, so a status
     does not rewrite the index and run the repository's hook). A test checks that the agent's
     environment is one the rules accept for git.
   - The program lookup the disk check uses includes `.ps1` scripts on Windows.
   - Skills live in `.encode/skills`, as the settings do; the text that said `.eNCode` is corrected.

## Later M3 pull requests (not in this one)

| Piece | Notes |
| --- | --- |
| OS sandbox: Seatbelt on macOS, bubblewrap on Linux, an allowlist proxy, and the Windows evaluation | A package of its own, with a `SpawnWrapper` for the core's shell. Until it lands, R1 stays open and prompts are the control on every platform. |
| Search providers (Brave, Tavily, Exa) | Implements the core's `WebAccess.search`. |
| Subagent definitions (`.encode/agents/*.md`) and the reviewer gate | Map onto the core's `Subagents` and hook points. |

## Known limits carried into the wiring

The ones that matter to the UI are in the threat model (RP1 to RP7). One needs UI work still:
the MCP approval card must name the environment variables an entry reads (`ServerStatus.variables`).
The rewind dialog already says, every time, that changes made by shell commands are not restored.
