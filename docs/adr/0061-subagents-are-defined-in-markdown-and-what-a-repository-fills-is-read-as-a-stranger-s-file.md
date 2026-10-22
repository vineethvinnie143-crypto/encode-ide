# 0061. Subagents are defined in Markdown, and what a repository fills is read as a stranger's file

- Status: Accepted, builds on 0006, 0041 and 0055
- Date: 2026-10-22

## Context

Subagents (0006) came with two built-in types, `general-purpose` and `Explore`, and a loader for definitions kept in
`~/.encode/agents/` and `<project>/.encode/agents/`. Three things were missing or unsafe:

- **Planning and review are the work people hand to a subagent most.** Claude Code has them, and a person who moves
  from it expects `Plan` and a reviewer. Each wants its own instructions and, ideally, its own model (a stronger one
  to plan, a careful one to review).
- **A definition could not say enough.** No tools to take away, no limit on steps, no way to name a model role, and the
  front matter other tools write (`disallowedTools`, `maxTurns`, `model: sonnet`, `color`) was read wrongly or not at
  all.
- **A repository fills the workspace's folders.** Agent definitions, skills and instruction files are text a stranger
  wrote when someone opens their repository. Read the obvious way, a file there that is a link to `~/.ssh/id_ed25519`,
  `.env` or a token file puts the key in front of the model, which can then be told to send it somewhere; a named pipe
  blocks the reader forever; a file of gigabytes fills the context or the memory. None of this needs a hook, a rule or
  a trusted folder.

## Decision

- **Two more built-in types, `Plan` and `Review`, beside `Explore`.** Read-only tools like `Explore`. `Plan` returns a
  plan the main agent can carry out (goal, approach and what was turned down, ordered steps with absolute paths and
  the functions involved, risks, how to verify) and never changes a file. `Review` returns findings by severity with
  file and line, how each fails and the smallest fix, says which tests cover the code and which do not, ends with a
  verdict, and never changes a file. Their model roles are `planner` and `reviewer`, `Explore`'s stays `explore`. The
  built-in names are reserved: no definition can take them.
- **A definition says more.** Besides `name`, `description`, `tools` and a prompt body: `disallowedTools` (taken away
  from `tools`, or from all tools when `tools` is absent), `maxTurns` (at most 100, and never past the person's own limit
  of steps nor the 40 a subagent may take: a definition can shorten a run, not lengthen it), `color` from a short list,
  and `role`. `model` is read as `role`, a name in eNCode's own list of model roles; the names other tools use for their
  models (`sonnet`, `opus`, `haiku`, `inherit`) mean nothing here and leave the main agent's model in place. Lists may be
  `Read, Grep`, `[Read, "Grep"]` or one per word, tool names match in any case, and `Task` and the other tools a
  subagent may never have stay excluded whatever a definition says.
- **A new or changed file reaches the model on the next turn.** The tools the session offers include a hash of the
  definitions, so the Task tool's list of types follows the folders without a restart.
- **A file in a folder a repository fills is read with care** (`safe-files.ts`). Regular files only: a link, a named pipe
  or a device is skipped, and the open uses `O_NOFOLLOW` and `O_NONBLOCK` so a link made between the check and the open
  does not matter and a pipe does not block. Agent files are at most 64 KB and 64 per folder, skill files 256 KB. The
  folder itself must stay inside the project once links are resolved: `.encode/agents` or `.encode` being a link to
  somewhere else makes the whole folder count as empty.
- **The user's own folders may use links.** `~/.encode/agents` and `~/.encode/skills` are the person's, and people keep
  them in a dotfiles repository and link them in, a skill folder included. Their links are followed (a pipe still is
  not read).
- **Instruction files get the same treatment.** `ENCODE.md`, `.encode/ENCODE.md`, `AGENTS.md`, `CLAUDE.md` and
  `ENCODE.local.md` of a project are skipped when, once links are resolved, they lie outside the folder they sit in.
  A link to another file inside the folder works, and so does the user's own `~/.encode/ENCODE.md`. `@imports` were
  already kept inside the workspace.

## Consequences

- A cloned repository cannot use its agent, skill or instruction files to read a file elsewhere on the disk, to hang
  eNCode or to flood it. A skill that was a link in a repository stops working, silently; the user's own does not.
- A person who defined agents for Claude Code finds `tools`, `disallowedTools`, `maxTurns`, `color` and `description`
  honoured, and `model: sonnet` ignored rather than treated as a role that does not exist.
- A repository-defined agent runs with the tools it names and the approvals of the parent: nothing here grants a
  permission (0006, 0041). A definition that names `Bash` gets `Bash` under the parent's policy, and its commands ask on
  the parent's card or go to the Reviewer (0059).
- The same reading rules apply to every file a repository can fill. Others that exist today and are not yet covered:
  hook, rule and MCP files are read by `@encode/config`, `@encode/hooks` and `@encode/mcp`, which have their own caps
  and trust steps (0041, 0055 to 0057); `.encode/settings*.json` and `.mcp.json` have not been given the link check and
  are on the hardening list.
- Tests: `safe-files.test.ts` (regular files, links, pipes, sizes, containment), `subagents.test.ts` (built-ins, front
  matter, caps, links, session-level tool filtering, step limits, roles, the list following the folder),
  `skills.test.ts` and `memory.test.ts` (links in a repository and in the user's folders). The link and pipe cases skip
  themselves on a system that will not create them, which on Windows means without the privilege.
