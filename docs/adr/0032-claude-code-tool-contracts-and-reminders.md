# 0032. Claude Code's tool contracts, and reminders instead of a changing prompt

- Status: Accepted
- Date: 2026-10-21

## Context

The owner wants the agent to be as accurate as Claude Code. Models are trained on that harness:
the tool names, the shape of their inputs and results, and habits such as reading a file before
writing it. M0's tools had names and results of their own, and its prompt changed with every turn.
That is a poor fit twice over: models misuse tools they know under another contract, and a prompt
or tool list that changes between turns defeats prompt caching. Some providers also tie each
thinking block to the conversation before it and reject the request once an earlier message is
edited.

## Decision

- **The tools follow Claude Code's contracts** (`@encode/tools`): `Bash`, `BashOutput`,
  `KillShell`, `Glob`, `Grep`, `Read`, `Write`, `Edit`, `MultiEdit`, `WebFetch`, `WebSearch`,
  `TodoWrite`, `AskUserQuestion`, `ExitPlanMode`, `Task` and `Skill`, plus the session goal tools
  and, for models that need an explicit way to stop, `attempt_completion`. The details that
  models rely on are kept:
  - absolute paths (relative ones resolve from the workspace, `~` from home, and on Windows a Git
    Bash path such as `/c/Users/me` becomes `C:\Users\me`);
  - `Read` returns `cat -n` lines, and `Write` and `Edit` refuse to change an existing file the
    agent has not read, or one that changed since it did;
  - `Edit` matches exactly and only forgives line endings, curly quotes and copied line-number
    prefixes, and only when that still finds exactly one match;
  - `Grep` and `Glob` honour `.gitignore`, skip `.git` and `node_modules`, and list the newest
    files first;
  - `Bash` runs in the OS shell ([ADR 0011](0011-agent-commands-run-in-the-os-shell.md)) and says
    in its description which shell that is.
- **A session's system prompt and tool list are fixed.** They are rendered once, with the tool
  descriptions that depend on the session (the shell, the subagent types, the skills), stored in
  the log ([ADR 0031](0031-sessions-are-append-only-logs.md)) and replayed as stored.
- **Everything that varies arrives as `<system-reminder>` blocks in user messages:** the
  environment (workspace, platform, shell, git branch, date) on the first message, after a
  compaction and when the workspace changes; the project's instructions; the mode; the active
  goal. History is never edited to add them.
- **Project instructions** come from the first of `ENCODE.md`, `.encode/ENCODE.md`, `AGENTS.md`
  and `CLAUDE.md` in each directory from the workspace up to the repository root, then
  `ENCODE.local.md`, with the user's `~/.encode/ENCODE.md` first and the most specific file last.
  A line `@path` imports another file when it stays inside the roots the agent may read. A
  repository that already has instructions for another tool works as it is.
- **The user's own folder is `~/.encode`**, shared by the desktop app and the command line:
  `ENCODE.md`, `skills/` and `agents/`. The workspace's `.encode/` holds the same kinds of file
  for one project. `.encode` is a protected folder: under every policy but Full access, writing into
  it asks, and the user cannot grant it for the rest of a session, since a skill or an agent
  definition steers later turns.
- **Containment is judged on real paths.** A symlink, a junction or an 8.3 short name cannot
  carry a write out of the workspace, and a write to a path that does not exist yet is judged by
  its nearest existing parent.
- **What the agent reads from outside is data.** Web pages and search results come back labelled
  as untrusted, and a closing tag inside them is neutralised.

## Consequences

- Models that know Claude Code use the tools correctly the first time, and results look the way
  they expect.
- Behaviour that is not Claude Code's has to be a deliberate addition, with a reason.
- The system prompt cannot change mid-session. A different prompt or tool set means a new
  session. Tuning the wording for a model family is a matter for evaluations, not edits in
  place.
- Reminders cost tokens on the turns that carry them. The environment is sent once, not every
  turn.
- `Bash` is as powerful as the user's shell. The approval policy and the command assessor are
  what stand between a prompt injection and the machine
  ([ADR 0004](0004-command-approval-from-one-grammar.md)).
