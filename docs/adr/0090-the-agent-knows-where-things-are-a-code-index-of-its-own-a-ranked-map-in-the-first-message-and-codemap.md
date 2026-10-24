# 0090. The agent knows where things are: a code index of its own, a ranked map in the first message, and CodeMap

- Status: Accepted, builds on 0062, 0073 and 0089
- Date: 2026-10-24

## Context

A strong model finds its way around a project with Glob, Grep and Read. A weaker one spends most of a turn doing it.
It greps for a word, reads three files that are not the one, and edits the first function whose name fits. On a
FiveM server it does not know which resource registers `garage:server:park`, so it writes a second handler.
Every one of those steps costs tokens and a chance to go wrong.

Aider's repository map showed a better start. Give the model, before it asks, the definitions that matter most in
the project, by file and line, ranked by how much the rest of the code uses them.

The language servers of 0073 know the code exactly. They are not the right source for this:

- They run only in a trusted folder with servers turned on, and one language at a time.
- They start slowly, and one is needed for each language.
- They have no notion of "matters most".
- They do not read FiveM's registrations (`RegisterNetEvent('x:y')`, `lib.callback.register`, `exports(...)`). Those
  are strings, not symbols.

## Decision

### The index

`CodeIndex` (`packages/tools/src/codemap/index.ts`) keeps, for each source file of a folder, its definitions and the
names it uses.

- **Own code, no parser libraries.** `lexer.ts` blanks comments and string contents, keeping positions. It covers 13
  comment and string families: C-like, JavaScript with templates and regex literals, Go, JVM, C#, Rust with raw
  strings and lifetimes, Python, Lua long brackets, Ruby, shell, PowerShell, PHP and SQL. `extract.ts` reads
  definitions with rules per language on the blanked lines, tracking depth by braces, by Lua's keywords, or by
  indentation:
  - classes, interfaces, types, enums, structs, traits, impls, modules, functions, methods, constants, macros and Lua
    tables, for TypeScript, JavaScript, Python, Lua, Go, Rust, C, C++, Java, Kotlin, C#, PHP, Ruby, Swift, Dart,
    Scala, shell, PowerShell, SQL, and the scripts of Svelte and Vue files;
  - members under their class, and `Player:save` or `Router::handle` split into their parts;
  - FiveM's registrations in Lua, JavaScript and TypeScript:
    - events: `RegisterNetEvent`, `RegisterServerEvent`, `AddEventHandler`, `AddNetEventHandler`, `onNet`, and `on`
      only for a name with a `:`;
    - commands: `RegisterCommand`, ox_lib's `lib.addCommand`, `QBCore.Commands.Add`, `ESX.RegisterCommand`;
    - callbacks: NUI callbacks, `lib.callback.register`, `QBCore.Functions.CreateCallback`,
      `ESX.RegisterServerCallback`;
    - exports;
  - the names a file uses, and the event and callback names it triggers.
- **What it reads.** The same files Glob and Grep would:
  - `.gitignore` is honoured;
  - `.git`, `node_modules`, `vendor`, build output, caches and eNCode's worktrees are left out;
  - links are not followed;
  - only files in a language it reads are opened, so `.env`, keys and data files never are;
  - files over 1 MB and minified files (lines over 400 characters on average) are left out;
  - it reads at most 10,000 files, and says when a folder has more.
- **Kept up to date.**
  - It is built in the background when a session starts, in slices of 8 ms, so the agent host stays responsive.
  - A use brings it up to date first. After 10 seconds the folder is walked again, and only the files whose size or
    time changed are read again.
  - A file a tool wrote is read again before the next use, whatever its age.
- **One per folder.** The sessions in a folder share its index (`Workspaces.codeIndex`). A session in a worktree
  keeps one of its own for that worktree.
- **Small.** A definition keeps its name, kind, line, parent and the line as written, cut to 110 characters. A
  constant is cut at its `=`, so its value is never kept. A file keeps at most 2,000 definitions and its 600 most used
  names. What is kept is copied out of the file's text, so the text is not held in memory. That is about 9 MB for
  each thousand files of eNCode's own code, measured, indexed at about 1,200 files a second.

### The map

`renderMap` (`rank.ts`) turns the index into text in a budget of characters.

- **Ranked by use.** Files are nodes. A file that uses a name another file defines gives it an edge, weighted by:
  - how often it is used;
  - how few files use it (a name nearly every file uses says little);
  - how few files define it (a name defined in more than 8 files is left out);
  - five times more for a name of several words, like `renderMap` or `player_data`;
  - less for a name under 5 characters, and less for one that starts with `_`.

  A personalized PageRank over that graph (damping 0.85, 30 rounds) ranks the files. A definition gets the share of
  each use of its name, and a little of its file's rank. The ranking follows at most a million uses, so a folder of
  generated code cannot take its memory. It takes about 75 ms on eNCode's own code and about 0.7 s on a project ten
  times that size.
- **Pulled towards the work.** The request's words that may name code (identifiers, paths, words of 4 letters or
  more that are not common English) favour:
  - definitions whose names hold them, more for a word that matches few names, most for an exact name;
  - files whose path holds them.

  "Events", "commands", "callbacks" or "exports" in the request bring FiveM's registrations of that kind forward.
  CodeMap's `path` focuses the ranking on that folder.
- **Weighted by kind.** Methods, constants, macros and tables count for less than classes and functions. Private
  definitions and test files count for less, unless the map is of the tests' folder. Each further definition of one
  file counts 0.8 of the one before, so one file of many types does not fill the map.
- **Rendered.** The map is a path line, then `  {line} {line as written}` for each definition, in line order. A member
  is under its class, and the class line is added as a heading when only its members made it. The most definitions
  that fit the budget are shown, found by a binary search over the ranked list.

### What the agent gets

- **In its first message**, a map of about a thousand tokens (3,500 characters), as a reminder, pulled towards what
  the person asked. It is not sent:
  - for a project with fewer than 3 files with definitions;
  - when the index is not built within 1.5 seconds. The first message does not wait longer; CodeMap is there later.

  It stays at the start of the conversation, so it is part of the cached prefix.
- **After a summary**, the same map, pulled towards the recent requests, is part of the preface that survives the
  compaction.
- **CodeMap**, a read-only tool for the main agent and every subagent:
  - no input: a map of the project, 6,000 characters;
  - `path` of a folder: the map of that folder;
  - `path` of a file: all its definitions in line order, to Read by line range;
  - `query`: the map centered on those words;
  - `symbol`: where one name is defined (`path:line` and the line), and which files use it by name and how often. It
    says that a use by name may be another thing of the same name, and that the LSP tool tells them apart.

  It covers the folder the agent works in, or its worktree, and refuses a path outside it. It needs the read
  permission for that path, like Grep.
- **The person's rules hold.** A file that a permission rule denies reading is left out of every map and every CodeMap
  answer, in the session that has the rule.
- **Secrets are cut.** A definition's line has provider key prefixes, JWTs, long tokens of mixed letters and digits,
  and passwords in URLs replaced by `…`, and a constant's value is never kept. The search runs on the first 1,000
  characters of the line, after its spaces are collapsed, and the signature is read from its first 4,000. On a line of
  a hundred thousand characters both took seconds, found by fuzzing every language with long lines. A secret that
  starts in the 110 characters shown is in the part searched, or long enough to be found there.

### The tool budget

CodeMap's description is 713 characters. ADR 0062's ceiling for the built-in tools goes from 20,500 to 21,000
characters; they come to 20,762.

## Consequences

- A model starts a turn knowing where the main things are. "Fix the depot charge" can go straight to
  `garage/server.lua:2 local function payDepot(source)` instead of a grep and three reads.
- Finding where something is defined, or which files use an event, is one call that costs a few hundred tokens and
  reads nothing.
- The map is about names, not meaning. A name used in a file may be something else of the same name, and dynamic
  calls (`_G[name]()`, `TriggerEvent(prefix .. ':x')`) are not seen. The LSP tool stays the exact answer where
  servers run.
- Measured on eNCode's own code and on two FiveM resources (qb-garages, ox_inventory): the map leads with the
  definitions the code uses most. A request about a shop's purchase brings `ox_inventory:buyItem` forward, and
  "which events" shows the resource's events first. The benchmark of Accuracy 1d measures it against tasks.
- Open:
  - A language without rules gets no map. Adding one is a rule set and a test in `extract.test.ts`.
  - A folder of more than 10,000 source files gets a partial map, and is told so.
