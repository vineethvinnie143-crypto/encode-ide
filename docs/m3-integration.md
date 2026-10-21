# Wiring M3 into the core

Status: written with the M3 pull request (permission rules, trust, hooks, checkpoints, MCP
client). **None of this is wired into the app yet.** The pull request adds libraries and
touches no code of `apps/desktop`, `@encode/core` or `@encode/tools`. The wiring waits for the
core pull request (#8), whose seams these packages were built against.

## What was checked already

A scratch merge of this branch with the core branch type-checks these assignments, with no
change to either side:

| This repository | Core's seam |
| --- | --- |
| `ExternalTool` (`@encode/mcp`) | `Tool` (`@encode/tools`) |
| `ToolRegistry` | `ToolSink`, the registry `McpManager` registers into |
| `createCommandHooks(...)` (`@encode/hooks`) | `AgentHooks` (`@encode/core`) |
| `checkpointHooks(service)` | `AgentHooks` |
| `createShellAssessor(...)` (`@encode/permissions`) | `ShellCommandAssessor` |
| `CheckpointService.beforeWrite` | `ToolContext.beforeWrite` |

## Wiring, in order

1. **Settings and trust.** `loadSettingsSources({ home, root, read: readText })` then
   `resolveSettings(sources, { folderApproved })`, where `folderApproved` comes from
   `new TrustStore(file, nodeTrustFs, windows).state(rootReal, folderConfigDigest(sources))`
   (`.configApproved`). Show `heldBack` and `problems` in Settings. Reload on file change.
2. **Shell rules.** `createShellAssessor({ rules: new RuleSet(rules, { root, home, windows }),
   trusted, probe })` becomes the `ShellCommandAssessor`. `trusted` comes from the trust store:
   git runs unasked only there (threat model R3). Rules for `Read`, `Edit`, `WebFetch` and
   `mcp__*` are asked with `RuleSet.evaluate({ type: 'read' | 'write' | 'web' | 'mcp', ... })`
   from the policies of the file tools, web tools and `external` access.
3. **Approval card.** "Always allow" calls `suggestRule(call)`; the buttons save with
   `saveRule({ scope, behavior, text, home, root, fs: nodeTrustFs, trust })` and show the
   result: `approved: false` means the rule is saved but held back until the user reviews the
   folder's settings. Approving an MCP server calls `McpManager.approve(name, digest)`.
4. **Hooks.** `loadHookGroups(resolved.hooks)` then `createCommandHooks(groups, { env, runner:
   createProcessRunner(...), notice })`. Combine: `combineHooks(checkpointHooks(service),
   commandHooks, reviewer)` with the checkpoint hooks **first**.
5. **Checkpoints.** One `CheckpointService` per session: `new CheckpointService({ fs:
   nodeCheckpointFs, dir: checkpointDir(base, rootReal), roots, sessionId })`. Pass
   `service.beforeWrite` as `ToolContext.beforeWrite`. `/rewind` and the rewind UI use
   `turns()`, `planRewind(turn)`, `apply(plan, { force })`, `canRedo()` and `planRedo()`; after
   a rewind, `SessionLog.truncateAfter` cuts the conversation. Run it only while the agent is
   idle. Call `pruneStore` on a schedule.
6. **MCP.** `loadMcpConfig({ home, root, read, platform })`, then `new McpManager({ root, home,
   entries, policy, trust, tools: registry, env, onStatus })` and `start()`. Call `update(entries,
   policy)` when `.mcp.json`, `.encode/mcp.json` or the settings change. `McpManager.callTool`
   is what `ExternalTool.run` calls. The approval policy turns `{ type: 'external', server }`
   into the rule query `{ type: 'mcp', server, tool: tool.mcp.ruleTool }`. Add
   `instructions()` to the system prompt as outside text, never as instructions.
7. **Windows details the core owns.**
   - `programs.ts` should use `GIT_SAFETY_CONFIG` and `withGitSafety` from `@encode/permissions`.
   - PowerShell lookup must include `.ps1`.
   - M0's skills read `.eNCode/skills` where settings use `.encode`; one spelling has to win.

## Later M3 pull requests (not in this one)

| Piece | Why it waits |
| --- | --- |
| OS sandbox: Seatbelt on macOS, bubblewrap on Linux, an allowlist proxy, and the Windows evaluation | A package of its own, with a `SpawnWrapper` that plugs into the core's shell once #8 is merged. Until it lands, R1 stays open and prompts are the control on every platform. |
| Search providers (Brave, Tavily, Exa) | Implements the core's `WebAccess.search`; needs the core's web tools. |
| Subagent definitions (`.encode/agents/*.md`) and the reviewer gate | Map onto the core's `Subagents` and hook points; need the core merged. |

## Known limits carried into the wiring

The ones that matter to the UI are in the threat model (RP1 to RP7). Two need UI work:
the MCP approval card must name the environment variables an entry reads (`ServerStatus.variables`),
and the rewind UI must say that changes made by shell commands are not restored.
