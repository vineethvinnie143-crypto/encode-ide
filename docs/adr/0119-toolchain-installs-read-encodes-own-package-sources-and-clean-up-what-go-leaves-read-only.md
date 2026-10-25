# 0119. Toolchain installs read eNCode's own package sources, and clean up what Go leaves read-only

- Status: Accepted, builds on 0114
- Date: 2026-10-25

## Context

On the first Windows computer that tried them, both toolchain installs of 0114 failed in Settings > Language servers:

- **C#**: "dotnet could not install it (exit 1): No NuGet sources are defined or enabled". `dotnet tool install` reads
  the computer's NuGet settings, and that computer's list no package source (or has nuget.org disabled). The same
  happens where a company's settings list only its own feed.
- **Go**: "EPERM, Permission denied: '...\tools\go\.partial-8bcf3148e562-work'". The go command writes its module
  cache without write permission even with `-modcacherw`, which leaves only the folders writable; on Windows that is
  the read-only attribute, and the Node.js inside Electron 44 (`fs.rmSync`, now native code) does not delete a
  read-only file. The failed clean-up ran in a `finally`, so it replaced the install's own outcome: gopls was built and
  then thrown away with an error that said nothing useful.

## Decision

- **eNCode's own nuget.config.** A toolchain installer may name `files`, written to its work folder before it runs and
  removed with it; `{<key>}` in its arguments is the file's path. csharp-ls is installed with
  `--configfile <work>/nuget.config`, which lists nuget.org alone (`<clear />` first, and no disabled source), so the
  computer's NuGet settings neither break nor redirect it. `dotnet tool install` reads only that file's settings when
  it is given one. This holds for eNCode's copy of the .NET SDK and for the computer's own. The install dialog says so
  in one sentence.
- **Removing a folder makes what is left writable and tries again.** After a first `rmSync`, every file and folder in
  the tree is given write permission (on Windows: the read-only attribute is cleared), without following a link out of
  the tree, and the removal runs again with retries for a file a virus scanner still holds. Removing an install
  (`Remove` in Settings) and the old versions after an update go the same way.
- **Clean-up never fails an install.** The work folder, the half-written folder and the download are removed quietly
  after an install: what the install did, or why it failed, is what the person reads. Whatever still could not go is
  swept by a later install of the same server or toolchain once it is a day old, since no install runs that long and
  a younger one may be another window's install in progress.

## Consequences

- C# installs on a computer with no NuGet source, or with a feed that does not mirror nuget.org. A person who must get
  packages through a company feed only is not served by the one-click install; they can still run the command the
  dialog's "install it yourself" offers.
- gopls installs on Windows with eNCode's copy of Go, and a failed removal can no longer hide a successful build.
- A leftover folder can sit in eNCode's tools folder for a day; it is under `.partial-*`, so nothing ever runs from it.
- `runtimes.test.ts`: the C# installer is given the file and its sources (with eNCode's SDK and with the computer's);
  a fake `go install` leaves a read-only module file and the work folder is still removed; a day-old leftover is swept
  while a fresh one stays. On the Windows CI job these run against the real read-only attribute.
