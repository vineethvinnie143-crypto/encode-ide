# 0149. The agent's debug runs start its probes, and the bench's first Ctrl+C lets the run in progress finish

- Status: Accepted, amends 0145; builds on 0137, 0141 and 0146
- Date: 2026-10-26

## Context

Part 2 of the paid re-run, on 4e8994b with `openrouter:@preset/deepseek-v4-1-1017` at `--effort max`, found two
things that were eNCode's, not the model's:

- **A probe in the scratch folder could not be debugged.**
  - In `debug-csv-record`, run 3, the agent fixed the parser and wrote `probe.js` in its session's scratch folder
    (0141), to try the parser on more input. It started the probe with `Debug`, and the start answered "That file is
    not in the open folder."
  - The agent got there another way, with a breakpoint in `summary.js` and `evaluate`. But the instructions say probes
    go in the scratch folder, and the debugger refused them there.
- **One Ctrl+C said one thing and did another.**
  - The bench printed "Stopping after the run in progress; the report keeps what finished." Then it cancelled that
    run: its checks did not run, and the report kept nothing of it but "The run was stopped."
  - The watchdog that guards a paid run sends that signal. In 2a, run 4 ended that way after one call.

## Decision

- **The agent's debug start may run a file in its session's scratch folder.**
  - The host makes the scratch folder before it asks for the session's scope, and names it in the scope request
    (`scratch`). The folder's debugger gets it with the agent's view (`forAgent(owner, scratch)`).
  - The program must lie in the scratch folder by its real path. A link there that leads out of it is refused ("…
    leads out of your scratch folder."), since the start would run what the person was not shown. A probe not written
    yet is named ("There is no …: write the probe first.").
  - It runs as a file of the folder does: in the folder, with the person's environment, approved by the person, with
    its path on the card. So a probe reaches the project's files from the folder, by a relative or a whole path.
  - The agent's breakpoints may be in the scratch folder too. For Python, Go, C, C++ and Rust its frames count as code
    of its own, not dimmed.
  - Only the agent's starts change:
    - the person's own start still runs only the folder's files;
    - so does a session told of no scratch folder;
    - the Debug tab does not start the agent's probe again: "only the agent can start it again".
  - The Debug tool's `file` says: "A probe in your scratch folder runs too."
- **Ctrl+C once ends the bench after the run in progress** (`finish` in `BenchOptions` and the command line's
  context, `scripts/bench.mjs`).
  - That run goes on to its checks and counts as any run does. No run starts after it, and the report says "Ended
    early: it was asked to stop after the run in progress".
  - Twice stops the run in progress too, as once did before: it is reported as stopped, unchecked. A third leaves at
    once, without a report.
  - The first message says so: "Stopping after the run in progress, which goes on to its checks; Ctrl+C again stops it
    now. The report keeps what finished."

## Consequences

- The agent can debug what it would otherwise only run, without a file in the person's folder. A start still runs
  outside the sandbox, and is still the person's to approve.
- A watchdog that must stop spending at once sends SIGINT twice. One SIGINT now costs the rest of the run in progress,
  which is at most what the spending cap lets it spend.
- Not changed: a probe in the scratch folder is no change to the project (0141), and the person's breakpoints are never
  in it.

## Verification

- `debug-agent.test.ts`, on the real Node.js debugger:
  - a probe in the scratch folder that requires the folder's `price.js` stops at `price.js:3` and at its own line, with
    `total = 7.5` and `got = 7.5`, and ends printing `probe 7.5`;
  - the Debug tab's restart of it is refused;
  - a file outside both folders, a probe not written yet, a breakpoint outside both and, except on Windows, a link that
    leads out are refused with their reasons;
  - a session with no scratch folder, and the person's own start, run only the folder's files.
- `scope.test.ts`: the scope request names the session's scratch folder, made before it.
- `bench.test.ts`:
  - a debugging task whose agent writes a probe in its scratch folder and starts it passes its `used` check. It stops
    at `count.js:4` with `sum = 6`, and the project's only change is `done.txt`;
  - told to finish during its first call, a 2-round bench makes that one run, checks it, and ends early;
  - told after its last run, it ends as usual;
  - told to finish and to stop, the run is stopped and not checked.
- `scripts/bench.mjs`, by hand, on `run --reference --repeat 3`:
  - one SIGINT let `debug-ledger-async #2` finish and pass, and the report said it ended early;
  - two in a row stopped it ("The run was stopped.").
