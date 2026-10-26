# 0142. A model family gets notes of its own, each measured, and the bench keeps the calls that did nothing

- Status: Accepted, builds on 0094, 0096, 0100, 0137 and 0139
- Date: 2026-10-26

## Context

The re-run of 2026-10-26 on DeepSeek V4.1 Flash (52 of 54 passed) showed two things that its prompts and its
reports could do better:

- **The Reviewer thought too long.** In 11 of 45 completion reviews, Flash ran out the Reviewer's 4 minutes on a change of
  about 1,200 tokens. The reviews that finished took a median of 41 s, and the slow ones 10,000 to 12,000 tokens of
  reasoning. That was 44 of the run's 139 minutes, and in the app a 4-minute wait at the end of a request. Asking for
  less effort barely shortens Flash's thinking, so a setting cannot fix it. A line of instructions might.
- **The bench counted wasted calls but did not name them.** 138 calls were declined and 21 commands failed in 54 runs.
  The reports kept the tool and whether it worked, not what it was asked, so nobody could tell which commands to
  prevent.

Every model shares eNCode's prompts. Only two kinds of model get different ones: strong models get the short guide
(0094), and smaller models get their help (0100). Nothing in the prompts was for one family alone. A preset's own
system prompt is not the place for that, because it stacks on top of eNCode's and nothing measures it.

## Decision

- **Notes per family** (`packages/core/src/model-notes.ts`).
  - A note is fixed text, placed after a role's instructions as a part of its own and kept in the prompt cache.
  - A family gets a note only for a failure the benchmark measured.
  - A note stays only while a comparison of runs with and without it shows that it helps.
  - The family is the one the client knows for the model the router expects for the role. For a preset, that is the
    model that served it. The router's budget now gives `family`.
  - A model id that names the family counts too, as `@preset/deepseek-...` does.
- **DeepSeek's Reviewer is told to keep its reasoning short.**
  - The note: "Read each change once against the request and decide: a problem, or not." It asks for a few hundred
    words of reasoning, not thousands, and then the answer.
  - It goes to the two Reviewers that read changes: the review before the agent finishes (0096) and the code review.
  - The plan critique, the second look at a command and the approval Reviewer were not measured as slow, so they get
    no note.
- **The agent gets no note yet.**
  - Its declined and failed calls are recorded from this change on (below). A note waits for what they show.
  - Most declined calls are commands outside a task's allow list. In the app a person would be asked about them, so a
    note against them would fit the bench, not the person.
- **A setting to turn them off.**
  - `modelNotes: 'auto' | 'off'` in the agent's settings, `auto` by default.
  - The bench compares the two with `pnpm bench run --pair model-notes`: `notes-off` first, then `notes-on`, one run at a
    time, under `--max-cost`. It goes with `--light-steps` and `--effort` like a plain run.
  - The report of the first run says `without model notes`.
- **The bench keeps the calls that did nothing.**
  - For each failed or declined call, a run's `tools` now hold what the call was asked (the command, or the input as
    JSON) and the start of what it said back. Each is cut at 300 characters.
  - The report lists the declined calls and the failed commands, the most frequent first. Numbers are made alike so
    that the same command in another run counts as the same.
  - A call that eNCode made itself, such as a check run when a step is done (0140), is marked `eNCode`.
- **The report and the comparison say how the Reviewer went.** For example, "Reviewer: 45 calls, 11 failed, a median
  of 41 s and 1,197 reasoning tokens for those that answered" for the re-run, for each side of a pair. This is what the DeepSeek note
  is measured by, with the pass rate and the cost per task solved.

## Consequences

- A DeepSeek Reviewer's request is about 80 tokens longer, and they are cached after the first review.
- If the note shortens the reviews, the slow wait at the end of a request goes away for DeepSeek users at no cost. If
  it costs accuracy, the comparison shows that, and the note goes.
- Still open:
  - the comparison itself, 18 tasks 3 times each way, about $0.40, which runs when Vineeth says;
  - notes for the agent, from what the recorded commands show;
  - notes for other families, each from a failure the bench measured on that family.
