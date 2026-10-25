# 0138. The command line runs Terminal-Bench through Harbor, held to a spending cap

- Status: Accepted, builds on 0092, 0108 and 0137
- Date: 2026-10-25

## Context

eNCode's own benchmark (0092) tells one change from another on eNCode. It cannot say how eNCode compares with other
agents on the same model: its tasks are eNCode's own, and nobody else runs them. Model makers publish scores on public
benchmarks instead. For a model such as DeepSeek V4.1 Flash, the published Terminal-Bench 4.0 score was measured in
another agent's harness. To compare with it, eNCode has to run the same tasks, scored by the same checks.

Terminal-Bench's tasks run through Harbor. For each task, Harbor:

1. starts the task's container;
2. installs an agent in it;
3. gives the agent the task's instruction;
4. runs the task's tests on what the agent left.

An agent is a Python class that Harbor loads from a module.

Three things were missing:

- **A cap.** The command line had no limit on what a run may spend. A task that loops would spend until its time ran
  out. The bench's cap (0137) lived in the bench package.
- **An effort setting.** The command line took the model's default effort, while the desktop app's roles set one.
- **A command line without a checkout.** It ran only from a checkout (`scripts/encode.mjs`), or as the bundle inside
  the Windows build.

## Decision

- **The command line takes `--effort <low|medium|high|xhigh|max>` and `--max-cost <dollars>`.**
  - `--effort` sets the run's reasoning effort, as the app's setting does.
  - `--max-cost` holds every model call of the request to one spending cap. This includes the calls of the agent's
    helpers.
  - When the next call could pass the cap, it is refused. The request stops with "Stopped: it reached its spending
    cap (…)", and the exit status is 1.
  - The cap is the bench's (0137), moved to `@encode/providers` (`spendingCap`), so the two cannot drift apart.
  - A call that says nothing of its cost, to a model with no listed price, stops the run, as in the bench. A local
    model is one: it costs nothing and says nothing, so `--max-cost` is for paid models.
- **`scripts/cli-bundle.mjs <out.mjs>` writes the command line as one file for Node 22.** It uses the build options
  that the Windows build and `scripts/encode.mjs` use, and it needs nothing installed beside it.
- **A Harbor agent: `packages/bench/terminal-bench/encode_agent.py` (`-a encode_agent:Encode`).**
  - It copies the bundle into the task's container, then runs it in print mode:
    - with full access and no sandbox, because the container is the sandbox and nobody is there to approve;
    - with the model it is given (`-m openrouter/<model>`);
    - with `--ak effort=…`, `--ak max_cost=…` and `--ak max_steps=…`.
  - It uses the image's own Node when that is Node 22 or later. Otherwise it copies in the node binary that runs
    Harbor, so nothing is downloaded into the task, and the task's own tools stay on its PATH. An Alpine image gets
    its own Node package.
  - The model's key is read where Harbor runs, and it is passed to the command line alone. The command line already
    keeps keys from the commands its agent runs and from what it prints.
  - What the run used comes back to Harbor: tokens, cached tokens, cost and model calls, from the command line's JSON
    result. The run's session and its progress come back with the logs.
- **Choosing and reporting.**
  - `choose_tasks.py` leaves out the tasks a GitHub runner cannot run, and says which and why. Those are tasks that
    need a GPU, another system, or more than 4 processors or 15 GB of memory. A task that cannot start would count as
    failed and say nothing about the agent.
  - It then takes a seeded random sample, or the tasks named.
  - `report.py` gives the pass rate, the cost, and the cost per solved task, with one row for each task.
- **CI (`.github/workflows/terminal-bench.yml`), on a Linux runner with Docker.**
  - **On a pull request that touches the command line or the adapter, a check that costs nothing:**
    - the adapter's tests;
    - Terminal-Bench 4.0's list of tasks;
    - a small task in a container, first by Harbor's own solution, which must score 1;
    - then the same task by eNCode on its offline demo model, which must have run and reported what it used.
  - **A scored run, started by hand.**
    - Its inputs are the model, the effort, the number of tasks or their names, the seed, the cap per task, the budget
      and how many tasks run at once.
    - It refuses to start when tasks × cap per task is more than the budget, or when the budget is above $2. Each task
      stops at its cap.
    - The key is the repository secret `OPENROUTER_API_KEY`.
    - Its results are kept for 14 days. Before they are kept, they are searched for the key.
- **Harbor is held to one version.** It is Harbor 0.24.0, with every package it needs at one version and checked by
  hash (`requirements.txt`). No package is newer than 2026-10-11, two weeks before this decision. Harbor 0.25.0 came
  out the day this was written.

## Consequences

- A scored run on the DeepSeek V4.1 Flash preset:
  - inputs: 10 tasks, `max`, $0.10 a task, $1.00 budget;
  - spends at most about $1, plus at most one call over the cap per task.
- Ten tasks give a rough level only. A pass rate of 4 in 10 has a 95% interval from about 17% to 69%. To tell eNCode
  from a published score takes most of the dataset. The tasks this runner cannot run are left out, so a score on the
  rest is not the published score's equal either.
- A sample stays the same for a seed, so a change can be measured on the same tasks again.
- The free check proves that the adapter installs, runs and reports in a real container. It does not prove that a
  model solves anything.
- When Harbor changes the interface for agents, the pinned version keeps the adapter working until it is moved on.
- `scripts/encode.mjs` bundles through `scripts/cli-bundle.mjs`, so the bundle tested here is the one people run.
