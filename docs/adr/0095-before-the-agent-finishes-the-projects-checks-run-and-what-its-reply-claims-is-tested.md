# 0095. Before the agent finishes, the project's checks run, and what its reply claims is tested

- Status: Accepted, builds on 0073 and 0093; amended by 0140
- Date: 2026-10-24

## Context

0073 sends the agent back when the language servers report errors in the files it changed. That is all that stood
between a request and its answer:

- a test the change broke, a type error in a file the agent did not touch (the caller of a function it changed), and
  any language without a server reached the person as a finished answer;
- a model could end with "All tests pass" when it ran none, or ran them before its last edit;
- a reply could name a file that does not exist, or say it added `validateToken()` to `src/auth.ts` when the edit never
  landed, and nothing looked;
- an agent that did run the tests could not tell a failure it caused from one the project had before, and either
  "fixed" tests it was not asked to touch or stopped at the first red line.

## Decision

### The project's checks

eNCode finds at most four checks, typechecks first, in the folder where the agent's shell is, or the nearest folder
above it that has any, never above the workspace (a shell outside the workspace has none):

- `package.json`: a script named `typecheck`, `type-check`, `check-types`, `types:check` or `tsc`, and `test` unless it
  is npm's placeholder or watches; run by the package manager its `packageManager` field or lockfile names
  (`pnpm run x` / `pnpm test`, `yarn x`, `bun run x` / `bun run test`, `npm run x` / `npm test`);
- a `tsconfig.json` that compiles something, where TypeScript is installed and no script typechecks:
  `<runner> tsc --noEmit`;
- `Cargo.toml`: `cargo check --all-targets`, `cargo test`; `go.mod`: `go vet ./...`, `go test ./...`;
- Python with mypy set up: `python3 -m mypy .`; with pytest set up (or a `conftest.py`): `python3 -m pytest -q`
  (`python` on Windows).

A settings file's `checks` list (at most four single-line commands) replaces them, and an empty list runs none. A list
in a folder's own settings is held back, like its other grants, until the person trusts the folder and approves it.

### The check gate

When the main agent in Code mode ends a request that changed code (its edits and writes, and its subagents'), after the
language servers' gate of 0073, eNCode runs the checks in order and stops at the first that fails:

- a check that ran since the last change, by eNCode or by the agent (`npm run test` is `npm test`), is not run again;
- each runs as a Bash call of eNCode's own, through the same permission check, approval, sandbox and hooks as the
  agent's commands, for at most ten minutes. It shows in the work log as eNCode's ("Check the changes: tests"), and
  the agent's reply stays the reply. Workspace Write asks before each, and **Always allow** saves a rule for it;
- a check the person refuses ends the checks for that request, and the agent is not told;
- a check that does not finish is passed over with a notice;
- a new failure goes back to the agent with the output (kept whole in a file when long, as 0093), what passed, what was
  not run, and "Fix what your changes broke, then finish. If a failure is expected or not caused by your changes, say so
  in your reply instead."

It sends the agent back at most twice a request by default. **Settings → Agent → Checks** offers up to twice, up to
four times, or never (`checkGate`: `auto`, `on`, `off`).

### Failures from before the request are not the agent's

eNCode keeps a record of every check's runs in the session, the agent's included, with the failures it reads from the
output: TypeScript's errors by file and code, node:test, Jest, Vitest, pytest, cargo and rustc, go, and mypy, by test
or by error. The run before the request's first change is its baseline: one the agent ran first, or the last of an
earlier request. Then:

- every failure was there before: the agent is not sent back, and a notice says "`npm test` fails as it did before this
  request.";
- some are new: the agent is told which are new and which failed before ("not yours unless asked");
- it passed before: "your changes broke it";
- there is no run from before, or the output cannot be read by test: the agent is sent back and told that eNCode
  cannot tell, so it can say a failure was there before.

### The reply's claims are tested

Once a request, the main agent's last reply is read for three claims eNCode can test, in any mode unless checks are set
to never. If one does not hold, the agent is sent back once with what eNCode could not confirm, to correct the reply or
check it:

- the tests, typecheck or build pass, while no command that checks the code passed since its last change;
- a path with a folder and an extension that does not exist and that nothing in the session named;
- a name in backticks that the sentence puts in a file which does not hold it as a whole word.

Each is read conservatively: a hedged, planned or conditional sentence ("should pass", "run the tests to confirm",
"once the build succeeds") claims nothing; a sentence about creating, removing, renaming or moving names no file that
must exist and no name a file must hold; code blocks are the agent's example, not its claim; a file over 2 MB or one
that cannot be read is taken to hold the name. Only a file the agent may read without asking is tested (the person's
rules allow it, or it is in the workspace, a folder added to it or a read root), so a reply learns nothing about any
other.

## Consequences

- A request that changes code now ends with the project's checks run, by the agent or by eNCode, so its answer is
  checked against the tests and the typecheck, not only the open files' errors. It takes as long as the checks when
  the agent did not run them itself, and, under Workspace Write, one approval each until the person allows them.
- The benchmark's reference and replay runs turn the gate off: their scripted models cannot answer a round they did
  not script. A model run keeps it on, as the app does; the model families step measures what it changes.
- `check-gate.test.ts` holds the loop to it: a failing test sent back and fixed, typechecks first, no run for a change
  to prose, a failure from before not sent back, the agent's own passing run not repeated, a refusal, the rounds, a
  check that does not finish, the setting off, each claim, and the session's wiring.
- Open:
  - On a session's first request there is no baseline unless the agent ran the check before its first change; the
    agent is told eNCode cannot tell, which costs a round when the project was already red.
  - A change made by a command (`sed -i`, a code generator) is not seen as a change, so it alone does not start the
    checks.
  - The claim check reads English replies; others pass unread.
  - Failures of a runner eNCode cannot read by test are compared as a whole: any failure counts as new.
