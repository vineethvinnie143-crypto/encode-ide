# 0073. Worktrees are made by eNCode with hooks off, and language servers run in trusted folders for the editor and the agent

- Status: Accepted, refines 0072
- Date: 2026-10-23

## Context

Parity 3 brings the last tools of Claude Code's set that eNCode lacked: EnterWorktree and ExitWorktree, and LSP. It
also starts the language intelligence that 0072 allows: real language servers, found on the person's computer, that
eNCode talks to through its own client.

Three questions needed an answer before the code could be written.

- **Who runs git for a worktree.** `git worktree add` checks a branch out and runs the post-checkout hook. A project can
  point git at a hook folder of its own (husky's `.husky/_`), which is a folder the agent can write. If the agent ran
  the command, the hook would run through the sandbox; if eNCode ran it with hooks on, a hook the agent wrote would run
  outside it.
- **Where a language server runs.** 0072 said servers run "under the same rules as the agent's commands". A server is
  not a command: it is a long-running program that reads the whole project and its dependencies, writes caches and logs
  where its authors chose, and serves the editor too, before any agent runs. It can also run code the project names
  (TypeScript plugins in `tsconfig.json`, Rust build scripts and procedural macros, the project's own copy of a server
  in `node_modules/.bin`). The command sandbox wraps one process tree per command with the folder's rules; it was not
  built for a server shared by the editor and every session.
- **What the agent does with what a server reports.** Claude Code tells the model what an edit broke. eNCode's free
  pool runs weaker models, which leave errors behind more often, and the owner asked for accuracy above Claude Code's.

## Decision

### Worktrees

- **eNCode does the git work itself**, with fixed arguments and never as a command line of the agent's, and with hooks
  off (`core.hooksPath` pointed at a folder that does not exist). git is found on the PATH at each use.
- A worktree lives in the project at `.encode-worktrees/<name>`, on a branch `encode/<name>`, so the folder's rules and
  sandbox cover it as they cover the project. It is not under `.encode`, which is protected (every write there asks).
  The folder is kept out of the project's own `git status` by a line in the clone's `info/exclude`, and out of the
  file list, Quick Open and search.
- Only the main agent has the tools, and only in a git repository. A name is one plain path segment that is also a
  valid branch name.
- ExitWorktree `keep` leaves the worktree as it is. `remove` refuses while the worktree holds changes not committed or
  commits that no other branch has, and says what they are; `discard_changes` removes them anyway. Removing is judged
  as the git command it stands for, so it asks as such a command does.
- The session keeps the worktree in its log. A restart, a reset or a rewind puts the shell back where the log says,
  and a worktree whose folder is gone is let go of with a notice. The session header shows the worktree and its branch.

### Language servers

- **One hub per folder**, shared by the folder's sessions and the editor: a server runs once, not once per chat. It
  starts when a file of its language is first needed, in the editor or by a tool, and stops after ten minutes unused,
  unless the editor shows one of its files. A server that crashes is restarted a few times and then reported.
- **Servers run only in a folder the person trusts**, and only while Settings > Language servers is on. The project's
  own `node_modules/.bin` is looked in only then, before the PATH. On Windows an npm `.cmd` shim is read for the
  script it runs, which is started with Node directly, so no command line is handed to cmd.exe. Trusting a folder
  looks for the servers again at once; taking the trust back stops them and takes back their marks.
- **Servers run outside the command sandbox, like MCP servers**, in the project's folder, with the agent's environment
  minus anything that looks like a secret (API keys and tokens never reach a server). Nothing the agent types reaches a
  server's command line. This replaces the last point of 0072's decision.
- **The client is ours and bounded**: messages over 64 MB or headers that never end close the connection; a server
  may ask for an edit only of a command eNCode runs for an approved code action; documents over 8 MB are not given.
- **The agent's tools.** `LSP` looks things up (definitions, type definitions, implementations, references, hover,
  symbols, calls, diagnostics, code actions) with 1-based positions, and a symbol name finds the column. `LSPEdit`
  renames and applies code actions: it plans the change before it is judged, shows that plan on the approval card, and
  applies that same plan only when every file still reads as the server saw it, never outside the project, and through the
  checkpoint seam, so Rewind and the Turn view can put it back.
- **Errors after every edit.** After a step that changed files a server covers, the errors the change introduced (not
  the ones the file had before) reach the model with the step's results, in a system reminder; when the server is
  still checking, with the next step's. When they are fixed, the model is told so.
- **The error gate.** When the agent wants to end its turn while files it changed still have errors it introduced, it
  is sent back to fix them: once by default ("Once"), up to three times ("Up to 3 times"), or never ("Never"). The
  chat says why with a notice. The model may answer that the errors are expected instead.
- **The editor** gives the servers its text as it changes (after a quarter of a second of quiet, at once on a save),
  draws the errors and warnings they report under the text and in the gutter, tells a mark's message when it is
  pointed at, and counts them in the footer, which also says how the file's server stands. Settings > Language servers
  lists every server with its state, where it was found and the command that installs a missing one; Diagnostics
  reports the same with each server's last log lines.

## Consequences

- The agent has Claude Code's worktree and LSP tools, and the gate goes beyond Claude Code: a turn does not end with
  errors the agent made unless the person chose that, or the model says why.
- A server in a trusted folder can do anything the person can. Trust was already the line for the folder's hooks and
  MCP servers; servers follow it, and an untrusted folder starts none.
- Installing a missing server with one click, the editor features beyond diagnostics (completion, hover, rename and
  the rest in the editor itself) and the JSON, HTML and CSS intelligence of our own are the next milestone
  ("Editor and language intelligence"), on this client.
