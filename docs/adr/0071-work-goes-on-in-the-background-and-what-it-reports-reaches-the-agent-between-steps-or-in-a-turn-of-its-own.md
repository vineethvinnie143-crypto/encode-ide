# 0071. Work goes on in the background, and what it reports reaches the agent between steps or in a turn of its own

- Status: Accepted, builds on 0031, 0042, 0062 and 0070
- Date: 2026-10-23

## Context

Claude Code lets the agent leave work running and get on with something else: a subagent started with
`run_in_background`, which SendMessage can continue later; Monitor, which turns the lines of a command into events;
and ScheduleWakeup, which brings the agent back at a time it chose. eNCode had background commands (Bash with
`run_in_background`) and foreground subagents only. The tool parity check put these three gaps first in Parity 2, and
the owner asked for every gap to be built fully.

Three things make this harder than starting a task and forgetting it. News arrives while the agent is in the middle of
a turn, while it is idle, or while eNCode is closed. A model that is woken by every line of a chatty log spends the
person's money without anyone asking. And a subagent in the background can need the person (an approval, a question)
when no turn is running to show the card.

## Decision

- **Background subagents.** Task with `run_in_background: true` starts the subagent in the session's `SubagentPool`
  and returns at once with its agent id: "Started agent agent_… in the background. Its report reaches you as a
  notice." At most four work in the background at once. A subagent's conversation is kept in the session log under
  its agent id, with its own compactions, so SendMessage continues it with everything it saw, also after eNCode
  restarts. A message to one that still works is read between two of its steps; one to a subagent that ended
  resumes it. KillShell stops a subagent by id when no background command has that id. A foreground Task result now
  ends with the agent id, so SendMessage can go on with that work too.
- **Monitor.** Monitor runs a command through the same jobs manager, shell and sandbox as a background Bash command,
  and is judged for approval as one (`background: true`). Its output lines reach the agent in batches: what came in
  1.5 s, at most 50 lines and 6,000 characters, each line cut at 1,000 characters; what does not fit is counted, not
  sent. It stops after `timeout_ms` (default five minutes, at most an hour) unless it is `persistent`. At most eight
  run at once.
- **ScheduleWakeup.** One wake-up per session, 60 to 3,600 seconds ahead, with a reason for the person and a prompt for
  the agent; a new one replaces the old, and `cancel` removes it. It is a record in the session log and `wakeAt` in
  the index, so `AgentHost.resumeWakeups()` opens the sessions that wait for one when the agent process starts. A
  wake-up missed while eNCode was closed fires at once, and the agent is told it is late.
- **How news reaches the main agent.** Every report (a subagent's end, a monitor's batch, a command that ended, the
  wake-up) goes to the session's inbox, at most 60 items. While a turn runs, the inbox goes with the results of the
  next step, but never holds a turn open at its end, so a chatty monitor cannot keep one turn going. With the
  person's next message, it goes first, before their words. When the agent is idle and an item asks to wake it, the
  session gathers news for a second and starts a turn of its own. Such a turn continues the last request (the same
  turn id, so Rewind and the Review tab see one request), runs no UserPromptSubmit hook, and gives the model the
  news in a system reminder that says "Background work you started reports (the user did not write this)". The chat
  shows one notice line with the reports under Details, never a message from the person.
- **Cost guards.** Twenty turns of news in a row, with no message from the person, is the limit: the session says so
  and waits for the person. Stop holds background news until the person writes again and takes back the wake-up.
  Something the person stops from the Jobs tab is told to the agent when it next reads, without waking it; something
  the agent stops itself needs no notice. Starting the conversation over, or rewinding it, stops monitors, subagents
  and the wake-up; a background command keeps running (a dev server outlives a rewind) but no longer reports. Closing
  eNCode stops commands and monitors, and keeps subagents as interrupted, so the next message names them and
  SendMessage can take them on.
- **The person in the loop.** An approval or a question from a subagent in the background carries `background: true`.
  It stays when the turn that started the subagent ends, sets the session to awaiting approval or awaiting the user
  when no turn runs, and shows on the usual card tagged Background. With no turn running, Stop refuses what such a
  subagent waits on, and the subagent goes on without it; the Jobs tab stops the subagent itself.
- **The Jobs tab** shows each kind as it is: a command by what the agent said it is for, with the command under it; a
  monitor the same, badged Monitor; a subagent by its task, badged with its type; the wake-up by its reason, with
  "Wakes at 14:05" and Cancel. The header chip counts subagents and commands apart ("2 agents, 1 job running").
- **Tool budget.** Monitor, ScheduleWakeup and SendMessage are deferred, and NotebookEdit joins them, so they reach the
  model through ToolSearch. The always-sent tool definitions stay under the 20,500-character ceiling (now 19,975).

## Consequences

- The agent can run a dev server, watch its log and keep working, or hand a long search to a subagent and come back to
  it, the way it can in Claude Code.
- A turn can now start without the person. It is bounded (twenty in a row, Stop holds it, one wake-up at a time), and
  it is always visible: the notice line, the chip and the Jobs tab.
- A background subagent can wait on the person for as long as the person takes. Its card is the same card, so nothing
  new needs learning, but a session can be "awaiting approval" with no turn running; the sidebar and the window title
  show it as they do for any waiting session.
- Wake-ups depend on eNCode running. One set for a time when eNCode is closed fires late, and says so; nothing wakes the
  machine.
