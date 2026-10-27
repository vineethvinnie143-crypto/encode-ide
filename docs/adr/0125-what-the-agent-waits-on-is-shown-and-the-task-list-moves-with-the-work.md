# 0125. What the agent waits on is shown, and the task list moves with the work

- Status: Accepted, builds on 0116 and 0124
- Date: 2026-10-25

## Context

The owner, on tester build 8: "the agent goes stale randomly while working", and "after finishing task still card ain't
updating", with a screenshot. The diagnostics and the screenshot showed three things.

- **A long think looked like a stall.** Both requests he stopped were inside one model call, with no timeout and no
  retry. His main effort was max, and DeepSeek through OpenRouter streams its reasoning for minutes before it writes.
  The stream kept the watchdog happy, but eNCode showed only "Thinking", the dice and the clock.
- **A blind wait looked like a stall.** The screenshot showed `Start-Sleep -Seconds 110; "waited"` running, with a
  spinner and nothing else. A fixed sleep holds the request whether what it waits for is ready after five seconds or
  never.
- **The Tasks card stayed at 0 of 4.** The model wrote the list once and never sent it again, though it finished the
  first item many steps before. Once a request ended, the item it left in progress kept turning.

On the way, one more fault turned up: since 0124, any message the loop took between steps gave the request its whole
step limit again, background news included. A monitor with a line after every step kept a request going without end.

## Decision

- **The model's thinking shows under the live line while it thinks.**
  - The loop passes the reasoning a provider streams to the surface: at once, then at most every 400 ms, and `null`
    when the call ends (`ThinkingTicker`, `core/thinking.ts`).
  - What goes is the latest words, about 160 characters on one line, from a word's start, without the markup of the
    model's notes, and whether they are the end of a longer thought (`cut`).
  - The session sends it as a `thinking` event. It is never stored, logged or put in a diagnostics report. A subagent's
    thinking is not shown, since its surface has no live line.
  - The app shows it in one quiet italic line under "Thinking" (`.turn-thought`), starting with an ellipsis when it is
    cut. It goes when the model starts writing, when a tool runs, or when the request ends. Side chats show it too.
- **A step that has run for five seconds says for how long.** The clock sits at the end of its row, beside the
  spinner. A step that waited for your approval counts from when it started to run.
- **A blind wait of more than 10 seconds is not run.**
  - The Bash tool reads the command in its shell: `sleep` in bash (with GNU suffixes and `infinity`), and `Start-Sleep`
    or `sleep` (by any prefix of `-Seconds`, `-Milliseconds` or `-Duration`, or given first) and `timeout /t` in
    PowerShell.
  - Only a wait on its own counts. A wait inside a loop or a condition is part of a check, and a command the parsers
    cannot read is run as it is. In bash, a wait run in the background (`&`) counts for nothing.
  - PowerShell lines are split into statements at `;` and line ends outside quotes, brackets and braces first, so a
    statement PowerShell reads as an expression (`"waited"`) does not hide the wait before it.
  - The model is told why the command did not run, and to check for the thing itself every few seconds, with a limit,
    in one command, with an example in its own shell. For work that takes minutes, it should use `run_in_background`.
    A wait started with `run_in_background` runs. (0153: the example loop is six rounds, and a command is waited for
    with `BashOutput`, which waits up to 30 s.)
- **The task list moves with the work.**
  - The loop reads the list the person sees (the main agent's only). After six steps in a row that left a list with
    open items as it was, the list goes to the model with the step's results: "The task list the person sees has not
    changed for several steps", with each item and its state. It asks for the whole list again if any of it is done or
    the plan changed.
  - When the agent would end a request while the list it wrote in this request still has open items, it is sent back
    once to send the list again: done items completed, items that no longer apply removed, and what is really left
    named in its answer. This works with attempt_completion too. Like 0124's send-backs, the note ends by asking for the
    whole answer again. A list left by an earlier request is only reminded of, not sent back for.
  - Once a request ends, the item it left in progress no longer turns on the card: it shows a still dot, and its title
    says it was left open when the request ended.
- **Only a message of the person's gives a request its whole step limit again.** Background news still goes with the
  step's results, but it does not renew the limit.

## Consequences

- A long think, a slow command and a refused wait each say what they are, so a request that takes time no longer looks
  stuck.
- A request whose list was left open costs one model call more at its end. A long request with an open list gets a
  reminder every six steps without an update.
- A model that wanted a fixed wait has to write a check instead. A wait of 10 seconds or less still runs, so a short
  pause between two commands is not refused.
- The thinking shown is the provider's reasoning text. A model that reasons without streaming its reasoning shows none,
  and the clock and the dice are still all there is to see for it.
- Tests:
  - `thinking.test.ts`: the latest words, the pace of the updates, `cut`, and a call that did not think.
  - `loop.test.ts`: the thinking passed to the surface and cleared, not kept; the six-step reminder; the send-back
    before the end, once; no list, no reminder; background news does not renew the limit.
  - `waits.test.ts` and `shell.test.ts`: waits found and waits left alone in both shells, and the Bash tool refusing a
    blind wait at once while it runs a short one and one in the background.
  - The smoke's `waits` part: the thinking under the live line, a clock on a command that has run five seconds after
    its approval, a blind wait of 110 s refused, and the list brought up to date before the request ends.
