# 0139. The tests are the person's, a declined command does not end the checking, and the bench keeps what it ran

- Status: Accepted, amends 0096 and 0097; builds on 0092, 0135 and 0137
- Date: 2026-10-26

## Context

The first paid run on DeepSeek V4.1 Flash (the `@preset/deepseek-v4-1-1017` preset) ran eNCode's own benchmark. It ran
every task with and without light steps (0135, 0137), 90 runs in all, for $0.43. It passed 39 of 45 runs without light
steps and 41 of 45 with them. Ten runs failed. What they did wrong:

- **Tests it was told to leave alone (7 failures).** On `fix-failing-test` ("fix the code, not the tests"),
  `regression-guard` and `python-fix-bug`, the model changed or added to the project's test files. The Reviewer often set
  this off. Its list of cases no test covers went back to the agent as "Add tests for them to the project's tests"
  (0096), and the model then wrote new tests into the file it was told to leave alone. The tests-first reminder (0097)
  asks for the same on any task list of three steps or more.
- **One declined command ended all checking (2 runs).** The bench declines every command its task does not allow, with a
  note that it "allows only the commands the task names", but it never named them. Twice the model then decided it could
  run nothing ("I'll skip the test run") and finished without checking its work.
- **"Not mine" (1 run).** A test run failed after the model's change, and it called the failure someone else's without
  reading it.
- **The bench itself.**
  - A helper's call started just as a run ended (the conventions offer, aborted when the session closed) reached no
    model. It was still counted as a call of unknown cost, so the run's cost was unknown, and that blocked `--gate`.
  - The bench wrote its reports only at the end. A container restart killed the first run after 54 runs and $0.24, and
    left no report.

Light steps did not pay on Flash. At max effort it already thinks briefly, about 300 reasoning tokens a step, and a light
step thinks as long and writes more. Cost per task solved rose 23% (95% interval ×1.04 to ×1.46), with no change in
passes beyond chance.

## Decision

- **eNCode reads what the person said about the tests (`testsWanted`).** It reads the latest request, and the two before
  it, and gives one of three answers:
  - **Asked:** "with tests", "write unit tests for", "update the tests", "test-first".
  - **Ruled out:** "fix the code, not the tests", "don't touch the tests", "leave the tests as they are", or a failing test
    with the fix aimed elsewhere ("the X test fails. Fix slug so that it passes").
  - **Unsaid:** anything else.
  The latest request decides. When it says nothing about tests, a rule set in one of the two before it still holds.
- **The tests the person ruled out are put back.** When the request ruled tests out and changed test files anyway, the
  agent may not finish yet. It is told which files, and to put each back as it was before the request. This is checked
  once a request, before the project's checks run. It is off when checks are off.
- **The Reviewer's untested cases (amends 0096).**
  - When the person asked for tests, the untested cases still go back as tests to add.
  - Otherwise they go back as cases to check: "read the code, or run it on the case once". The agent adds or changes no
    test, and can name one worth adding in its reply.
  - When the tests are ruled out, the reminder says so.
  - The Reviewer treats a test weakened or removed so that it passes as P1, and so is any change to a test file when the
    request says to leave the tests alone.
  - Every reminder ends with "within what the person asked for and ruled out".
- **Tests first (amends 0097).**
  - A plan the person approves still starts with tests.
  - A task list of three steps or more does so only when the person asked for tests.
  - Neither does when the tests are ruled out.
- **The guide (full and short) says:**
  - A failing test is the spec: fix the code. Add or change tests only when the person asks for tests. When told to leave
    them alone, change no test file at all, and name a test worth adding in the answer instead.
  - A check that fails after your change is yours until its output shows otherwise.
  - A declined command never ends the checking: verify another way.
  - The full guide grows from 6,013 to 6,401 characters, and its budget from 6,100 to 6,450.
- **The bench.**
  - **A declined call is told which commands the task allows**, by name (`node --test ...`, `npm test`), and that a
    declined call is no reason to stop checking.
  - **A call stopped before it began costs $0.** Its signal was aborted before the call, so no model read it. A call
    stopped later keeps an unknown cost, because the provider may have charged for what the model read. The conventions
    offer also no longer starts once the session has stopped it.
  - **Reports are written after every run.** They are marked `partial` until the bench ends, and the end writes them in
    full to the same files. Each file is written whole and then moved into place, so a crash mid-write leaves the last
    report.
  - The bench's task checks are unchanged, so runs before and after this decision can be compared.
- **Terminal-Bench's scored run refuses a count of 0 tasks.** That count used to choose every task the runner can run,
  past the budget. It also refuses more than 4 tasks at once on a 4-processor runner.
- **Light steps stay off by default** (0135), now measured on Flash.

## Consequences

- A request such as "fix the code, not the tests" can no longer end with the tests changed. A case the Reviewer finds is
  still checked.
- A person who wants tests gets them by asking, as before. A person who says nothing no longer gets test files changed
  because the Reviewer or a task list asked for them. Their tests stay theirs, as they would with a careful colleague.
- The rules for reading a request are words, in English. A request in other words, or another language, reads as
  "unsaid". The agent then follows the guide, and the Reviewer still flags a test weakened to pass.
- A run of the bench cut off by a restart keeps every run it finished. Its reports say `partial`.
- The bench and the Terminal-Bench run (0138) are ready to measure this on a paid model when that is wanted.
