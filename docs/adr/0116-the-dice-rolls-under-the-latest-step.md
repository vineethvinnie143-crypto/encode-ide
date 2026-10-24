# 0116. The dice rolls under the latest step

- Status: Accepted, builds on 0112 and 0115
- Date: 2026-10-24

## Context

The dice of 0112 rolled at the head of a running turn's work log, beside "Thinking" or "Working" and the clock. The
head is the first line of the turn, just under your message. In a turn of many steps the log grows below it and the
thread follows the latest step (0115), so the head and its dice scroll out of sight, and the turn looks idle while the
agent works. The owner asked for the animation at every step, as Claude Code keeps its spinner on the last line,
under whatever the agent is doing now.

## Decision

- **A line under the latest step** (`LiveLine` in `components/Chat/WorkLog.tsx`) is the last thing in the turn the
  agent is working on: under the steps, the answer streaming in and the change card. It holds the dice, what the
  agent is doing, the clock of the part it is on, and what the request has used so far. It goes when the turn ends.
- **What it says** (`workPhase` in `turns.ts`): "Thinking" while the model works before it writes; "Writing" while the
  answer after the last step streams in; "Working" while a tool runs; "Reviewing" while Auto review reads a call;
  "Waiting for your approval" and "Waiting for your answer", with the dice at rest, while it waits on you.
- **The head of a running log is a quiet fold toggle.** It says what was done so far ("Read 3 files, ran 2
  commands"), with no dice, clock or shimmer, and is not drawn until the log holds something. When the turn ends it
  says "Worked for 2m 14s" with what the request cost, as before.
- **Side chats** draw the same line under their running turn.

## Consequences

- Wherever the thread is following, the dice is in view under the latest step, and the words say what is happening
  there.
- A step's own row still marks itself running with its small spinner, so among several steps the running one is
  plain.

## Verification

- `turns.test.ts`: "Writing" while the answer streams, and the steps and the waits still win over it.
- Smoke part `follow`: in every sample while the agent works the line is the turn's last element and in view, and it
  says "Writing" while the answer streams; it is gone when the turn ends. Part `stop`: while the slow answer streams the
  line is the turn's last, with the dice rolling (`think-dice-roll`, six faces) beside "Writing" and a clock, and no
  dice in the log's head.
