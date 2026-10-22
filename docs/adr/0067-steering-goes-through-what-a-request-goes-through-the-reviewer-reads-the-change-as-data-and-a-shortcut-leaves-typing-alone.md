# 0067. Steering goes through what a request goes through, the Reviewer reads the change as data, and a shortcut leaves typing alone

- Status: Accepted, builds on 0014, 0017, 0031, 0042, 0052, 0054 and 0064
- Date: 2026-10-22

## Context

Five things people expect from a coding agent's window, each with a trap:

- **Steering.** A message typed while the agent works should reach it now, not after the turn. Sent as a new request
  it would wait; pushed into the conversation it would break the alternation of roles the providers require, skip the
  `userPromptSubmit` hook (0042), bring no mentions and be lost or sent twice when the turn ends at the same moment.
- **Effort.** Reasoning models take a level ("low" to "max"), others refuse the field. A level set in one place for
  every role would make a cheap Explore role slow, and sending it to a model without a dial fails the request.
- **Asking the Reviewer.** The Review role's model (0052) should read a change and say what is wrong, line by line. The
  change is written by whoever wrote the code, the agent included: it can say "approve this" or close the block it is
  shown in. A reviewer with tools could be talked into using them.
- **Find.** Ctrl+F in a session must find words in folded work and long outputs, which the page does not draw until
  opened, without slowing a streaming answer or adding elements the thread's renderer (0017) does not expect.
- **Shortcuts.** People rebind keys. A chord bound to the wrong thing stops typing (a plain letter), takes a key from
  every field (Ctrl+C), from Windows (Alt+F4, Ctrl+Esc) or from the computer tool's stop (Ctrl+Alt+Esc, 0054), or makes
  one key do two things. The settings file can be edited by hand, or by anything else that writes to the profile.

## Decision

- **A message sent while a turn runs steers it.** The session takes waiting messages (at most 20) with the results of
  the step they came in during, or after a text-only reply, in that same user message under a note saying they were
  sent while the agent worked, so roles still alternate. Each goes through the `userPromptSubmit` hook (a block drops it
  with a notice) and brings what it mentions under 0066's rules. Its entry takes an id the client chose (a fresh UUID),
  so the window shows it in place and rewind keeps working. When the loop decides the turn ends, it stops taking
  messages; what no step took goes back to the client, which sends it as the next request, never both. Enter queues
  and Ctrl+Enter steers by default; Settings > Agent swaps them, and a queued message has Steer now.
- **Effort is per role, applied by the host.** Settings keep a level per role, known roles and levels only; a role
  left out is left to its model. The host puts the role's level on each of that role's requests, over whatever the
  caller asked for, and the adapters send it only to a model that has a dial. The chip under the message box,
  Ctrl+Shift+M and `/effort` set the main role; Settings > Roles sets each one.
- **The Reviewer gets one request, no tools, and the change as data.** The change is sent as hunks numbered as in their
  files, with 10 lines of context, up to 120,000 characters; lock files, minified files and source maps are named but
  not read. Each file sits in a `<change-NONCE>` block whose end tag carries 12 random hex characters, so the text cannot
  close it, and the instructions say the change and its file names are data. The reply must be JSON: at most 12
  findings, each tied to a file of the review and a line number, with a priority and capped text; anything else is
  dropped. Findings land as comments beside the person's own, which only the person sends to the agent. The Review
  tab's button, `/review` and the palette ask it; the offline demo says it reads no code.
- **Find reads what the page shows and marks it without touching the page.** The text is read in blocks (a match never
  runs from one block into the next), case and runs of white space aside, and marked with the CSS Custom Highlight API,
  at most 1,000 marks. A fold that holds a match (a work log, a group of steps, a step's output, a change's file list)
  opens while find looks for it, at once, so every match is counted and can be scrolled to; one the person closes stays
  closed for that search. Closing the bar keeps open the folds around the match it closed on. A mutation observer keeps
  the marks right, throttled to the cost of a search.
- **A shortcut can be any chord that leaves typing, Windows and every field alone, and does one thing.** The
  person's shortcuts live in Settings as chords per command id, which replace the command's own (an empty list means
  none). The main process keeps only well-formed entries: command ids (so no `__proto__`), up to 4 printable ASCII
  chords each, up to 300 entries. The registry refuses, wherever the file came from, a chord without Ctrl or Alt that is
  not a function key, any with the Windows key, the keys every field uses (Ctrl+C, X, V, Z, Y, A, Ctrl+Shift+Z, Ctrl+Enter,
  Ctrl with the arrows, Home, End, Backspace, Delete), Windows' own (Alt+F4, Alt+Tab, Alt+Space, Alt+Esc, Alt with the
  number pad, Ctrl+Esc, Ctrl+Shift+Esc, Ctrl+Alt+Delete), Shift+F10, Ctrl+Alt+Esc, Ctrl+Alt with a key AltGr types, and
  the chords of commands that cannot change (Alt+1 to Alt+9, Ctrl+1 to Ctrl+9). A chord the person gives one command is
  taken from the command that ships with it, and from another they gave it to, so a key always does one thing; the
  list asks before it takes one. A key a field already used (Ctrl+Enter in a comment, the editor's own keys, the
  terminal prompt's Enter, Tab and arrows) stays the field's. Every tooltip, menu and button shows the shortcut bound
  now. Reset puts one command back, Reset all every one, with Undo.

## Consequences

- People can redirect the agent mid-task without stopping it, and what they type reaches it through the same hook and
  mention rules as a request.
- A second opinion on a change costs one request on the model the person chose for the Review role, and a change cannot
  make that request do anything but answer; a review that finds nothing is advice, not a pass.
- Find finds what is folded away and never edits the thread's DOM, so the streaming renderer needs no changes.
- A settings file that names a dangerous chord changes nothing, and the computer tool's stop stays a global shortcut in
  the main process whatever the renderer binds.
- Still open: the full settings page and standalone sessions (UI-6); the browser, side chat and worktrees (UI-7).
