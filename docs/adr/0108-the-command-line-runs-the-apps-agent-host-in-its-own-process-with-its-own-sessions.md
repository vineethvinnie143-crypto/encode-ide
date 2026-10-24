# 0108. The command line runs the app's agent host in its own process, with its own sessions

- Status: Accepted, builds on 0030, 0063 and 0106
- Date: 2026-10-24

## Context

0030 put the agent in a host that clients drive, and said the command line would run that host inside its own
process. The desktop app is the product; the command line is an extra for people who live in a terminal, for scripts
and for CI: one request in, one answer out, with an exit status. It must be the same agent as the app's: the same
tools, approvals, folder settings and trust, hooks, MCP servers, checkpoints, code index, checks and Reviewer, the same
sandbox around commands, and the same plain errors. What the window shows (approval cards, questions, a proposed plan,
learned conventions, best-of-N attempts) needs a terminal form.

Keys are the risk that changes. The app keeps them sealed in its settings; a command line normally takes them from the
environment, and the agent's commands inherit the environment.

## Decision

### One agent, a terminal in front

- `apps/cli` (`@encode/cli`) builds the app's `AgentHost` and `Workspaces` in its own process, with the same options
  the desktop's agent host passes (worktrees through git found by absolute path, web access, the sandbox, transcripts
  for hooks, language servers in trusted folders). Nothing in `@encode/core` changes for it.
- The command line keeps its sessions, checkpoints and sandbox folder in `~/.encode/cli`, apart from the app's. Both
  that folder and the app's profile are off limits to the agent (0106) in the command line and in the app, and hidden
  from sandboxed commands; each session's own long results there stay readable to it.
- The Computer tool is off: it needs the app's banner and its stop key.
- Language servers: those on the PATH or in the project, those the app installed in its tools folder, and eNCode's own
  JSON, CSS and HTML server when the command line runs from the app. Installing a server stays the app's.

### Two ways to run

- **The prompt** (`encode`, optionally with a first request): the reply streams; each tool call is one line when it
  starts and one when it ends, with `+added -removed` for edits and the last line of a command's output. An approval is
  its title, details, warnings, the Reviewer's reason and a diff preview, answered with Enter or `y`, `s` for the
  session, `a` always (when the request offers it), `n`, or words, which refuse it and tell the agent what to do
  instead. A question takes a number or words. After a request the person is asked about a proposed plan (carrying it
  out switches to code mode, as the app's Approve does), lines for ENCODE.md, and which best-of-N attempt to keep. A
  line typed while the agent works steers the running request. Ctrl+C stops the request, refuses a pending approval or
  clears the line; twice, or Ctrl+D, leaves. Slash commands: `/help`, `/new`, `/sessions`, `/resume`, `/mode`,
  `/policy`, `/model`, `/best`, `/compact`, `/todos`, `/cost`, `/trust`, `/status`, `/exit`.
- **Print mode** (`encode -p`, or any request on a pipe): one request, then exit. Nobody is there, so an approval the
  policy leaves to the person is refused with a note that says so and asks the agent to finish without it, and a
  question is told to choose and say what it chose. Standard output carries the reply only (`text`), one result object
  (`json`: session, ok, result, error and its details, plan, model, usage, duration) or every event as a line of JSON
  (`stream-json`). Standard error carries problems and, with `--verbose`, what the agent does. Exit status: 0 when the
  request finished, 1 when it ended on an error, 2 for a wrong option, a missing model or key, or a missing folder.
- A folder is untrusted until the person says so: the prompt asks once, with the warning for a folder far larger than
  a project, and then about the settings it holds back; `--trust` trusts it without asking. Print mode never asks.

### Models and keys

- `--model provider:id` for `openrouter`, `anthropic`, `openai`, `deepseek`, `ollama` and `lmstudio`, `@free` for
  OpenRouter's zero-priced models (enforced by the router, with a warning that free models may keep what they are
  sent), `--base-url` for any OpenAI-compatible server, and `demo` for the offline scripted agent. ENCODE_MODEL and
  ENCODE_BASE_URL give defaults. One model serves every role; the router still checks what it can take.
- Keys come from the environment only (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`,
  `ENCODE_API_KEY` for `--base-url`). They are never printed: everything the command line writes is passed through
  the provider's redaction with the keys in use. The agent's commands start without them, as without every variable
  named like a key (0011's environment).

### What reaches the terminal

Everything from a session (replies, tool output, paths, plans, questions, errors) is made plain before it is written:
control characters, escape sequences, C1 controls and the characters that reorder or hide text become `?`, CRLF reads as
LF. JSON output escapes the reordering characters and the line and paragraph separators, which `JSON.stringify` leaves.
Colour follows the terminal and NO_COLOR, FORCE_COLOR, `--color` and `--no-color`. A pipe brings at most 4 MB.

### Shipped with the app

- The desktop build bundles `apps/cli/src/bin.ts` as `dist/electron/encode-cli.cjs` in the asar. `bin\encode.cmd`
  beside `eNCode.exe` runs the app's own program as Node (ELECTRON_RUN_AS_NODE, as for the installed language servers)
  on that bundle. It is in a folder of its own because Windows would otherwise find `eNCode.exe` first for `encode`.
  The command line removes ELECTRON_RUN_AS_NODE from its environment before anything starts, so the agent's commands
  and any Electron app they run start as themselves.
- From a checkout, `pnpm encode` (`scripts/encode.mjs`) bundles and runs it the same way.
- The packaged smoke runs `bin\encode.cmd --version` and a print-mode request on the demo agent from the installed
  layout.

## Consequences

- One agent behaves the same in the window and the terminal; a fix in the core reaches both.
- The command line's sessions do not show in the app, nor the app's in the command line. Sharing them would put two
  processes on one session store; that is left for later.
- Print mode is safe to script: with the default policy it cannot run what needs a person, and it says what it refused.
- A key in the environment is visible to everything else the person runs in that shell; that is the person's choice,
  and the command line does not widen it.
- Typing `encode` anywhere needs `bin` on PATH; the installer does not edit PATH. The portable build unpacks itself at
  every start, so its command line is not at a fixed path.
- Ctrl+C in print mode under `encode.cmd` makes cmd.exe ask "Terminate batch job?" after eNCode has stopped, as for any
  batch launcher.
