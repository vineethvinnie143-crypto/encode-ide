# 0092. The agent is measured by a benchmark of its own, and a reported request replays into it

- Status: Accepted, builds on 0062, 0088, 0089, 0090 and 0091
- Date: 2026-10-24

## Context

Accuracy 1a to 1c changed how the agent reads a model's calls, finds code and learns the versions a project has. Each
came with unit tests that prove the code does what it says. None of them says whether a model now finishes more tasks,
with fewer calls and fewer tokens, than it did before. The passes still to come (Efficiency, Accuracy 2, the model
families) make claims of the same kind, and each needs a number before and after.

A public benchmark does not fit. SWE-bench and its like run Linux containers of large Python projects, take hours and
need a model key for every run; they measure the model more than the tool around it, and none has a FiveM resource,
a CRLF file on Windows or a request that should change nothing.

The other half is what testers find. When the agent goes wrong on a tester's project, a screenshot and a sentence are
all that reach Vineeth: which call failed, on which file, with what the model sent, is gone. Report editor issue (0088)
already turns an editor bug into a file that replays and then into a regression test. The agent had no such path.

## Decision

### The benchmark (`packages/bench`)

A task is a folder: `task.json` (the request, the commands the agent may run unasked, the checks), `project/` (copied
fresh for every run), `checks/` (hidden tests the agent never sees) and `solution.json` (the steps of a model that
solves it). `task.json` is read as untrusted, entry by entry, and a task with any problem is set aside with all of them
listed. Checks:

- `command`: a program (`{{node}}`, `{{python}}`, `{{lua}}`) that must exit 0, such as a hidden test run, with a
  timeout that kills it;
- `file`: what a file must hold or not hold, its line ends, that it is valid JSON, or that it is gone;
- `search`: a pattern found or not found under some folders;
- `unchanged`: files left as they were, the whole project when no paths are named;
- `reply`: what the last reply says, for a question that should change nothing;
- `tools`: no more than so many tool calls failed (commands aside).

A run is the desktop app's own agent host on the same Workspaces scope (rules, checkpoints, code index), shells and
tools, in a temporary folder with a home of its own, so the person's ENCODE.md, skills and settings never take part.
No one is there to answer: a command the task allows runs, every other approval is declined with a note, and a question
is told to choose. The web is off. The checks run after the host is gone, with the agent's environment (secrets taken
out) and without `NODE_TEST_CONTEXT`, which would make a `node --test` inside report to the benchmark's own test run and
pass whatever happened.

A metered model client counts each call's tokens (input, cached, output, reasoning), cost when the provider says,
time, and the characters of tool results sent, each counted once. A run records requests, tool calls and failures by
tool, edit misses, failed commands, declined approvals and questions. A report averages them by task, gives the pass
rate of the runs that could be measured (a run the provider refused or rate-limited is an error, not a failure), and
the cost per solved task when every call reported one. `compare` prints two reports side by side and lists the tasks
that passed less often; `--fail-on-regression` makes that an exit code.

Thirteen tasks to start, each one a habit the passes are meant to fix: a failing test to fix, a bug and a new branch
in Python, a rename across files, a JSON config, a CRLF file kept CRLF, an edit near the end of a 2,400-line file, a
command whose output is long, a FiveM server event with validation on the server, an API of the version installed, a
symbol that does not exist, a question that must change nothing, and a change that must not break the tests around it.
The tests prove every task: untouched, its checks fail; played from its solution, they pass with no tool failure, no
declined call and no question.

`pnpm bench run --model openrouter:<id>` (or `@free`, `anthropic:<id>`, `openai:<id>`, `--base-url` for any
OpenAI-compatible server) runs the tasks on a live model through eNCode's own router. Keys come from the environment
only (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ENCODE_BENCH_API_KEY`): they are never printed,
never given to the agent's commands, and taken out of the report before it is written.

### A reported request

**Report a problem with this request** (a flag on each of your messages, and **Help → Report a problem with the last
request…**) saves one request as a file:

1. The agent host makes the record (`packages/core/src/turn-report.ts`), from the session's own messages: the request,
   each step as the model sent it (text, calls, a call that arrived unusable with its raw text), what each tool
   answered (cut to 2,000 characters), the models and the tokens. The files the request read or changed go with it as
   they were before it, from the checkpoint record for a changed file and from the disk for the rest. A file the
   person's rules keep from being read, one that is not text, or one past the limits (40 files, 512 KB each, 4 MB in
   all) is left out and named. The project folder is taken out of every path and text.
2. With **Replace the words** (on by default), every word but keywords, file extensions and program names is replaced
   by another of the same shape, the same way everywhere, so a call still finds its text in the files.
3. The main process redacts every string of it as a log is redacted (the keys the settings hold, the home folder) and
   for anything shaped like a credential, in the files and the calls that edit them alike. A request that read or
   edited a file named like a secret (`.env`, a key file) goes only with its words replaced, as a tool's answer can
   hold that file's lines in any shape.
4. It is checked as the replay will read it and written where the person says, as `encode-turn-report` version 1.
   Nothing is sent anywhere.

`pnpm turn-report report.json` prints what the report holds and plays its steps again on this eNCode, from its files as
they were: each call is made again and its result is set beside the one in the report. Commands are never run: the
report comes from another computer, and the benchmark declines them as it declines any command a task does not allow.
`--save <name>` keeps it as the task `replay-<name>`: the request as its prompt, the files as its project, and
`replay.json` with the steps and what each call does now. The benchmark's tests play every kept replay and fail when
a call does something else, so a fix stays fixed; whoever fixes the bug sets the call's expected result to the fixed
one in the same change. A kept task checks only that no tool call failed until someone writes the checks that say what
the request asked for; then it runs on a live model like any task.

## Consequences

- Each pass from here on is judged by `pnpm bench compare` before and after, on the same model. The reference runs
  already show where the tokens go: the long-output task sends about 76,000 input tokens over 5 calls.
- A tester's bad request reaches the person who can fix it as the steps that went wrong, and stays in the benchmark.
- The numbers that matter need a model key. CI runs the tasks only from their reference solutions, which proves the
  tasks and the harness, not a model.
- A report with its words replaced replays the tools but not the model: its request no longer says what was asked.
- Open:
  - Tasks for TypeScript type errors, a monorepo, a Rust or Go change and a Windows path are next.
  - A replay does not record the person's approvals, so a call declined in a replay is shown, not compared.
  - The benchmark runs one task at a time; a long run on a slow model takes a while.
