# 0134. Fewer, fuller steps: reads together, wide searches on a cheaper Explore, and filters after an allowed command

- Status: Accepted, builds on 0040, 0061, 0062, 0131 and 0133
- Date: 2026-10-25

## Context

Every step sends the whole conversation again. Cache reads make the repeat cheap but not free, and an output the step
adds is paid on every later step. Three habits add steps that do no work:

- **One read a step.** A model that knows the four files it needs often reads them in four replies. The loop already
  runs the read-only calls of one reply together, so the same reads in one reply cost one step.
- **A wide search on Main.** Finding where something is done can take ten rounds of Grep and Read. Each round is paid
  at Main's price, and its outputs stay in Main's conversation. An Explore subagent (0061) does the same rounds in a
  conversation of its own and hands back what it found. When Explore runs on a cheaper model, the rounds cost a
  fraction.
- **A declined pipe.** An allow rule for `npm test` did not allow `npm test 2>&1 | tail -40`, since every command in a
  line needs a rule (0040). Under Ask, the step waits for the person, and the model often runs the command again
  without the filter, which adds the whole output to the conversation. 0131 left this open: its long task
  `log-middle-line` allows `grep` beside its two commands for that reason.

## Decision

- **A nudge to batch reads** (`packages/core/src/loop.ts`, `BATCH_LOOKS` in `prompt.ts`). After three steps in a row
  that each made one call, and that call was Read, Grep, Glob or CodeMap, the loop adds a note to the step's results: when
  the model already knows more reads or searches, make them in one reply, since they run together and each step
  sends the whole conversation again. It says that edits and the tests after them stay one at a time. A step with two
  calls or more, or any other tool, starts the count again. The note is sent once a request.
- **Wide searches to a cheaper Explore** (`packages/core/src/session.ts`, `exploreLine` in `prompt.ts`). The
  environment reminder names the model Explore runs on and its price next to Main's, and says to hand it a search that
  would take several rounds of Grep and Read. It does so only when Explore runs on another model that costs at most
  half of Main's input price: "at no cost" for a free model, otherwise "at N% of your model's price". When the router
  sends Explore to Main (its fallback), when Explore costs more than half, or when either price is unknown, there is
  no line, so a session with one model sees no change.
- **Filters after an allowed command** (`packages/permissions/src/rules.ts`). An allow rule that matches a command now
  also covers the filters a pipe feeds after it, when each filter reads only what the pipe gives it:
  - Bash: `head` and `tail` (counts, never `-f`), `wc`, `sort` (never `-o`), `uniq`, `cut`, `tr`, `grep` with one
    pattern (`egrep`, `fgrep`), `cat`, `column -t` and `jq` with one program. None of them takes a file: one more word
    than its pattern or sets is refused, since it would read a file no rule named. An option a filter does not list
    is refused.
  - `jq` is refused when its program names `env`, `$ENV`, `$__loc__` and the like, `input_filename`, `import` or
    `include`, which read the environment or files rather than the pipe.
  - PowerShell: `Select-Object`, `Select-String` with a pattern, `Measure-Object`, `Sort-Object` and `Out-String`,
    with their aliases, under the same rule. `-Path` and `-LiteralPath` are not among their options, and a quoted word
    that starts with `-` (a value to PowerShell, not a parameter) makes a command no filter.
  - A filter fed by a redirect, a word known only when the line runs (`$PATTERN`), a redirect to a file, and every
    command not in these lists still need a rule of their own. Deny and ask rules apply to filters as to any command.
- **No Read of several files.** The plan named a Read that takes several files. Several Reads in one reply already run
  together, and a new parameter would add to every request's tool list, which is within 200 characters of its
  ceiling on Windows (0062). The nudge asks for the reply instead.

## Consequences

- A request that reads its way around a codebase takes fewer steps. On Main, three solo reads cost three sends of the
  conversation where one would do. The note costs about 70 tokens, once a request, and only after three solo reads.
- A wide search moves to the cheaper model only when the person chose one for Explore. **Settings → Roles** already
  suggests a small model for it. With a free Explore and a paid Main, the rounds cost nothing.
- `npm test | tail -40` runs under the rule for `npm test`. The model reads 40 lines instead of the digest of 0133 or
  the whole output, without waiting for the person.
- **Accuracy risks.**
  - A model may batch reads it does not need yet. The note asks for the reads it already knows of, and stops at once
    a request.
  - A small Explore model may miss what a search was for. Main gets its findings, not its rounds, and can search again
    itself. The line names the model so Main can weigh it.
  - The filter lists allow less than the filters can do. A filter used in a way they leave out asks, as before.
- The effect on cost is not measured yet: that needs paid live runs on the bench, which wait for the person's go-ahead.
