# 0137. A benchmark run stops at a spending cap, and runs two setups side by side

- Status: Accepted, builds on 0092, 0129 and 0135
- Date: 2026-10-25

## Context

A benchmark run on a model is paid for with the person's key. The plan's measurements (0129) ask for five runs of
every task, and an A/B of light steps (0135) for two such runs. Nothing in the bench stopped it at a budget: the only
limit was the key's credit limit, which also stops the person's own use of the key.

Two separate runs, one for each side of an A/B, have more problems:

- A budget split between them leaves the second without money if the first costs more than expected.
- They meet the provider at different hours, under different load.
- The tasks run one after another, five times each. A run stopped early has measured the first tasks five times and
  the last ones not at all.

## Decision

- **A spending cap** (`--max-cost <dollars>`, `spendingCap` in `packages/bench/src/spend.ts`). Every model call of
  every run goes through one cap, which adds up what each call cost:
  - what the provider billed (OpenRouter reports it for every call);
  - or, when a call does not say, the model's listed prices over its tokens, with the cache's share;
  - or, when a call does not say and nothing is listed, the bench stops there, since it cannot keep the cap.

  Before each call, the cap adds the dearest call so far to what was spent. When that reaches the limit, the call is
  refused and the bench stops. The run that was going is stopped and counts as an error, so it does not count in the
  pass rate.
- **Rounds.** The runs go in rounds: every task once, then every task again. A round starts only when what is left of
  the cap pays for a round like the last one, so a bench that stops early has measured every task about as often.
  Each report records the cap, what was spent under it, and why it ended early.
- **Two setups side by side** (`--pair light-steps`, `runPair` in `bench.ts`). Each round runs every task both ways,
  one right after the other: with and without light steps. The two setups take turns going first, because the second
  run meets a provider cache the first one may have warmed. The bench writes two reports, `…-light-off.json` and
  `…-light-on.json`, and prints their comparison.
- **It ends once the answer is clear.**
  - After the first two runs with light steps that had a step to make light, if no step was light, the model cannot
    use them (0135), so there is nothing to compare.
  - From the third round on:
    - it ends when the pass rate with light steps fell beyond chance;
    - with `--gate <percent>`, it also ends once the gate passes.
- Each run line shows what the run cost and what the bench has spent of the cap.

## Consequences

- `pnpm bench run --model openrouter:<model> --effort high --pair light-steps --repeat 5 --max-cost 2.90 --gate 10`
  measures light steps within $2.90. The overshoot is at most the calls in flight when the cap is reached: one call,
  or a few when subagents call at once.
- The two setups share the cap, so the comparison stays balanced however early the bench ends.
- Rounds replace task by task for every run, which changes the order in which a report lists its runs. Reports and
  their comparison group runs by task, so they read the same.
- The key's credit limit remains the backstop the bench cannot get around.
