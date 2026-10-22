# @encode/core

eNCode's agent: the loop, approvals, compaction, sessions, project memory, skills and subagents,
served to the desktop app and the command line through one host
([ADR 0030](../../docs/adr/0030-the-agent-runs-in-a-host-that-clients-drive.md)). It imports
neither Electron nor the DOM.

```
protocol ◀── providers ◀── tools ◀── core ◀── apps/desktop (utility process), apps/cli
```

Core asks a `ModelClient` (from `@encode/providers`) for the next step. The client is a
`DirectClient` for one model, or the router with failover and the free pool; core never knows
which. Core runs the tools of `@encode/tools` and shows a client what happens through events.

## Using the host

```ts
const host = new AgentHost({
  dir: sessionsFolder,                  // where the session logs live
  client,                               // a ModelClient
  settings: () => ({ policy: 'workspace-write', maxSteps: 30, maxGoalRounds: 8 }), // read at each use
  emit: (event) => send(event),         // every event of every session
  onJobs: (jobs) => send(jobs),         // background commands of all sessions
  workspace: openFolder,                // for sessions that belong to no project
})

const [session] = await host.sessions()
await host.start(session.id, { text: 'Fix the failing test', mode: 'code' }) // resolves when the turn ends
host.approve(requestId, { approved: true, remember: 'session' })
```

`AgentHost` is the whole API: sessions (create, update, rename, fork, remove, reset, export,
rewind), turns (`start`, `cancel`, `compact`), the user's answers (`approve`, `answer`), goals,
todos and plans, background jobs (`jobs`, `jobOutput`, `killJob`), `setWorkspace`, and the import
of an earlier build's sessions. Across a port, `serveHost(peer, host)` and
`createHostClient(caller)` give the same methods, with every request checked against a schema
(`HOST_SCHEMAS`) before it reaches the host.

A session works in its own project folder, so changing the open folder never moves a running
session. A session that belongs to no project follows the open folder once it is idle, and is told
when its folder changed.

## The loop

`AgentLoop` asks the model, runs the tools it calls, feeds the results back and repeats until the
model answers without a call or a tool ends the turn. The same loop runs a session's main agent
and its subagents, which differ in the `Surface` (what is shown and asked), the `Conversation`
(what is stored) and the tools they may use. Its invariants:

- **Every tool call is answered exactly once,** also when the run ends early, so the next request
  is always valid. A stop mid-step, a crash and a log from an older build are repaired the same
  way (`repairPairing`).
- **History is only appended to.** The one rewrite is compaction, and it drops thinking after the
  first changed message.
- **Calls that only read run together;** everything else runs in order.

A call whose JSON could not be repaired, or that fails its tool's schema, gets an error result the
model can act on. A model that answers with nothing is asked again a few times, then the turn
fails and says so. Steps are bounded (`maxSteps`), and a goal keeps the agent going between turns
up to `maxGoalRounds`.

## Approvals

`decideApproval` judges a call from what it would touch (`ToolAccess`), never from the tool's name:

| Policy | Reads | Edits in the workspace | Commands |
| --- | --- | --- | --- |
| Read Only | run | refused | only those proved read-only |
| Workspace Write | run | run | every command asks |
| Auto review | run | run | proved read-only run; the rest pass fixed checks and the Reviewer, then ask |
| Full access | run | run | run |

Under every policy but Full access, a write to a protected folder (`.git` or `.encode`) asks, as
does touching anything outside the workspace and the first fetch from each site in a session. A rule the user wrote (the assessor's `deny`) holds even under Full access.
The decision is `allow`, `ask` (with the reason, and whether the user may grant it for the rest of
the session) or `deny`. Protected folders are never grantable.

Under Auto review a command that asks on its own account (no rule, no hook) goes through
`screenCommand` in `@encode/permissions`, which stops everything a model must not decide, and then to
the Reviewer (`reviewer.ts`): one small model call on the `reviewer` role that sees the user's recent
requests and the command, and approves, declines or leaves the question to the user. Every failure
leaves it to the user ([ADR 0059](../../docs/adr/0059-auto-review-asks-a-model-about-low-risk-commands-behind-checks-the-model-cannot-overrule.md)).
`scan.ts` finds invisible and look-alike characters in what a call adds and reports them on the
card, in the step and to the model ([ADR 0060](../../docs/adr/0060-text-that-reads-differently-from-how-it-runs-is-shown-to-the-person-and-told-to-the-model.md)).

The user answers with a boolean, or `{ approved, note?, remember? }`: a note on a refusal goes back
to the model, and `remember: 'session'` allows the request's like for the rest of the session. Several
approvals can wait at once, in one session or across sessions. `AgentHistory.approvals` lists them
so a reopened session shows its cards again.

## Compaction

At 85% of the model's context window the conversation is shortened, from cheap to costly: old tool
outputs and call arguments are elided, then older units are summarized by the model, in units
that never split a tool call from its result ([ADR 0009](../../docs/adr/0009-compaction-keeps-every-tool-call-answered.md)).
What the user sees is kept whole. A request that still does not fit the window comes back from
the client as `compact` and is tried again after compacting.

## Sessions on disk

One append-only JSONL log per session in the sessions folder, with an index that is only a cache
([ADR 0031](../../docs/adr/0031-sessions-are-append-only-logs.md)). A crash costs at most the line
being written. `importLegacySessions` brings in an earlier build's single-file sessions once.

## Instructions, skills and agents

Project instructions come from `ENCODE.md`, `.encode/ENCODE.md`, `AGENTS.md` or `CLAUDE.md` in each
directory from the workspace to the repository root, then `ENCODE.local.md`, after the user's own
`~/.encode/ENCODE.md` ([ADR 0032](../../docs/adr/0032-claude-code-tool-contracts-and-reminders.md)).
Skills are `skills/<name>/SKILL.md` or `skills/<name>.md` in `~/.encode` and in the workspace's
`.encode`; the model sees each one's `description` until it loads it with `Skill`.

Subagents run the same loop on a conversation of their own, in memory, with the brief as their
first message and a report as their last. The built-in types are `general-purpose`, `Explore`, `Plan`
and `Review` (the last three read-only). Users add their own as Markdown in `agents/`: a front matter
with `name` and a required `description`, optionally `tools`, `disallowedTools`, `maxTurns`, `role`
(`model` is read as a role) and `color`, then the instructions. A subagent never gets `Task`,
`ExitPlanMode`, the goal tools or `TodoWrite`, inherits its parent's approval authority
([ADR 0006](../../docs/adr/0006-subagents-inherit-their-parents-authority.md)), and its approvals and
questions reach the user under the `Task` call. Files a repository fills (agents, skills, instruction
files) are read as regular files of bounded size and never through a link that leaves the project
([ADR 0061](../../docs/adr/0061-subagents-are-defined-in-markdown-and-what-a-repository-fills-is-read-as-a-stranger-s-file.md)).

## Hooks

`AgentHooks` are the points where code outside the loop can look, add context or change what
happens: `sessionStart`, `userPromptSubmit`, `preToolUse`, `postToolUse`, `beforeStop` and
`preCompact`. Every hook is optional and awaited. A hook that throws is reported as a notice and
counts as returning nothing, except `preToolUse`, where a failure denies the call. For
`preToolUse` a hook's `deny` always wins and `ask` asks even where the policy would allow, while
`allow` skips the prompt but never overrides a policy that denies.

## Testing

`@encode/core/testing` has harnesses over real temporary directories and a scripted model:
`loopHarness`, `sessionHarness` and `hostHarness`. A script is a list of steps (`{ text }`,
`{ calls: [{ name, input }] }`), or a function of the request and the step, and the harness records
every request the model received. `createScriptedClient` also drives the offline demo agent, which
needs no network or key.
