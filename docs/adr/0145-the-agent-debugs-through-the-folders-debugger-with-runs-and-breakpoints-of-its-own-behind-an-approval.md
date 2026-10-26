# 0145. The agent debugs through the folder's debugger, with runs and breakpoints of its own, behind an approval

- Status: Accepted, builds on 0004, 0136, 0143 and 0144
- Date: 2026-10-26

## Context

0143 and 0144 gave the person a debugger for Node.js, TypeScript, Python, Go, C, C++ and Rust: the gutter, F5 and the
Debug tab, all on one `FolderDebugger` in the agent host. The agent could not use it. To find why a value is wrong it
added prints, ran the program, read the output and took the prints out again: several turns, edits to the person's
files, and only the values it guessed to print.

A debugger answers that in one stop: where the program is, how it got there, and every value in the frame. The plan
named this third part: the agent drives the same debugger, behind approvals.

The constraints:

- A debug run is not a sandboxed command. The program runs with the person's environment, as from their terminal
  (0143, DB-R: the run is outside the agent's sandbox). The agent must not start one without the person's yes.
- The person's breakpoints and runs are theirs. The agent must not move their breakpoints, step their paused program
  or jump their editor to a stop of its own.
- A stop must come back as text the model reads at once: the place, the code around it, the stack and the values,
  within a size that does not flood the context.
- No outside library: the tool sits on the engine eNCode already has.

## Decision

### The tool (`packages/tools/src/debug.ts`)

`Debug` is one tool with an `action`:

| Action | What it does |
| --- | --- |
| `start` | Starts `file` (the editor's-file configuration) or a configuration of `.encode/debug.json` by name, with the agent's own `breakpoints` (file, line, and optionally `condition`, `hitCondition`, `logMessage`) and `stopOn` (`uncaught`, the default; `all`; `none`), then waits for the first stop or the end |
| `continue`, `step` (`over`, `into`, `out`), `pause` | Moves the run and waits for the next stop or the end |
| `evaluate` | An expression in the paused frame (`frame` picks another), in the debugger's console context |
| `variables` | A name in the frame, its fields by path (`order.items[0].price`, `map["key"]`) |
| `breakpoints` | Replaces the run's breakpoints |
| `state` | The runs it can see, the person's and its own, and where each is |
| `stop` | Ends the run |

Each wait is 30 s unless `wait` says otherwise, at most 120 s; a run still going after it says so, and `state` or
`pause` follow. A stop is reported as one block:

```
Run r1 (node cart.js) paused at cart.js:7 in lineTotal: breakpoint.
    5  function lineTotal(item) {
    6    const total = item.price * item.qty
  → 7    return Math.round(total * 100) / 100
    8  }
    9  let sum = 0
Stack:
  → #0 lineTotal  cart.js:7
    #1 (anonymous)  cart.js:11
    … 9 frames of the runtime
Values (Local, frame #0):
  this = global
  item = {name: "Coffee beans", price: 14.5, qty: 2} (Object)
  total = 29
Printed since the last report:
  Checking out 2 items
```

Bounded: two lines of context each side, 12 frames (the runtime's folded to a count), 30 values of 240 characters,
100 children, 60 printed lines or 4,000 characters, an exception's message without its stack (600 characters).
Breakpoints that did not bind are named with the debugger's reason. A session has at most 3 runs of its own; each
takes at most 50 breakpoints, inside the folder or the session's scratch folder (0149), on a line the file has.

The tool is deferred (loaded through `ToolSearch`), offered only where the folder has a debugger (the desktop app, and
the bench's debugging tasks of 0146), listed from the start once a request asks for the debugger (0148),
and only to the main agent: it is on the subagents' excluded list, as a run is a long-lived, approved program.

### Approval (`packages/core/src/approval.ts`)

A new access, `{ type: 'debug', action: 'start' | 'drive', what, key }`:

- **start** asks every time under Workspace Write and Auto review; Full access asks nothing. The card says what runs (`Debug cart.js`, the
  breakpoints in its detail) and why it asks: "Debugging cart.js runs it outside the sandbox, with your environment,
  as your own terminal would. While it runs, the agent can step it and evaluate expressions in it." Read Only refuses
  and says to switch to Workspace Write. The yes can cover the rest of the session for the same configuration and
  file; there is no Always allow rule, since a rule saved to a file would outlive what the person saw. A `Debug` deny rule refuses; an allow rule does not skip the question.
- **drive** is for the person's runs: reading them (`state`, `variables`) is free, as the Debug tab shows the same;
  stepping, continuing, pausing, evaluating in or stopping one asks ("Run r2 is yours: the agent asks before it
  steps it…"), since that changes what their program does. Read Only refuses it.
- The agent's own runs ask nothing more after their start: stepping and evaluating were what the person approved.

### The engine (`packages/workspace/src/debug.ts`)

`FolderDebugger.forAgent(sessionId)` gives the session a view of the folder's debugger:

- A run it starts is marked with its owner. Its breakpoints and exception filters are its own, sent only to that run;
  the person's `setBreakpoints` and `setExceptions` leave agent runs alone, and the person's gutter does not show the
  agent's breakpoints.
- Each run keeps what it printed (the last 2,000 lines), so a report says what came since the last one. The
  program's pipe and the debugger's connection are two channels, and on Windows a stop often arrives before what was
  printed just before it: a report after a stop waits until nothing more is printed for 150 ms, at most 600 ms.
- A session sees its own runs and the person's, never another session's. Closing the session (its scope released)
  stops its runs.
- The turn's signal stops a run the turn started, its build included, when the person stops the turn.
- Every session view has `stops`, a count of stops whose frames have been read, so a wait ends on a new stop and not
  on the one already reported.

### In the window

The Debug tab lists an agent's run with an **Agent** tag and a Stop button. Only the person's runs choose a frame on
their own: the editor's paused line and the panel's values stay on the person's run until the person picks the
agent's. The chat shows the tool as "Debugged" with what it did (`start cart.js`, `evaluate item.qty * 2`).

## Consequences

- The agent finds a wrong value in one turn, without editing files to print it, and the person sees each start before
  it happens.
- A paused agent run holds its program until the agent or the person stops it, the session closes, or the turn is
  stopped. Three at most per session.
- A model that wants to debug the person's paused program asks for each step. That is slower, and it is the point.
- The agent sees what the program prints and its values, which may hold the person's data, as its Read and Bash can.

## Verification

- `packages/workspace/src/debug-agent.test.ts`: real Node.js runs through the tool (Python and C where debugpy and
  lldb-dap are installed): the report's form; the person's breakpoint not hit by the agent's run; evaluate, variables
  by path, steps with a return value, conditions, log points, an uncaught exception without its stack; waits that end
  on a new stop; reading the person's run free and driving it asking; two sessions apart; `close()` stopping a
  session's runs; the 3-run cap, breakpoints outside the folder, a bad hit condition, an unknown configuration and an
  untrusted folder refused; the turn's signal stopping a run.
- `packages/core/src/approval.test.ts`: a start and driving the person's run ask under Workspace Write and Auto
  review; Read Only refuses both and Full access asks nothing; a deny rule refuses and an allow rule does not skip the
  question; a yes covers the session for the same start or run, never as a rule.
- `packages/core/src/debug-tool.test.ts`: loaded through ToolSearch, the card's title, detail and reason, nothing run
  before the yes, Read Only refusing, not offered without a debugger nor to subagents.
- `apps/desktop/src/panels/debug.test.ts`: the agent's runs left alone until the person picks one.
- The end-to-end smoke: the agent starts the checkout with a conditional breakpoint of its own, the card asks once and
  says it runs outside the sandbox, the report reaches the model with the place and the values, the Debug tab shows
  the run as the agent's without moving the editor, and its Stop button ends it.
