# 0152. A result shown after a comma counts for the left-as-is check

- Status: Accepted, amends 0150
- Date: 2026-10-26

## Context

Part 5 of the paid re-run ran regression-guard 5 times on e0d4df9 (0151), with `openrouter:@preset/deepseek-v4-1-1017`
at `--effort max`. It passed 4, the same as part 4.

- **The left-as-is check of 0150 fired in four runs and missed the fifth.**
  - In runs 3 and 5 it found a real bug. Both put the fix and its check in one batch, as 0151 asks, and the tests passed
    before the step limit. Run 3's code gave `a---b` until its answer went back.
  - Run 4's answer at step 12 said: "One thing left as-is, outside this fix: … e.g. `Hello - World`, still yields
    `hello---world`, since the code only collapses whitespace runs".
  - `SHOWN_RESULT` allows only spaces between the input's code span and the verb. The comma after `` `Hello - World` ``
    let the answer through.
- **The Reviewer came next and raised `docs/A - B!`.** The agent ran it and saw `docs/a---b`, but at step 15 of 15. Its
  closing answer called the fix "beyond what the test asks for", and the hidden check failed on `a  -  b`.

Had the check sent run 4's answer back at step 12, three steps were left for a fix and its check in one batch.

## Decision

- **A shown result may have a comma, semicolon or colon after the input's code span** (`SHOWN_RESULT`, in
  `packages/core/src/claims.ts`), then "which" or "it":
  - "`` `Hello - World` ``, still yields `` `hello---world` ``"
  - "`` `a  b` ``, which gives `` `a--b` ``"
  - "`` `a - b` ``; it still returns `` `a---b` ``"
- As in 0150, the block must also have the words that leave the result. The rest of the check is unchanged.

## Consequences

- Replayed with the change:
  - On the 141 final answers of the paid bench runs (with part 5's five), it flags the same answers as before: 6
    failed ones and 8 of 113 passing ones.
  - On the 63 longer agent messages in the transcripts of parts 4 and 5, it now catches run 4's answer. It flags no
    more passing ones: still 7 of 50.
- "Now gives" is still a fix, not a result left: "`` `slug('a - b')` ``, which now gives `` `a-b` ``" does not count.

## Verification

- `claims.test.ts`:
  - **Counted:** run 4's answer, and a result after "which" and after "; it".
  - **Not counted:** a result after ", which now gives".
