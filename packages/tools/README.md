# @encode/tools

The agent's tools: files, search, the OS shell with background jobs, the web, and the tools that
talk to the user. They follow Claude Code's contracts
([ADR 0032](../../docs/adr/0032-claude-code-tool-contracts-and-reminders.md)), run the same in the
desktop app's agent host, the command line and the tests, and import neither Electron nor the DOM.
Everything a tool needs from the outside arrives through `ToolContext`.

| Tools | Notes |
| --- | --- |
| `Read`, `Write`, `Edit`, `MultiEdit` | Absolute paths, `cat -n` output, read before write, exact-match edits. Encoding (UTF-8, with BOM, UTF-16 LE) and CRLF line endings survive a write; a file that is not valid UTF-8 is read as Windows-1252 and written back byte for byte, and a character that encoding has no byte for is refused instead of turned into `?`. A file over 20 MB is refused by all four. An `Edit` whose text is not found lists the nearest lines, and one that matches more than once lists the line numbers. `Read` returns PNG, JPEG, GIF and WebP images as images and shows notebooks cell by cell; a PDF is not read yet, and the answer points to a converter run through `Bash`. |
| `Glob`, `Grep` | Own glob matcher; `Grep` takes JavaScript regular expressions in ripgrep's style (`(?i)`, file types, context lines). `.gitignore` honoured, `.git` and `node_modules` skipped, directory links not followed. File lists come newest first. `Grep` reads 16 files at once, searches older ANSI files too, skips binary files after their first 8 KB, and in content mode answers in path order and stops after a whole number of files when a search finds far too much, saying so. |
| `Bash`, `BashOutput`, `KillShell` | The OS shell, with background jobs. |
| `WebFetch`, `WebSearch` | Public addresses only; results are labelled untrusted. |
| `TodoWrite`, `AskUserQuestion`, `ExitPlanMode`, `Task`, `Skill` | Talk to the user or shape the session. `Task` and `Skill` appear only when the session has subagent types or skills. |
| `CreateGoal`, `UpdateGoal`, `GetGoal`, `attempt_completion` | Session goals; `attempt_completion` is off unless a model needs it. |

## A tool

```ts
interface Tool {
  definition: ToolDefinition       // name, description and JSON Schema the model sees
  kind: ToolKind                   // read | write | command | web | interaction | agent | other
  readOnly: boolean                // runs in plan and ask modes, and alongside other read-only calls
  access(input, ctx): ToolAccess   // what the call would touch: the approval policy decides from this
  describe(input, ctx): ToolSummary// the title, detail and diff preview of an approval card
  run(input, ctx): Promise<ToolOutcome>
}
```

The approval policy never looks at a tool's name, only at `access`: `none`, `read` or `write` of
absolute paths, `command` in a directory, `web` to a URL, `agent`, or `external` for a server
outside eNCode. A tool therefore cannot ask for less than it does.

`ToolRegistry` holds a session's tools. Built-in tools and tools from outside (MCP servers) register
the same way, each with its own schema. Every call is validated against that schema before it runs,
and a failure reads as something the model can fix. `builtinTools(options)` and
`createToolRegistry(options, extra)` build the set for a session. The set and its descriptions are
rendered once and kept, so the prompt prefix stays stable.

`@encode/tools/testing` has `tempWorkspace()` and a `ToolContext` over a real temporary directory
for tests.

## Paths

A relative path resolves from the workspace root, `~` from home, and on Windows a Git Bash path
such as `/c/Users/me` becomes `C:\Users\me`, since models read paths back from `Bash`. Containment
is checked on real paths (`realPathOf`, `isInsideReal`): a symlink, a junction or an 8.3 short
name cannot carry a write out of the workspace, and a path that does not exist yet is judged by its
nearest existing parent.

## The shell

`Bash` runs in the user's shell, never in a shell of ours
([ADR 0011](../../docs/adr/0011-agent-commands-run-in-the-os-shell.md)):

- **Which shell.** Windows: Git Bash, then PowerShell 7, then Windows PowerShell. `System32\bash.exe`
  is WSL's launcher and is never used. macOS and Linux: bash. `ENCODE_SHELL` names one explicitly,
  by absolute path. The tool's description tells the model which shell it is talking to.
- **One process per command,** with no profile sourced and stdin closed. The working directory
  carries over from one command to the next, variables do not. A command that ends outside the
  workspace has its directory reset to the root, and the result says so.
- **The command travels in a private script file,** not on the command line, so no layer of
  quoting changes what runs.
- **Programs are found only in absolute `PATH` entries** and started by absolute path
  ([ADR 0005](../../docs/adr/0005-programs-from-absolute-path-entries.md)).
- **The environment is the user's, minus credentials.** Variables that look like keys or tokens
  are removed unless the user keeps them by name, agent sockets are kept, commands are made
  non-interactive, and a repository's git config cannot start programs.
- **Output is bounded.** The start and the end of long output survive; `BashOutput` hands out only
  what is new, and a background job keeps its last megabyte. At most 32 jobs per session.
- **A sandbox plugs in** through `SpawnWrapper`, which rewrites every spawn. Windows has none yet,
  so the approval policy is the control there.

## The web

`safeFetch` connects only to public unicast addresses, checked on every connection after DNS, so a
name that resolves to the local network, or that rebinds, is refused. Redirects to another host are
handed back to the model instead of followed. Responses are decoded (including compressed ones,
with a cap on the decoded size), read as text only and truncated. `htmlToText` turns a page into
readable text and keeps `<main>` or `<article>` when the page marks one. Pages are cached for a
quarter of an hour. `WebSearch` needs no account.

## Seams

Kept stable for the milestones that build on them: `ToolContext.beforeWrite` (awaited before every
write; checkpoints), `SpawnWrapper` (sandboxing), `ShellCommandAssessor` (judges a shell line), and
`ToolRegistry.register` (tools from outside).
