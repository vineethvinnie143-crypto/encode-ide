# 0151. A change that drops characters is tried on a word with each, and a fix late in a request goes with its check

- Status: Accepted, amends 0141, 0147 and 0150
- Date: 2026-10-26

## Context

Part 4 of the paid re-run ran regression-guard 5 times on cf3ba7d (0150), with `openrouter:@preset/deepseek-v4-1-1017`
at `--effort max`. It passed 4. No run left `a---b` as it was.

- **The failure was a character the change dropped.**
  - Run 5's `slug` kept only letters, digits, spaces and `/`, so `Well-Known Title` came out `wellknown-title`.
  - The old code kept every character. None of the run's probes had a hyphen, and none of the Reviewer's five cases did.
  - The rule of 0141 and 0147 asks for the inputs around a change: repeated, at either end, mixed with what the code
    already handles, beside what the tests cover. A word with a character the change now drops is none of these.
- **The fixes 0150 asked for went unchecked.** Its check fired in runs 3 and 4, and both fixed the case, but late:
  - Run 3 answered at step 14 of 15 and fixed the code in step 15. Its closing answer said the fix was not run.
  - Run 4 answered at step 12. It used a step each for the fix, for the probe's new case and for one command that
    ran both, and that command was declined. Its closing answer said the new line never ran.
  - The loop runs calls that only read together, and every other call in the order given (`packages/core/src/loop.ts`).
    So an edit and the command that checks it fit in one step, but the model took a step for each.
- **0150 missed one answer.** Run 5 ended with "`'a//b'` or a leading/trailing slash passes through as-is … say the
  word if you want empty segments collapsed too". It leaves a result, but no result shows after the code span.

## Decision

- **The inputs to try include a word with each character the change drops** (`SYSTEM_PROMPT`).
  - The list reads "(repeated, at either end, mixed with what the code already handles, beside what the tests cover, a
    word with each kind of character it now drops)".
  - The prompt is 49 characters longer, at 6,829, and its budget goes from 6,800 to 6,850.
  - The short guide of 0094 does not change, as in 0147.
- **The Reviewer asks for the same** (`COMPLETION_SYSTEM`). Its examples of cases no test covers end with "a word with
  each kind of character the change now strips".
- **A fix near the end of a request goes with its check.**
  - The steps-left note of 0147 ends: "An edit and the command that checks it can go in one batch, since they run in
    order."
  - 0150's reminder adds: "Put the edit and the command that checks it in one batch: they run in order."
- **A value shown passing through is a shown result** (`leftAsIs`): a code span followed by "passes through" or
  "comes through", within the sentence. As in 0150, the block must also have the words that leave it.

## Consequences

- Every request carries 49 more characters of instructions.
- An answer with a fix made at the last steps can now report a check of it, where the step limit allows one batch.
- Replayed on the 136 answers of the paid bench runs, with part 4's five:
  - `leftAsIs` catches 6 failed answers, one more than before (run 5's).
  - It flags no more passing answers: still 6 of 109.
  - Matching any code span next to the words would flag 28 more passing answers, so the pattern names "passes
    through".
- **Still open.** Five paid runs of regression-guard after the merge measure it.

## Verification

- `prompt.test.ts`:
  - the inputs rule, word for word;
  - the steps-left note, word for word;
  - the budget, and the same ceiling in `budget.test.ts`.
- `review-gate.test.ts`: the Reviewer's untested cases name a word with each kind of character the change now strips.
- `claims.test.ts`:
  - run 5's answer counts;
  - "I left `README.md` unchanged" and "`npm test` goes through cleanly, and I left the tests alone" do not count;
  - the reminder asks for the edit and its check in one batch.
