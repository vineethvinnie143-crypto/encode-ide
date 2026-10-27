# 0153. BashOutput waits for a command that runs, and the advice stops recommending long loops

- Status: Accepted, amends 0125
- Date: 2026-10-27

## Context

A tester on build 377 (b13) reported that the agent "stalls on sandbox commands". Two diagnostics files and two
screenshots show the cause, and it is not the sandbox.

- **The sandbox was fine.** The commands started at once, the helper was healthy, and nothing was blocked.
- **The agent waited in a loop of its own.** It started a command in the background, then ran a *foreground* PowerShell
  loop, `for ($i = 0; $i -lt 48; …)` and `-lt 50` in the two screenshots, to see whether the command had finished. The
  loop prints nothing until it ends, so the card shows a spinner for minutes. The person pressed Stop ("The command was
  interrupted"), and the background command had already finished. The loop bodies were cut off in the screenshots, so
  the sleep length per round is inferred (a few seconds each).
- **Our own text sent it there.**
  - `BashOutput` returned at once with "(no new output)" for a command that was still running, so the only way to wait
    for the next lines was a loop.
  - The refusal of a blind wait (0125) recommended `for … -lt 24 … Start-Sleep -Seconds 5`, which is two minutes in one
    call, with nothing shown while it runs.

## Decision

- **`BashOutput` waits.** When the command still runs and has printed nothing new (or nothing the filter lets through),
  the call waits for the next output or the end of the command, at most 30 s, and returns what came.
  - A burst of output is returned together: after the first new text the wait lasts another 200 ms.
  - A command that ended, output that is already there and a call that was stopped return at once.
  - While it waits, the call's card says "Waiting up to 30 s for bash_1 to print…", so the wait is shown.
  - After 30 s with nothing the call returns "Status: running" and "(no new output)", and the agent asks again.
- **`JobManager.wait(id, ms, signal)`** is the primitive. Each job keeps the reads waiting on it, told when text comes
  and when the job ends. Disposing the manager and stopping the call end every wait.
- **The tool text says so,** in the description and in the short guide: "Waits up to 30 s for new output or the end:
  wait here, not in a sleep loop." The text is no longer than before (the budgets of `budget.test.ts` hold on both
  systems). The text that follows a background start says the same.
- **The refusal of a blind wait** (0125) now says: for a command, run it with `run_in_background` and read it with
  `BashOutput`, which waits up to 30 s; for anything else, check every few seconds for at most 30 s a call, with a
  six-round loop as the example.

## Consequences

- The agent has a way to wait that ends in at most 30 s, shows that it waits and stops at once on Stop.
- A `BashOutput` read of a quiet command that runs now takes up to 30 s, where it returned at once. A dev server that
  has printed its last line and is read again takes the 30 s. Reading it once after the start gives its output
  straight away.
- A loop the agent writes itself is still run: a wait for a port or a file may take minutes, and the Bash timeout
  (2 minutes by default) is the limit. This change gives the agent a better way and stops recommending the long one. It
  does not refuse loops, because a loop that checks something is a legitimate wait and its length cannot be read from
  the command.
- Subagents get the same wait, through the same tool.

## Verification

- `jobs.test.ts`: `wait` returns at once for unread output, an ended job, an unknown job and a wait already stopped; it
  returns when output comes (with the rest of the burst), when the command ends, when the time is up and when stopped;
  disposing ends it.
- `bash-output.test.ts`: the call waits and shows it, goes on through output a filter drops, returns what a command that
  ended meanwhile printed, gives up after 30 s, and does not wait once stopped.
- `shell.test.ts`: with a real shell, the second read of a command that prints a line a second later returns that line,
  not "(no new output)", well before the 30 s.
- `waits.test.ts`: the advice names `BashOutput`, and its loops are six rounds.
