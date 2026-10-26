# 0147. The agent fixes what its own checks find, and a check at the last step is told

- Status: Accepted, builds on 0096, 0124 and 0141
- Date: 2026-10-26

## Context

The paid re-run of 2026-10-26 ran the bench's `regression-guard` task 3 times, on e90b2ce. The task says: make slug's
"drops punctuation" test pass. Its hidden test also checks `slug('a  -  b')` and expects `a-b`. Two runs failed on that
case alone, with `a---b`.

- **Run 1** tried the inputs around its change, as 0141 asks. These were the cases the Reviewer named: accents,
  underscores, `!!!`, punctuation at the end and an empty title. None of them put the new handling next to what the code
  already did. The code turned every run of spaces into one dash, and a dash between spaces makes three.
- **Run 2's probe found the case.** Its answer said: "a literal dash surrounded by spaces gives `a - b` → `a---b` … Say
  the word if you want runs of dashes collapsed to one." The prompt told it: "Mention an unrelated bug you notice; do not
  fix it". It treated a wrong result from the function it had just changed, on the kind of title the request was
  about, as unrelated.
- **Run 2 also used all 15 of its steps.** Its answer took the last step. The Reviewer then read the changes and sent
  the agent back, so the request ended at the top of the loop, with no step left. What the Reviewer found was dropped:
  the model never read it and the person never saw it. The notice still said the agent "goes on to fix it".
- Run 3 passed, after the Reviewer's finding led it to fold runs of spaces and dashes into one dash.

## Decision

- **A wrong result the agent's own checks find is part of the problem** (`SYSTEM_PROMPT`, `packages/core/src/prompt.ts`).
  - The rule is: "A wrong result your own checks show from the code you changed, on input like the request's, is part of
    the problem even if it was there before: fix it and say so; do not offer to."
  - The rule after it stays: "Mention an unrelated bug you notice; do not fix it." A bug elsewhere, or on other input,
    is still only mentioned.
  - The short guide of 0094 has neither rule. The strong models it is for keep to the scope of a request unasked, so it
    is left as it is.
- **The inputs to try include the old handling.** "(repeated, at either end, beside what the tests cover)" becomes
  "(repeated, at either end, mixed with what the code already handles, beside what the tests cover)".
- **The model hears how many steps are left, once** (`packages/core/src/loop.ts`).
  - In a request that may take 10 steps or more, the reminder goes with the step that leaves 4. It also goes with a
    check that sends the model back then.
  - It says: "Steps left in this request: 4 of 15, and tools go off after the last. Bring the work to its end in them
    and give your answer with two to spare, so what the checks of your answer find can still be fixed."
  - A message from the person gives the request its whole limit again, as in 0124, so it can come again after one.
  - A shorter limit is already plain to see, and 4 of 9 would be half the request.
- **What a check finds at the last step is told, not dropped.**
  - An answer that takes the last step is still checked: by the language servers, the tests the person said to leave
    alone, the project's checks, the scan, the claims and the Reviewer.
  - When one of them finds something, the model reads it with "Your answer took the last step this request may take
    (15 steps), so tools are off for your next reply and what this check found cannot be acted on now. Give the user
    your whole answer again…". That reply is made with tools held back, as in 0124, and it is the request's answer.
  - The same holds for an answer given with `attempt_completion` at the last step.
  - The notice says what was found, then "The answer took the request's last step, so the agent says what is left
    instead." It no longer says the agent goes on.
  - Two things that only ask for more steps are skipped there: the hand-back check of 0126, since the person can make
    that check, and the reminder of open tasks.
  - The request still ends as `max-steps`, so the person reads "Stopped after 15 steps" and can send a message to let
    it go on.

## Consequences

- With a 15-step limit, an answer at step 13 leaves two steps for what the Reviewer finds. The app's default limit is
  200 and Vineeth's is 50, so the reminder mostly matters on the bench's tasks and on low limits.
- The prompt grows by 222 characters, to 6,782. Its budget in `prompt.test.ts` and its ceiling in `budget.test.ts` go
  from 6,600 to 6,800.
- A Reviewer call at the last step still costs a call. Its findings now reach the person.
- **Still open.** Whether the rule moves the model is for the paid bench: `regression-guard` ×5 runs after this is
  merged.

## Verification

- `prompt.test.ts`: the rule, the inputs to try, and the two notes, word for word.
- `loop.test.ts`: in a 10-step request the note comes once, with the sixth step's results; a 9-step request gets none.
- `review-gate.test.ts`:
  - an answer at the last step gets the Reviewer's findings with the last-step note, in a reply with tools off. The
    request ends as `max-steps` with that reply, and the notice says the answer took the last step;
  - the same with `attempt_completion`;
  - a Reviewer that sends the agent back with 4 steps left adds the note to its reminder.
