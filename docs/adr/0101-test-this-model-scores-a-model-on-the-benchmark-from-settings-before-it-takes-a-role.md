# 0101. Test this model scores a model on the benchmark from Settings, before it takes a role

- Status: Accepted, builds on 0052, 0092, 0094 and 0100
- Date: 2026-10-24

## Context

0100 sorts models into strong and smaller ones by a list of names, and says the list should follow what a model does
rather than what it is called. The benchmark of 0092 measures what a model does with eNCode, but from the command line,
with a key in the environment, on every task: a tester choosing between DeepSeek, GLM and a free Qwen for the Explore
role has no way to compare them inside the app, and no idea beforehand what finding out would cost.

What was needed:

- a short run of the benchmark on one model, started from where models are chosen (Settings > Roles), on the key the
  person already set up;
- a score for each skill a role needs, not one number: a model may write code well and review it poorly;
- the cost before it starts, a limit it cannot spend past, and a Stop;
- none of the person's code or files in it;
- the score where a model is chosen: beside it in Roles and in the model lists.

## Decision

### What is run

`@encode/bench`'s `runModelTest` (`quick.ts`) runs eight items in order:

| Skill | For | Items |
| --- | --- | --- |
| Writing | Main, Plan | `fix-failing-test`, `json-config-edit`, `rename-across-files`, `crlf-preserve` |
| Exploring | Explore | `question-no-change`, `trace-event-handler` (new: which function handles an event and where it is hooked up, with a decoy handler in a legacy file and a README that names the wrong one) |
| Reviewing | Review | two changes reviewed by core's `reviewChanges`, as the Reviewer does: `review-finds-injection` passes when a P0 or P1 finding lands on line 10 or 11 of `src/refunds.js` (a query built from text, or a negative amount let through); `review-sound-change` passes with no P0 or P1 |

A task runs as every benchmark task does (0092): a copy of its project in a temporary folder, a home of its own, the
commands the task allows and every other approval declined. The agent settings are the person's gates, so the score is
what eNCode does with the model: the language servers' gate, the guide, the checks, the Reviewer and the help for
smaller models as set. What needs a person or another model is off: the second look, learned conventions, the offer of
a stronger model and computer use. The approval policy is the benchmark's, never the person's.

A task passes when all its checks pass. A check whose program cannot start (not installed, or it failed to launch)
measured nothing, so the run is an error, not a failure, and is not scored; this holds for every benchmark run
(`CheckResult.unrun`). A failed task says which checks it missed ("Not met: the project's tests pass."). A review that
does not answer in the form eNCode reads is a failure; one cut off by an error is not scored.

### One model, no failover

The router's `pinned(ref)` gives a client whose every call goes to that one model, whatever the role: the same call
path as any other (the key sent only to its own origin, free-only mode, the catalogs, the retries on the same model and
the cost), with the model list of one. Nothing fails over to another model or connection, so the score is the model's.

### Cost, limit and stop

Before anything runs, the dialog shows the items by skill, the requests (20 to 92), the tokens read (245k to 1.2M), and
the cost at the catalog's price (`estimateTest`: 3 to 15 calls a task, 40k to 200k tokens read; one call a review).
A free model shows as free; a model with no price says eNCode cannot tell beforehand. The run stops when it has spent
more than twice the highest estimate, and never less than $0.50; and after 300 requests whatever they cost. What it
spent is the provider's own cost where given, else the tokens at the catalog's price, else "not known". Stop ends it
after the current call; a stopped or limited run says so, and its scores count only the items that ran. A run that
scored nothing replaces no earlier result.

It is refused when the connection is not set up, the build has no tasks, only free models are allowed and the model is
billed, or another test runs. One test runs at a time; closing the dialog leaves it running, and opening it again on
the same model shows it.

### Where it runs

In the agent host, beside the agent (`agent-host/model-test.ts`), on the router and sandbox the agent uses. The tasks'
checks run on eNCode's own Node.js (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`, passed only to the checks through
the benchmark's `programEnv`), so Node.js need not be installed. The benchmark's tasks ship with the app as resources
(`bench-tasks`, about 800 KB); the packaged smoke fails without them.

### Results and where they show

The main process keeps each model's latest result in `eNCode-model-tests.json` in the profile (private file, the 100
most recently tested models; read back field by field, anything else left out). Settings > Roles has a gauge button on
each model of a role ("Test this model") and, once tested, a chip with the score on that role's skill ("3/4"); the
model lists show the same chip for the role they are choosing for (Main from the composer). Roles without a skill
(Small tasks, Compaction, Inline suggestions) show no score.

## Consequences

- A tester can compare models on their own key in a few minutes and for a stated cost, and sees the result where they
  choose. The score is a short sample (four, two and two items), said as such; it does not change which models count as
  strong (0100) or route anything by itself.
- The person's code, ENCODE.md, skills, folders and other keys take no part: the tasks are the benchmark's projects in
  temporary folders, reads and writes outside them are declined, and only the tested model is called.
- The desktop now depends on `@encode/bench` (bundled into the agent host).
- `quick.test.ts` holds the plan and its order, the estimate, full marks with the cost computed, no marks with the
  provider's cost and the missed checks named, the limit and the stop. `router.test.ts` holds the pinned client: one
  model whatever the role, and no failover. `bench.test.ts` holds a check that cannot start. `model-tests.test.ts` holds
  the kept results. The desktop's end-to-end run opens the test from Roles, reads the plan, runs it on the fake
  provider (which answers the two questions and makes the JSON change right, so a check runs on eNCode's own Node.js
  and passes), reads the scores, and finds them beside the model in Roles and in the model list.
- Open:
  - The list of strong models (0100) could follow the scores: a smaller model that scores full marks could skip the
    help. Not done until there are enough results to trust it.
  - The estimate is a range from the tasks' sizes, not the model's own habits; the limit, not the estimate, bounds the
    spend.
