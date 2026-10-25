# 0129. A cost change is measured beyond noise, in a small window, and by the code it leaves

- Status: Accepted, builds on 0092
- Date: 2026-10-25

## Context

The owner set a target of 25% lower cost than other agents at the same accuracy, and chose to build a plan of cost
changes toward it. Each change shortens or drops something the model would otherwise read, so each can cost accuracy,
and the benchmark (0092) could not yet say whether one had:

- One run per task says little. A model does not do a task the same way twice: a task that passes four runs in five
  fails one in five, and with fourteen tasks a single such run moves the pass rate by seven points. A comparison
  called every drop a regression, so noise was a regression and a real drop looked like noise.
- The tasks are small. With the app's own context window none of them comes near a compaction, so the parts a cost
  change touches most (shortening old results, summaries) were never run by the benchmark at all.
- A run passed or failed on its hidden checks alone. A change can pass them and still be one a reviewer sends back:
  a file that no longer parses where no check loads it, ten times the change the task needed, a scratch file, an
  edited test, a debug print, a TODO where the work should be. A cheaper agent that writes worse code is not the goal.

## Decision

- **Statistics, in `packages/bench/src/stats.ts`**, exact and with no outside library or randomness, so a comparison
  says the same thing every time:
  - Fisher's exact test, one-sided, per task: a task counts as passing less often only when the chance of its drop
    under no change is under 5% (five of five to one of five is 0.024; to two of five, 0.083, is not enough).
  - 95% intervals by Student's t over the tasks for the change in pass rate, in pass^k (every run of a task passed)
    and in the share of clean runs, and a geometric-mean interval for the ratio of cost per run.
  - Below three runs of every task on both sides a comparison says so, prints no intervals, and every drop counts, as
    before. `--repeat 5` is the advice in README and TESTING.
- **A report says more.** pass^k beside the pass rate, the tokens and context per run (cache writes, reasoning,
  rewrites and summaries among them), and the cost per task solved. Reports written before this read as they were:
  what they lack counts as zero.
- **The gate.** `pnpm bench compare before.json after.json --gate 25` passes a change only when every task has three
  runs or more on both sides, no task passes less often beyond chance, pass^k and the clean share did not fall beyond
  chance, both reports know every call's cost, the cost per task solved fell by 25% or more, and the cost per run fell
  beyond chance. It prints why not, a reason a line, and exits 1, so a script can hold a change to it.
- **A small window.** `pnpm bench run --window 16000` gives the run a 16k context cap (12k to 1M are accepted), so the
  tasks compact, and the report's name says the window. The meter marks a call whose agent's history is not the last
  call's with more added (the conversation was rewritten and the provider's cache given up from there), and the
  summaries are counted, so a report shows that compaction ran and what it cost. The reference runs answer a summary
  request with a fixed summary, so `--reference` proves the tasks in a small window too.
- **The code a run leaves**, in `packages/bench/src/quality.ts`, read by shape without a model:
  - The lines added and removed over every changed file, the files added, the tests added or changed, the added lines
    that print or stop for debugging, the added lines that leave the work undone, and the files that do not parse
    (`node --check`, Python's `ast.parse`, Lua's `loadfile`, `JSON.parse`; a parse is left unjudged where the program
    is not on the computer).
  - A file that does not parse is always an issue. The rest are judged against the task's reference solution, run once
    a task before the runs: a change larger than three times the reference's and twenty lines past it, a file the
    reference did not add, a test the reference did not touch, more debug lines or stubs than the reference has. What
    the reference does is fine for the run.
  - A run with no issue is clean. The table has a `clean` column, the notes say what a passed run's code got wrong,
    and the comparison and the gate hold the clean share like the pass rate.

## Consequences

- Each cost change in the plan is measured the same way before it is merged: five runs a task with the owner's key,
  before and after, compared with the gate, and once more with `--window 16000` where the change touches compaction.
  Live runs spend money on the owner's key, so they are run when the owner says.
- Five runs a task is five times a run's cost. The tests and `--reference` cost nothing.
- The quality checks are shapes, not judgement: they catch what a reviewer would send back at a glance, not a wrong
  design. A task without a reference solution is judged on parsing alone.
- Fourteen small tasks are still fourteen small tasks. Long tasks that recall what was read early are the plan's next
  measure (Q2).
