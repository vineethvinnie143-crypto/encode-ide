# 0112. The dice rolls while the agent works

- Status: Accepted, builds on 0107; where the dice sits superseded by 0116
- Date: 2026-10-24

## Context

While a request ran, the head of its log said "Working for 0:12" in a shimmer, and nothing else moved. The owner asked
for a thinking animation of eNCode's own: the dice of the logo (0107), small, rolling while the agent thinks, with
"Thinking" beside it.

The logo is a picture (`build/logo-source.png`, rendered to `public/brand/mark-*.png`). Turning a picture of a cube
in two dimensions reads as a spinning badge, not as a die being rolled.

## Decision

- **A die in CSS 3D, drawn from the logo** (`ui/ThinkingDice.tsx`, `styles/48-thinking-dice.css`). Six faces: black,
  in a chrome rim, with white pips; `</>` stands for the one, on top; opposite faces add up to seven. At rest it is
  seen from above and to the side, without perspective, with the three and the five towards the viewer, as in the
  logo. The faces keep the logo's black, chrome and white in both themes, as the mark does. It is our own drawing in
  CSS and an inline SVG path, no image and no library.
- **How it rolls.** Eight quarter turns in 3.2 seconds, about one axis and then the other, each settling on a face for
  a moment before the next; the last lands where the first began, so the loop has no seam. Each turn lifts it by a
  hop timed with it. The size follows the text (1.05em), so it scales with the interface size setting.
- **What it says.** The head of a running log is the die, a word for what the agent is doing, and the clock
  (`workPhase` in `components/Chat/turns.ts`):
  - "Thinking" while the model writes;
  - "Working" while a tool runs, "Reviewing" while Auto review looks at a call;
  - "Waiting for your approval" or "Waiting for your answer" while it waits on the person, with the die at rest.

  A finished turn folds to "Worked for 2m 14s" as before, without the die. The main chat and the side chat both show
  it.
- **Reduced motion.** The app's rule (`theme/tokens.css`) plays one frame of each animation; the roll's last frame is
  the rest, so where motion is reduced the die simply stands still.

## Consequences

- The work in progress carries the brand, and the words say what the wait is for.
- The die is about thirty elements, in the running log's head only, and moves by transforms alone, which the
  compositor runs; finished turns draw nothing extra.

## Verification

- `turns.test.ts`: the words and the rest for each status.
- The end-to-end run's Esc check: while the slow answer streams, the running log's head shows "Thinking", a clock, and
  a six-faced die whose cube runs `think-dice-roll`; `ui-dark-thinking.png` shows it.
