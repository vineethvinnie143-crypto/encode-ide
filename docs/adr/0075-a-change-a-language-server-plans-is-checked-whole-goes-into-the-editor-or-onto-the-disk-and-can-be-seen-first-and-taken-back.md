# 0075. A change a language server plans is checked whole, goes into the editor or onto the disk, and can be seen first and taken back

- Status: Accepted, builds on 0072, 0073 and 0074
- Date: 2026-10-23

## Context

0074 gave the editor what the language servers know: suggestions, hover, the places of a symbol. The next step is
what they can change: renaming a symbol across the project, the fixes and refactorings of a code action, organizing
imports, formatting, and a list of every problem the servers found. Everything stays our own code (0003, 0072).

A change from a server is different from an answer. It can reach many files, files the person has open with unsaved
text, files nobody has open, and it can create, move and delete files. Some actions are only a command: the server
works out the edit when it runs and sends it back while it runs (`workspace/applyEdit`). Five questions needed an
answer.

- **Which text a change is for.** A server plans against the text it was given. For an open file with unsaved changes
  that is the editor's text, not the file on disk.
- **Where a change goes.** Into the editor, onto the disk, or both, without losing the person's unsaved work or their
  undo history, and without writing a file the person is still editing.
- **What the renderer may ask for.** It is the least trusted part of the app, so a change it asks for has to be
  checked, and a server must not be able to run a command or change a file it was not asked to.
- **How a person sees a change** before it is made, when it reaches files they cannot see.
- **How it is taken back** when it touched several files, some of them not open.

## Decision

### Where a change goes

- **The host holds the plan.** The renderer asks (`code:edit`) for a rename or for an action of the newest list it
  was given; the agent host asks the folder's servers for the plan and applies it. The renderer gets back what was
  done to its open documents, and which files were written, created, moved or deleted.
- **A file with unsaved changes in the editor is changed in the editor only.** Its unsaved text is what the server
  read; saving it stays the person's call. The change is refused if the editor's text is not what the server saw.
- **Every other file is changed on disk**, each only while it still holds what the server read, in its own encoding
  and with its own line breaks; an older ANSI file that cannot hold a character is not written. A file the editor has
  open without unsaved changes is then changed in the editor too, so its cursor and undo history stay.
- **The plan is checked whole before anything is written**: nothing outside the folder (by its real path), no
  document with unsaved changes moved, replaced or deleted, only single files moved or deleted, never folders, and no
  open file that was too large to give the servers. A write that fails takes back the ones before it.
- **One order.** A change waits for the editor's earlier changes and questions in the folder's lane (0074), and the
  editor sends what is still waiting for a pause in typing first, so the plan is for the text the person sees.
- After a change the servers are told what changed, the tree and git read the folder again, and a change that only
  went into the editor is one step of each document's undo history.

### Rename

- **F2** asks the server whether the symbol can be renamed and where its name is, then shows a box over it with the
  name selected. Enter renames; **Shift+Enter shows the change first**; Esc closes. A name the server refuses keeps
  the box open with the server's own reason (`'1bad' is not a valid name.`), until another name is typed.

### Code actions

- **Ctrl+.** lists the fixes for the selection, or for the problem at the cursor or nearest it on the line, grouped
  as Quick fixes, Refactor, Source and More, the preferred fix first; an action the server offers but cannot take is
  shown greyed with its reason. **Ctrl+Shift+R** lists the refactorings, and Source action the actions on the whole
  file. Enter takes an action; Shift+Enter shows its change first.
- **A lightbulb** shows beside a line with a problem a server can fix, a quarter second after the cursor rests on it,
  in the line's indentation or the gutter. Its question has its own slot, so it neither cancels nor is cancelled by
  the person's.
- **An action whose edit comes later** is filled in by the server when it is chosen (`codeAction/resolve`).
- **A command runs only if the server lists it** as one of its own (`executeCommandProvider`); a command it does not
  list belongs to another editor and is not run. While it runs, the server's `workspace/applyEdit` goes through the
  same checks as any plan; at any other time it is refused. A command can take a minute at most.
- **Organize imports** (Shift+Alt+O) and **Fix all** take the server's preferred action of that kind, or its first.

### Formatting

- **Format document** (Shift+Alt+F) and **Format selection** (the cursor's line when nothing is selected) put the
  server's edits in as one undo step, while the document is still the text they were made for.
- **Format on save** and **format on type** are settings, off by default. A save waits at most 1.5 s for the server
  and then saves the file as it is. Format on type asks only after the server's own trigger characters, with one
  cursor, and applies only if the text has not changed meanwhile.

### Seeing a change first, and taking it back

- **A preview** lists every file a change touches, sorted by path, with each changed line before and after, a tag on
  a file with unsaved changes ("Unsaved, changed in the editor"), and new, moved and deleted files. It shows at most
  200 lines a file and 2,000 in all, and says so when lines are left out; Apply makes every change. A preview is
  held by the host under an id for ten minutes; an older or another id is refused, and a new preview replaces it.
- **A change across files can be taken back whole** from its notice (Undo), for ten minutes, while every file and
  document it touched still holds what it left; otherwise the person is told which file changed since and to use
  Undo in each file.

### Problems

- **The Problems panel** (Ctrl+Shift+Y; Ctrl+Shift+M was already Choose effort) lists every file's problems by file,
  with a filter, chips that hide errors, warnings or notes, and keys to move through it; a row opens its place. The
  editor's footer count opens it too.
- **F8 and Shift+F8** go to the next and previous error or warning, on across files and round, with the message
  beside it and a way to its fixes (Ctrl+.). Esc puts the message away.

### What the renderer may ask

- The main process rebuilds every change it is asked for field by field: its file made the folder's own, a new name of
  one line without control characters and at most 500 characters, numbers as counts, the kinds of action asked for as
  at most eight short dotted names, a tab size from 1 to 16, and the editor's open files kept only where they are the
  folder's (at most 2,000). Anything else gets no change.

## Consequences

- The editor renames across the project, takes the servers' fixes, refactorings and source actions, organizes imports,
  formats, and lists every problem, with any server that follows the protocol, and the person can see a change before
  it is made and take it back as a whole.
- Unsaved work is never written to disk by a change, and a file is never written over text the server did not read.
- A server cannot run a command it did not list, change a file outside the folder, or apply an edit outside a command
  eNCode asked it to run.
- Changes to closed files are written to disk at once; they go into the folder's checkpoints like the agent's only
  when the agent makes them. Taking one back is the notice's Undo or git.
- Still to come in the next editor steps: the outline and breadcrumbs, workspace symbols, inlay hints and semantic
  tokens, folding and the rest of the engine work, the 100 MB test with highlighting off the main thread, Windows input
  and accessibility, and the fixed editor interface.
