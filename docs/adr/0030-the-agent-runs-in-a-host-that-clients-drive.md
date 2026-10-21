# 0030. The agent runs in a host that clients drive over a message port

- Status: Accepted
- Date: 2026-10-21

## Context

M0's agent lived in the Electron main process, next to window management, IPC, the terminal and
the key vault. That has three costs:

- A tool that hangs, a long compaction or a runaway search shares an event loop with the window,
  so the app can freeze while the agent works.
- A crash in the agent takes the app down with it.
- The agent cannot be used without Electron, so the command line, the tests and any later
  automation would need a second implementation.

The owner wants the agent to behave like Claude Code in the desktop app and in a terminal, with
one loop, one set of tool contracts and one approval path.

## Decision

- **Four packages, one direction.** `@encode/protocol` (RPC and JSON Schema checks), then
  `@encode/providers` (conversation, adapters), `@encode/tools` (files, search, shell, web) and
  `@encode/core` (loop, approvals, compaction, sessions, memory). None imports Electron, the DOM
  or React. A test that does fails to build ([ADR 0002](0002-pnpm-monorepo-and-in-house-test-tooling.md)).
- **One host.** `AgentHost` holds every session of one user behind one API: sessions, turns,
  approvals and questions, goals, forks, background jobs, export and rewind. `serveHost` and
  `createHostClient` carry that same API over a protocol `Peer` on any message port: an
  Electron utility process, an in-memory pair, a pipe.
- **The desktop app runs the host in a utility process.** The main process supervises it
  (`AgentHostService`):
  - it hands over what the host needs of the settings, which is the approval policy, the step
    limits and the active model's address, and never a key;
  - it answers the host's request for a key when a model call starts, so a key is in the host's
    memory only for that call and the vault stays in the main process;
  - it forwards events to the renderer, and starts the host again after it dies, with a pause
    that doubles up to 15 s (and stops after five failures in a row until the host is next needed),
    telling the user which sessions were mid-turn;
  - it asks the host to close its sessions and shells before the app quits.
- **The command line runs the host inside its own process,** with no port (it lands after this record).
- **Every request is data.** The receiving side checks the envelope, only calls registered methods
  and validates params against a schema before the host sees them, however trusted the caller is.
  Errors cross as a code and a message, never a stack.
- **The renderer's API does not change.** `apps/desktop/shared/types.ts` stays the contract with
  the UI, and `electron/agent-host/contract.ts` makes the build fail if the host's types drift
  from it.
- **What stays in the main process:** windows, settings and the key vault, workspace file
  operations, git status, schedules and the user's terminal. They do not need the host, and the
  host does not need them.

## Consequences

- The window stays responsive while the agent works, and a crashed host loses at most the step
  in flight: the conversation is in the session log ([ADR 0031](0031-sessions-are-append-only-logs.md)).
- Commands the agent started die with the host, background jobs included.
- The agent can be tested, scripted and run headless with the code the app runs.
- Each model call costs one extra message to fetch the key. That is small beside the call.
- A utility process uses Node's networking, which does not read the system proxy settings that
  Electron's own does. Support for a proxy (an explicit setting handed to the providers'
  transport) is open work.
- A second process costs memory: a bare Node process, tens of megabytes.
