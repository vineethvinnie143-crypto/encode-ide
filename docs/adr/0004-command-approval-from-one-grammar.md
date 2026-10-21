# 0004. Command approval from one grammar and one policy

- Status: Accepted
- Date: 2026-10-21

## Context

Forge auto-approved agent commands with a prefix regex (`SAFE_COMMAND`). `git status; curl …`
passed because the regex never saw `;`, `&&` or pipes. `npm test`, `npm run build` and `tsc`
ran unasked, but those run project code the agent can edit. `cat` matched without its
arguments being looked at. The approval settings were scattered, and two checkboxes no
longer did anything.

## Decision

- **One grammar.** `@encode/permissions` owns the eNCode Shell grammar: statements,
  pipelines, quoting, redirects, aliases and `~` expansion. The shell service parses through
  the same functions, so the policy and the interpreter cannot read a line differently.
- **One policy.** `assessCommand` says "allow" only when all of these hold. Any other line
  gets "ask" with a short reason.
  - Every command in every statement is read-only.
  - Nothing is redirected.
  - Every path argument stays inside the workspace.
- **Read-only is an allow list.**
  - Built-ins are classified, and an unclassified built-in fails at load.
  - External programs are checked option by option. `find -exec`, `rg --pre`, `sort -o`,
    `git diff --output` and `git -c …` ask, including the abbreviated long options that
    getopt_long and git accept.
  - Lines that ask regardless: control, zero-width or bidi characters, an unterminated
    quote, or a working directory outside the workspace.
- **Lexical first, then disk.** The verdict returns the paths and programs it relied on, and
  `electron/agent/approval.ts` checks them on disk.
  - Paths are resolved through symlinks, junctions and 8.3 short names, and must stay in
    the workspace.
  - No program may resolve to a file inside the workspace (a planted `git.exe`, say).
- **Four policies, one source of truth** (`decideApproval`). The composer and Settings show
  the same four:
  - Read Only: edits and commands are refused.
  - Workspace Write: edits run and every command asks.
  - Auto review: edits run, and a command runs unasked only when the steps above prove it
    read-only.
  - Full access: nothing asks.
- **Protected folders.** Writes into `.git` or `.eNCode` ask under every policy but Full
  access. They are checked lexically, in every spelling Windows normalizes (trailing dots
  and spaces, `:streams`), and again on the real path. A hook, an fsmonitor setting or a
  skill file written there runs code or steers the agent later.
- **git safety config.** Every git that eNCode runs, the agent's and the status bar's, gets
  command-line config that outranks the repository's: `core.fsmonitor=false`,
  `safe.bareRepository=explicit`, and no credential prompt.
- Ask and Plan modes never run edits or commands, whatever the policy.

## Consequences

- Auto review is useful for exploration (`ls`, `cat`, `rg`, `git log`) and asks for
  anything that builds, installs or runs project code.
- Tests include a 2,000-case property that no allowed line contains a writing or unlisted
  command, a redirect or an outside path. A differential property runs 1,000 generated lines
  through Auto review and executes every allowed one in a real shell: nothing in the
  workspace changes and nothing outside it is read.
- The verdict is not containment. A read-only git command in a folder whose `.git/config`
  someone else wrote can still start configured programs (`diff.external`, textconv, clean
  filters, pagers). Workspace trust (M3) closes this; see the threat model.
- When the agent moves to the OS shell ([0011](0011-agent-commands-run-in-the-os-shell.md)),
  this policy must grow a grammar for that shell or treat its lines as "ask".
