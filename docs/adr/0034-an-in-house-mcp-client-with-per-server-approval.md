# 0034. An in-house MCP client, with per-server approval

- Status: Accepted
- Date: 2026-10-21

## Context

MCP servers add tools, resources and prompts from outside the app. A server is a program the
user runs or a site they talk to, and what it sends is text a model reads. The project allows
no outside application-level libraries ([0003](0003-own-code-above-the-platform.md)), and the
official client SDK would be one.

## Decision

- `@encode/mcp` speaks JSON-RPC over stdio, Streamable HTTP and the older HTTP+SSE, with one
  `Connection` (requests, timeouts, progress, cancellation) behind every transport.
- The client answers `ping` and, when offered, the workspace roots. It refuses sampling and
  elicitation outright, so a server cannot make eNCode call a model or prompt the user.
- Everything a server sends passes strict parsers: control and invisible characters are
  stripped, lengths and counts are capped, and entries that cannot be used are dropped with a
  reason.
- Stdio servers start from absolute `PATH` entries only
  ([0005](0005-programs-from-absolute-path-entries.md)), with an allowlisted environment, and
  stop together with everything they started. On Windows a `.cmd` shim runs through `cmd.exe`
  only when no argument carries a character `cmd.exe` would read.
- HTTP never follows a redirect, so configured headers (tokens) cannot be sent to another site,
  and a legacy server may only name its own site.
- Servers are listed in `~/.encode/mcp.json` (the user's, trusted), `.mcp.json` and
  `.encode/mcp.json` (the folder's), in Claude Code's format with `${VAR}` and `${VAR:-default}`.
  A project server runs only when the folder is trusted and the user approved that exact
  entry by its digest, or settings the user wrote or approved enable it by name. A project
  server never replaces one the user set up. A changed entry stops at once and waits again.
- Tools are registered as `mcp__server__tool`, cut to 64 characters with a hash when needed,
  never colliding. Every call asks (`external` access) and runs in code mode only. What a
  server says about a tool, read-only hints included, is shown and never trusted.
- A result starts with a line saying it came from outside, is cut to a size the context can
  carry (head and tail), and carries at most four images.

## Consequences

- OAuth for HTTP servers is not implemented; a server that needs it does not connect.
- The labels on results are advisory (threat model RP1). The control is that every call asks.
- A `${VAR}` in an approved project entry can send an environment value to the URL the entry
  configures. The approval card names the variables. Threat model RP2.
