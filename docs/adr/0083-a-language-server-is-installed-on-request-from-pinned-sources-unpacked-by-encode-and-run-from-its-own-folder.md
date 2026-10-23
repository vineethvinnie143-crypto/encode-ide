# 0083. A language server is installed on request, from pinned sources, unpacked by eNCode, and run from its own folder

- Status: Accepted, builds on 0072 and 0073
- Date: 2026-10-23

## Context

0072 lets eNCode use real language servers as separate programs, and 0073 finds them on the PATH or in a project's
`node_modules/.bin`. That left the person to install each one with a command from Settings, which is where most
testers stop: they have no Node.js, or no idea which server a language wants. The committed editor scope (Editor 8)
asks for servers to be found for the languages a folder uses and installed with one click.

One click means eNCode downloads programs and runs them. That needs rules a person can trust without reading code:
what is downloaded from where, what checks it, what runs while it is installed, where it goes, and how it is removed.

Testing the first real servers also found that pyright never sent its problems: it registers pull diagnostics
dynamically, and the client said it could take a dynamic registration but never acted on one.

## Decision

### Which languages a folder uses

- **`detectLanguages`** walks the folder (at most 20,000 entries, 8 levels, 1.5 seconds), skipping `node_modules`,
  `.git`, build and cache folders, and counts the files each catalog server covers, and the files that mark a project
  of its kind (`package.json`, `pyproject.toml`, `fxmanifest.lua`, `pom.xml`, ...). A walk cut short says so (`partial`).
  The result is kept for a minute per folder.
- **The Settings report** gives each server how many of the folder's files it covers and its markers, and lists the
  servers the folder uses first, most files first.

### Three ways to install, all with fixed sources and fixed arguments

| Kind | Servers | What is fetched | What checks it |
| --- | --- | --- | --- |
| npm | TypeScript and JavaScript, Python (pyright), Bash, YAML | every package of the server's dependency tree, from `registry.npmjs.org` | the sha512 of each package, pinned in `npm-locks.ts` |
| download, pinned | Java (Eclipse JDT LS 1.63.0) | one archive from `download.eclipse.org` | its sha256, pinned in the catalog |
| download, newest release | Lua (lua-language-server), C and C++ (clangd) | the newest GitHub release's asset for this computer | the sha256 GitHub publishes for the asset; a release without one is refused |
| toolchain | Go (gopls 0.24.0), C# (csharp-ls 0.28.0), Rust (rust-analyzer) | what `go install`, `dotnet tool install` or `rustup component add` fetch | the toolchain's own checks |

- **npm is never run.** `scripts/server-locks.mjs` resolves each server's tree once, when eNCode is built, checks
  every tarball against the registry's sha512, and writes the compact lock (about 17 KB for the four servers). At
  install, eNCode downloads exactly those files, checks each hash, and unpacks them itself into `node_modules`. No
  package's install scripts run; a package for another system (its `os` or `cpu`) is skipped.
- **eNCode runs the npm servers on itself as Node.js** (`ELECTRON_RUN_AS_NODE=1` on the program's own file), so
  Node.js need not be installed. The variable is set only for that server's process; the agent's own environment
  still strips it. The packaged-program check in CI runs the built program this way over stdin and stdout.
- **Downloads** go only to `https`, only to the hosts above (`registry.npmjs.org`, `github.com`, `api.github.com`,
  `objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `download.eclipse.org`), following
  redirects by hand, each one checked against the same list, four at most. One download is at most 400 MB.
- **Toolchain installers** start without a shell, with fixed arguments, the agent's environment without secrets, and
  the new empty install folder as their working folder, so no project file (`go.mod`, `global.json`,
  `rust-toolchain.toml`) changes what is installed. A missing toolchain is said plainly ("needs Go").

### Unpacking

- **eNCode reads zip and tar (gzip or not) itself** (`archive.ts`): only stored and deflated zip entries, no Zip64, no
  encryption; tar files and folders only, with GNU long names and pax paths. Links, devices and every path that
  could land elsewhere are refused: absolute paths, drive letters, `..`, `:`, names Windows keeps for devices, a
  trailing dot or space, control characters. Each zip entry's CRC is checked. At most 40,000 files and 1 GB unpacked;
  gzip and deflate stop as soon as they pass the limit. An archive that breaks a rule is refused whole.
- **The files are written into a new folder** (`.partial-<random>`) that must not exist, with `wx` so nothing is
  overwritten, and two entries that differ only in case refuse the archive. The folder is renamed into place
  (`<tools>/<server>/<version>`) with a marker file only once everything is written; a failed or stopped install
  leaves nothing. Older versions are removed once a new one is in place (one still running goes next time).

### Where it lives, and how it is found and removed

- **The tools folder** is `%APPDATA%\eNCode\tools`, shared by every folder; caches a server needs (JDT LS's workspace
  data, one folder per project by a hash of its path) go in `server-cache`. Neither is in a project.
- **Discovery** looks in a project's own `node_modules/.bin` first, then the PATH, then the tools folder, so a copy
  the person installed always wins. A server installed or removed is found at once: every folder's hub looks again
  (stopping the server first when it is removed).
- **Remove** deletes only what eNCode installed, after the person confirms.

### What the person sees

- **Settings → Language servers**: each server says how many of the folder's files it covers. A missing one eNCode can
  install has **Install…** next to its command; one eNCode installed says so, with its version and **Remove**. An
  install shows its progress and **Stop**, and a failure says why until the next try.
- **The install dialog** says what will happen before anything does: each step, the version, about how much is
  downloaded, and the folder it goes in. Closing it leaves the install running; a toast says how it ended.
- **The editor** shows a bar above a file whose server is missing and installable: **Install…** or **Not now**. Not
  now is kept on this computer for that server. The footer's "not installed" opens the install dialog.
- **Servers still run only in trusted folders** (0073). Install is offered only where they may run: servers on, and
  the folder trusted.

### Pull diagnostics

- **The client advertises pull diagnostics as static only** (`dynamicRegistration: false`), so servers that offer them
  (pyright) say so in their capabilities. The editor's open documents are pulled 250 ms after each change and when the
  server asks for a refresh; a server that pushes is unchanged. This also gives the agent pyright's problems after
  its edits, which it never had.

## Consequences

- A tester with no Node.js, Python or Java tooling gets TypeScript, Python, Bash and YAML servers with one click, in
  about a second each on a normal line; Java needs Java 21 or newer, which the dialog says.
- **New versions need a build**: the npm locks and JDT LS are pinned, so an update is a commit that runs
  `scripts/server-locks.mjs`. Lua and clangd follow their newest release, trusting GitHub's published digest of the
  file; eNCode cannot pin those from where it is built, since the build machine cannot reach GitHub. Toolchain
  installs trust the toolchain.
- **eNCode depends on running as Node.js.** If the program's `RunAsNode` fuse is ever turned off to harden it, npm
  servers need another way to start (a utility process with stdio).
- A server eNCode installed is not updated by itself: a newer pinned version arrives with a new eNCode build and is
  installed when the person clicks Install again (or removes and installs).
- FiveM's own Lua setup, web languages (JSON, CSS, HTML, Tailwind, Svelte) and the rest of the editor's languages build
  on this in the next steps.
