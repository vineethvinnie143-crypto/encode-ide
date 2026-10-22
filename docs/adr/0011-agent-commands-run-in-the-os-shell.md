# 0011. The agent's commands run in the OS shell

- Status: Accepted (decided by the owner on 2026-10-21); in effect since the desktop app runs the agent host
- Date: 2026-10-21

## Context

Claude Code-level accuracy depends on the agent's command tool behaving like the shell that
models are trained on and that project scripts expect: bash or zsh, and on Windows Git Bash
or PowerShell. The in-house eNCode Shell is line-oriented with its own grammar, so many
real-world command lines either fail or mean something slightly different. The owner chose
between keeping the eNCode Shell for the agent and running the OS shell.

## Decision

- The agent's command tool runs the operating system's own shell. That is bash or zsh on
  macOS and Linux. On Windows it is Git Bash, with PowerShell 7 as the fallback.
- The eNCode Shell stays the terminal panel's shell, and the grammar the command policy
  reads.
- Spawning a shell the user already has is not outside code under
  [0003](0003-own-code-above-the-platform.md).
- The prototype's `pwsh` tool, which ran commands in the eNCode Shell, is gone: the desktop
  app's agent runs `Bash` in the OS shell since it moved to the agent host
  ([0030](0030-the-agent-runs-in-a-host-that-clients-drive.md)).

## Consequences

- Approval must follow. A line for bash or PowerShell can do things the eNCode grammar
  cannot express: substitution, globbing side effects, functions.
  - Under Auto review, such lines either parse under a grammar for that shell or ask.
  - Workspace Write, Read Only and Full access are unaffected.
- Program resolution ([0005](0005-programs-from-absolute-path-entries.md)) still applies to
  locating the shell itself. The shell must start by its absolute path.
- OS sandboxing (Seatbelt on macOS, bubblewrap on Linux, M3) wraps the shell process.
  Windows has no equivalent yet, so approvals remain the control there.
