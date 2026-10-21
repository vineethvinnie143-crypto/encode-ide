# 0032. Hooks in Claude Code's format, and a broken guard denies

- Status: Accepted
- Date: 2026-10-21

## Context

Users carry hooks over from Claude Code: commands that run before and after tools, on
prompts and when the agent stops. Hooks are also the place where guards live, so a hook
that cannot run must not quietly let a call through.

## Decision

- `@encode/hooks` reads the `hooks` key of the settings files (`PreToolUse`, `PostToolUse`,
  `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `PreCompact`) with regex
  matchers. Each event runs its matching commands at once with Claude Code's JSON on stdin and
  `CLAUDE_PROJECT_DIR` and `ENCODE_PROJECT_DIR` set.
- Exit 0 succeeds, and JSON on stdout may decide (`permissionDecision`, `decision: "block"`,
  `continue: false`), change a tool's input or add context. Exit 2 blocks, with stderr as the
  reason. Any other exit is reported and the agent goes on.
- Stricter than Claude Code in three places:
  - a `PreToolUse` hook that cannot start, crashes or times out denies the call;
  - several answers combine as deny, then ask, then allow (the core never lets an allow
    override a policy that denies);
  - a `Stop` hook may send the agent back at most three times in a row.
- A command that outlives its timeout (60 seconds unless set) is stopped with everything it
  started: its process group on macOS and Linux, `taskkill /T` on Windows.
- Hooks from a folder's files run only under 0031.

## Consequences

- The result is an object shaped like the core's `AgentHooks`; the core combines it with its
  own hooks and the checkpoint hooks through `combineHooks`.
- A hook runs with the user's rights, outside any sandbox. That is what a hook is for, and why
  a folder cannot install one by itself.
