# 0063. The agent's commands run in the operating system's sandbox, and the person is told what it does not hold back

- Status: Accepted, builds on 0004, 0011, 0041, 0053 and 0059
- Date: 2026-10-22

## Context

Approvals, rules and the Reviewer judge a command by its words (0004, 0040, 0059). Code the agent writes and then
runs reaches them by its name only (threat model RP9), and Full access asks nothing (R1). What bounds those cases is a
limit on what any command can change, whatever it is, set by the operating system: Claude Code and Codex both run the
agent's commands that way. The forces:

- **Each system has its own mechanism.** Linux has user namespaces (bubblewrap), macOS has Seatbelt (`sandbox-exec`),
  and Windows has, for a program without administrator rights, its integrity levels: a program at a lower level may
  not write, delete or rename what is labeled higher.
- **They do not hold the same things back.** Linux and macOS can hide files and block the network. Windows at the low
  integrity level limits what a command changes, not what it reads or sends.
- **A sandbox that breaks the person's tools gets turned off**, and one that claims more than it holds is worse than
  none. Git, npm, pnpm, node, PowerShell and the package caches have to work inside it.
- **Some files inside the project decide what runs later, outside any sandbox**: git's hooks and configuration, the
  folder's own settings, its MCP servers.
- **A repository must not be able to loosen it**, the same rule as every other folder setting (0041).

## Decision

- **One policy, three engines** (`@encode/sandbox`). The policy is built from the session's folders and the settings:
  - *writable*: the project folders, their git directories (a worktree's or a submodule's included), a temp folder of
    the sandbox's own, and the package caches (on Windows a cache folder of the sandbox's own, with npm, pnpm, yarn,
    pip, uv, Go, Corepack, NuGet and Gradle pointed at it unless the person set their own);
  - *protected* inside them, read-only: `.git/hooks`, `.git/config` and the files that say where a worktree's git
    directory is, `.encode/` and `.mcp.json`, plus `denyWrite`;
  - *unreadable* where the system can hide them: the usual credential folders, the sockets that carry an account's
    rights (docker, podman, containerd, the user's runtime folder), plus `denyRead`;
  - the network, allowed unless the person blocks it.

  Each engine states its `limits` (reads, network, protected paths, other programs), and the Sandbox screen turns
  every limit it lacks into a plain sentence.
- **Linux: bubblewrap.** The file system is mounted read-only with the writable folders read-write over it, the
  protected paths read-only again and the unreadable ones replaced by empty ones; the command has its own process
  and IPC namespaces, so it can neither see nor signal the person's other programs, and its own network when the
  network is blocked.
- **macOS: Seatbelt.** A profile that denies every write except in the writable folders, then denies the protected
  paths and the renaming of the folders that hold them, reads of the unreadable paths, and the network when blocked.
  It has not run on a Mac yet; the start-up test below keeps a wrong profile from ever being used.
- **Windows: the low integrity level.** A command starts from our helper (`encode-sandbox.exe`, C# 5 built on the
  machine from source in the repository, the method of 0053) as the person, without privileges, at the low integrity
  level, inside a job object that ends everything it started when the helper ends, and where the system allows it
  without the clipboard and other programs' windows. The folders it may change are marked once, by the helper, so that
  low-integrity programs may write them; the protected paths inside are marked back to medium before every command,
  so that a command cannot write them. That is best effort, and said so (`protectedPaths: 'best-effort'`): the folders
  around them are the command's to change. A folder too broad to mark is refused, with words: a whole drive or share,
  the home folder or one that holds it, the folders where programs keep their settings, Windows' own folders, the
  helper's folder and the program's. The marks stay after a command, so the next one starts at once; the folders
  marked are listed in the sandbox's state file and `release` takes the marks off again. Marking a large folder the
  first time takes a while, and the screen shows how far it is.
- **PowerShell is the shell that is confined on Windows**, and on by default. Git Bash cannot run at the low
  integrity level next to another program of its runtime (an open Git Bash window, for one): the runtime shares a
  namespace with all of them and a lower-level program is refused it. Turned off, commands run in Git Bash outside the
  sandbox, and the screen says so. A folder's settings can only turn PowerShell on.
- **Every engine proves itself before it is used.** At start the sandbox runs a command that must be able to write
  inside a writable folder and must not be able to write outside it (on macOS, also not into a protected path). An
  engine that fails is `unavailable`, with its reason on the screen; commands then run as before unless the settings
  require the sandbox, in which case none runs.
- **Settings**: the `sandbox` key of the settings files, checked in `@encode/sandbox` (0041 carries it). The person's
  own files decide. A folder's files may only tighten: turn the sandbox on, require it, block the network, keep the
  caches out, turn PowerShell on, add protected and hidden paths. `allowWrite` and `allowRead` are read from the
  person's own settings only.
- **Leaving the sandbox is the person's call alone.** The shell tool has an `unsandboxed` flag when the settings allow
  it. Such a command is asked about under every approval policy but Full access, which runs it without asking (0109), and
  no rule, "Always allow" or Reviewer answers for the person; Read Only refuses it. The model is told what is read-only, to use the flag only
  after a command failed for that reason, and, when a failed command's output looks like the sandbox stopped it, that
  the flag exists.
- **A repository without a hooks folder gets an empty one** before its first command, as `git init` would have made
  it: a protected path that does not exist is not held.

## Consequences

- On Linux the sandbox holds writes, reads, the network and other programs; on macOS writes, reads and the network.
  On Windows it holds writes only: a command can still read what the person can read, use the network and end the
  person's other programs, and its hold on the protected paths is best effort. The Sandbox screen says each of these
  in a sentence. A key or a document a command can read, it can also send.
- Hooks and approved MCP servers run outside the sandbox: they are the person's own programs (RP6).
- On Windows, a file moved into the project from elsewhere keeps its own mark and commands cannot change it until the
  person copies it instead. Git's hook scripts, and by default its ssh, use Git Bash's runtime, so they can fail
  inside the sandbox while a Git Bash is open; the agent is told it may be the sandbox and can ask to run that command
  outside.
- The marks on Windows are left on the project folders by design. A folder that stops being used keeps them until
  `release`; they let low-integrity programs write there and nothing more.
- Tests: the policy, the settings and the Linux and macOS arguments and profile are unit tests; bubblewrap runs for
  real where the machine allows it. On Windows the engine runs against the real helper in CI: writes, deletes and
  renames inside, the same refused outside, writes, deletes and replacements of the protected files refused, a git
  commit, nested programs, a leftover program ended, the start-up cost, and the marks taken off again. A separate
  workflow runs the package's tests on Windows whenever the package changes, with a table of everyday commands
  measured with and without the sandbox.
- Open: a way to take the marks off from the Sandbox screen, the submodule git folders under `.git/modules`, a Mac to
  run the Seatbelt profile on, and hiding files and blocking the network on Windows, which need more than an
  unprivileged program can do.
