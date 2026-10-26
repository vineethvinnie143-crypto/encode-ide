# 0150. An answer that leaves a result of the change as it is goes back to the agent once

- Status: Accepted, builds on 0095, 0126, 0147 and 0148
- Date: 2026-10-26

## Context

Part 3 of the paid re-run, on 13c211a with `openrouter:@preset/deepseek-v4-1-1017` at `--effort max`, ran
regression-guard 5 times with 0148's rule in the prompt. It passed 3. Both failures found the case and left it to the
person:

- Run 4 answered: "`Hello - World` still gives `hello---world`, because the existing `\s+` rule doesn't collapse
  dashes. Outside the failing test — say the word if you want it tightened."
- Run 5's first answer, at step 13 of 15: "`--already--dashed--` becomes `already--dashed` (inner doubles are kept,
  only the ends are trimmed) … Tell me if you'd rather collapse inner dashes or restrict to ASCII, and I'll adjust."
  The Reviewer's point took its two steps left, and its last answer called the dashes "a deliberate choice".

Two rules in the prompt (0147, 0148) did not change this. The model reads the rule, then files the case under the
request's scope. A third rule would be more of the same. The answers that leave it have one shape, though: a result of
the code in code spans, `` `a - b` → `a---b` `` or "`x` still gives `y`", next to words that leave it: "unchanged by
me", "a known quirk", "deliberate", "say the word", "tell me if you'd rather". eNCode can read that shape, as it reads an
answer that leaves a check to the person (0126).

Run 2 passed while its `slug` deleted every hyphen: `Well-Known Title` came out `wellknown-title`. The hidden check
had no hyphen inside a word.

## Decision

- **`leftAsIs` reads the answer by paragraph and by list item** (`packages/core/src/claims.ts`).
  - A block counts when it shows a result of the code and has words that leave it.
    - A result: two code spans joined by →, `->`, `=>`, "gives", "yields", "becomes", "returns", "produces", "comes
      out as" or "turns into", with "still" allowed before.
    - Words that leave it: "left / kept … as is / alone / unchanged / as it was", "unchanged by me", "unchanged and not
      asked for", "known quirk", "deliberate", "say / give the word", "tell me / let me know if you'd rather / like /
      want / prefer", "if you'd rather / prefer", "worth knowing".
  - A list item counts under a heading line that has the words ("**Left as is:**").
  - Code blocks are not read.
- **The loop sends the answer back once a request, with that block quoted.** As with the hand-back check (0126), this
  happens only:
  - for the main agent;
  - in Code mode;
  - when the request ran tools and changed a file;
  - unless checks are off;
  - when a step is left.
  - It comes after the hand-back check and before the Reviewer. The person sees "The answer left a result of the change
    to you, so the agent settles it itself first."
- **The reminder**:
  - "Your answer leaves a result of the code as it is: "…""
  - "Before you finish, settle it yourself: run the code on that input if you have not. If code you changed in this
    request gives a wrong or odd result there on input like the request's (a separator doubled, a case half handled),
    it is part of the problem even when the old code gave it too: fix it, check it, and say so."
  - "If the result is right, or the request rules it out, keep it and say why in one line. Do not leave the choice to
    the user."
- At the request's last step the answer stands, as an answer that leaves a check does (0147).
- **regression-guard's hidden check adds `slug('Well-Known Title')` → `well-known-title`.** The reference solution
  passes it.
- The system prompt does not change.

## Consequences

- A model that sees the odd result and leaves it now gets one step to settle it. A model that never tries the input is
  not helped: that is what the hidden check measures.
- Replayed on 131 answers from the paid bench runs:
  - It catches 5 of the 11 failed regression-guard answers, each one that showed the result and left it. The other 6
    never showed it. It also catches run 5's first answer.
  - It flags 6 of the 105 passing answers. Each is a choice the agent then keeps in one line, at the cost of a step and
    its tokens.
- The check reads words, as the claim and hand-back checks do: an answer that leaves the result in other words passes.
- **Still open.** Five paid runs of regression-guard after the merge measure it.

## Verification

- `claims.test.ts`:
  - **Counted:** the failed runs' answers, and a list item under a "Left as is:" heading.
  - **Not counted:**
    - a result fixed or checked;
    - an offer with no result;
    - a list under another heading, or a heading a paragraph ended;
    - a code block.
  - The reminder quotes the block on one line, clipped.
- `check-gate.test.ts`:
  - The answer goes back once, and the person sees the notice. The second answer goes through.
  - Nothing goes back when nothing changed, in Ask mode, or with checks off.
- The bench's reference run of regression-guard passes, with the new hidden case. No reference solution's text counts.
- The desktop smoke's fake model reads the new reminder as eNCode's own (`apps/desktop/scripts/fake-provider.mjs`).
