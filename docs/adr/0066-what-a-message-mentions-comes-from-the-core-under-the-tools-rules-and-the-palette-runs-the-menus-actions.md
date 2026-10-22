# 0066. What a message mentions comes from the core under the tools' rules, and the palette runs the menus' actions

- Status: Accepted, builds on 0055, 0059, 0062 and the command registry of the UI shell
- Date: 2026-10-22

## Context

People reach for three things in a coding agent's message box: `/` for a command, `@` for a file and `$` for a skill,
plus one key (Ctrl+K) that finds anything the app can do. Each looks like a renderer feature, and each has a trap:

- **A mention is a read.** `@.env` or `@C:\Users\me\secrets.txt` attaches a file the agent would have had to ask for
  (0055). If the renderer read the file and pasted it in, it would bypass the folder's rules, the approval for reads
  outside the workspace and the size limits of Read, and the command line would behave differently from the window.
- **A mention is text the model reads.** A file's contents can carry instructions. Pasted into the person's own words,
  they gain the person's authority.
- **The model must not pay twice.** A file that came with the message and is then edited needs no Read first (Edit
  refuses a file it has not read), and a file mentioned again unchanged should not be sent again (0062).
- **A skill is the person's choice of instructions.** `$name` should bring the skill without a Skill call, but a rule
  that refuses or asks about that skill (0059's floor for the Skill tool) must still hold.
- **Two lists of commands drift.** Menus, shortcuts, the palette and slash commands that each call their own code
  disagree on what is enabled and what a command does.
- **Esc is everyone's key.** It closes menus, pickers, dialogs and the editor's find; approvals and questions answer
  with it. Stopping the agent on one Esc would cut work off by accident.

## Decision

- **The renderer writes text; the core resolves it.** The pickers only write `@path` (quoted when it has a space) and
  `$name` into the message. When the message is sent, the core's `mentionBlocks` (packages/core/src/mentions.ts)
  finds the `@` and `$` words outside code spans and blocks, and puts what they name in front of the person's words.
  The command line gets the same behaviour from the same code.
- **A mentioned file comes only when Read would show it without asking.** It must be inside the workspace or an extra
  root the person added, or allowed by a rule, and no rule may deny or ask about it. Any other file is named in a "Not
  attached" list instead, with the reason, and the model reads it through its tools, where the rules and the approval
  apply. Folders come as a listing of up to 200 entries. At most 8 files and folders
  come with one message, up to 100,000 characters each and 120,000 in all, read the way Read reads them (first lines,
  numbered; no images, PDFs, notebooks, binary or very large files).
- **Framed as data, kept out of the person's words.** The files come in a `<mentioned_files>` block that says they are
  the project's text, not instructions. The thread, the session's title, the request digest and compaction treat the
  block as eNCode's, like a reminder: the person's message is stored and shown as typed.
- **A mentioned file counts as read.** It is recorded the way Read records it (partial when cut), so Edit works at
  once; mentioned again with the same lines and hash, it comes as one line, "Unchanged since you read lines 1-N".
- **`$name` brings the skill, under the Skill tool's rules.** The skill's body comes in an `<invoked_skill>` block
  (up to 32,000 characters, the rest named by file), at most 3 per message. A rule about `Skill(name)` that is not an
  allow leaves the skill to the tool. When the conversation still holds the same block, a short note is sent instead.
  `/name` of a skill calls it the same way.
- **One registry, three ways in.** The palette lists the registry's commands that are visible and enabled now, the
  other open sessions and the settings pages; slash commands map onto the same actions (`/model` opens the model list
  the way Alt+M and the palette do). Matching and ranking are one pure module (src/palette/model.ts) shared by the
  palette and the pickers, so what "finds" means is unit tested once. The palette remembers its last 8 picks.
- **A word that is no command is not sent at the first Enter.** The message box says what a second Enter does.
- **Esc twice to stop.** The first Esc in the message box or on the thread, while the agent works, only arms Stop and
  says so under the box; a second within 1.5 s stops. An Esc that a field, a menu, a picker or a card has already used
  does not count, and while an approval or a question waits, Esc stays theirs.

## Consequences

- The person can point at files and skills without spending the model's steps on Read and Skill calls, and nothing
  reaches the model through a mention that the tools would not have read unasked.
- The command line and the window agree on what a message brings, because neither the renderer nor the CLI reads
  the files.
- A mention of a file outside the workspace costs the model one Read and the person one approval, by design.
- Adding a command to the registry adds it to the menus, the palette and (when it has a slash name) the message box;
  the menu, palette and slash tests fail when the lists disagree.
- Still open: rebinding shortcuts, finding text in a session, steering a running turn and choosing the reasoning
  effort (UI-5b).
