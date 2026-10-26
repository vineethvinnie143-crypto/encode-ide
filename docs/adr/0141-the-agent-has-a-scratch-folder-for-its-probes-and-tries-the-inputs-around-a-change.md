# 0141. The agent has a scratch folder for its probes, and tries the inputs around a change

- Status: Accepted, amends 0126; builds on 0063, 0093, 0095, 0100 and 0139
- Date: 2026-10-26

## Context

The same benchmark as the night before, run again on DeepSeek V4.1 Flash after 0140, showed three things that were not
the model's alone:

- **A probe had nowhere to go.** In `regression-guard` the agent wanted to try its fix on a few more titles. A scratch
  test outside the project was refused (it is outside the workspace, and the bench declines every approval), and one
  inside the project would have changed the tests the person said to leave alone. It said the edge cases were
  unverified and finished. The hidden test failed on `a  -  b`, which came out `a---b`: the same miss in every run of
  the task, both nights.
- **A probe went in the project and stayed.** In `recall-early-rule` the agent wrote `test/zz-verify.test.js` to check
  its work and left it there: a file the task did not need, and a changed test.
- **The bench counted what Python makes on its own.** `__pycache__/*.pyc` after a test run counted as files the agent
  added, and the regression task's own `npm test` (`node --test test/`) does not run on Node 22, which sent the agent
  after a problem that was not the task's.

## Decision

- **A scratch folder for each session.**
  - Made when a session that has a folder opens: `<sessions>/scratch/<session id>` by default, and in the desktop app
    and the command line inside the sandbox's own temp folder (`<sandbox>/tmp/scratch/<session id>`), which commands in
    the sandbox may read and write on every system. Only its owner may open it (0700).
  - The environment reminder names it, with what goes in it: "Put probes, throwaway scripts and scratch tests here, never
    in the project, and reach the project's files from here by their full path." A chat that was told of none (one from
    before), or of another chat's (a copy, a side chat), is told of its own once.
  - The agent's file tools read and write in it without asking, as in the workspace; the person's rules still deny
    what they deny, and Read Only still changes nothing. It is not off limits inside eNCode's own folder: the session's
    own folder is excepted, as its kept results are (0093). A command may name it as it is: a word that names it and
    holds `..` is still judged by where it leads, and what the command's paths resolve to is judged first.
  - Nothing written there is a change to the project: no check runs for it (0095, 0140), no language server is told,
    its earlier version is not kept to be put back, it is not on the list of the request's changes, and a first write
    there needs no "say what you will change" first (0100). The scan for hidden characters still reads it.
  - It goes with its session, and once nothing in it changed for a week (looked for when eNCode starts).
- **The inputs around a change are tried (amends 0126).** The instructions now say to try the inputs around the case
  that changed (repeated, at either end, beside what the tests cover), and that probes and scratch tests go in the
  scratch folder, never in the project. The instructions grow by about 160 characters. The short ones, for models
  that try the inputs around a change unasked (0094), only say where probes go, and grow by about 70.
- **The bench counts what the run made.** A snapshot of the project leaves out `__pycache__` and `.pytest_cache` as it
  leaves out `.git`. The regression task's test script is `node --test`. The report's line on tasks that passed every
  run says so in those words.

## Consequences

- The agent can check its work on a smaller model's terms, without the person's folder and without asking, and what it
  leaves behind is in a folder that is removed for it.
- A probe the agent runs is still a command, approved as any command is. The folder is per session, but a command of
  one session in the sandbox can write in another session's folder: they share the sandbox's temp folder.
- The `a  -  b` miss is a judgement the model makes. Trying the inputs around a change, from a place where trying is
  allowed, is what can catch it; how often it does is not measured yet.
