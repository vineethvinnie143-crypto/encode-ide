# 0005. Programs resolve only from absolute PATH entries

- Status: Accepted
- Date: 2026-10-21

## Context

On Windows, libuv looks for a bare program name in the child's working directory before
`PATH`. An empty or relative `PATH` entry also means "a working directory". Three places
started programs by bare name:

- The status bar's `git status`, run from the app's working directory. A `git.exe` in the
  folder eNCode was launched from would run on startup.
- npm shims whose `node.exe` was not beside them, which picked up a `node.exe` from the
  project.
- `taskkill`.

Separately, the eNCode Shell copied `process.env` as-is. Windows spells the variable `Path`,
so every `PATH` lookup failed and external programs were "command not found".

## Decision

- `electron/services/programs.ts` owns program lookup.
  - A bare name is searched only in absolute `PATH` entries (drive or UNC roots on Windows,
    quotes stripped).
  - `PATHEXT` is applied the way cmd.exe applies it.
  - Every program is started by its absolute path.
  - `taskkill` comes from System32.
- Environment names are matched case-insensitively on Windows. `export`, `set` and `unset`
  update the spelling that already exists.
- Batch files (`npm.cmd` and the like), which Node refuses to spawn directly, run through
  cmd.exe only when every argument is plain. Arguments cmd.exe would reinterpret (spaces,
  quotes, `%`, `&`, `|`, `^` …) are refused with a hint to use `cmd /c` explicitly.
- Batch files and agent commands run with `NoDefaultCurrentDirectoryInExePath`, so cmd.exe
  does not search the project for bare names either.

## Consequences

- A program planted in the workspace or the launch folder never runs because of its name.
- `npm --version` is not read-only under Auto review on Windows. `npm.cmd` loads the
  project's npm config before printing anything.
- The end-to-end smoke runs `node --version` and `npm --version` in the eNCode Shell on the
  Windows CI runner. That exercises `Path` casing and the batch-file path.
