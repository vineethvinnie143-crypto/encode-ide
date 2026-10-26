# 0143. eNCode debugs Node.js with a client of its own, from the gutter and a Debug panel

- Status: Accepted, builds on 0015, 0062, 0088 and 0111
- Date: 2026-10-26

## Context

eNCode had no debugger. To find why code misbehaved, the person, or the agent, added `console.log` lines, ran the
program again and read the output. Every editor people move from has breakpoints, stepping and a view of the values.

The constraints are eNCode's own:

- Its own code only. No VS Code source, so no `vscode-js-debug`, and no outside library in the app. A debugger of
  another language may run as a separate program, as language servers do (0062). That is the next part.
- The person's Node.js and TypeScript come first: the projects eNCode is used on now are mostly Node.js.
- A run starts the folder's code. Opening a folder must not do that (0062's trust rule).

Node.js speaks the Chrome DevTools Protocol (CDP) on its inspector port, so it needs no adapter program.

## Decision

### The engine (`packages/debug`)

- **A CDP client of our own** (`cdp.ts`) over Node.js's own WebSocket, and a `DebugSession` that drives every Node.js
  program of a run.
- **Every program of a run is debugged, the ones it starts included.** `npm run dev` starts Node.js, which may start
  another. A small boot script of eNCode's own (`boot.ts`) goes into each program through `NODE_OPTIONS`.
  - It opens the inspector on a free port of 127.0.0.1.
  - It writes the inspector's address into the run's own folder (owner-only).
  - It waits until the debugger has placed the breakpoints.
  - It leaves alone worker threads, programs already being inspected, the package managers, and tsx's command.
- **TypeScript and other compiled code through source maps** (`sourcemap.ts`), our own reader.
  - A breakpoint goes where the map says the line is.
  - A frame shows the line in the source.
  - V8 does not stop before a CommonJS module compiles, so the boot script stops the program there, by a function's
    name. The debugger reads the module's map and places its breakpoints before the module runs.
- **What the debugger offers**:
  - breakpoints, with a condition, a hit count (`5`, `== 5`, `> 5`, `% 5`) or a log message (`sum is {sum}`);
  - stopping on uncaught exceptions, or on every exception;
  - continue, pause, step over, into and out;
  - the stack, with Node.js's own frames skipped when stepping and shown dimmed;
  - scopes and values, opened level by level, with getters run only when opened;
  - evaluation in a frame. A hover evaluates with V8's `throwOnSideEffect`, so it cannot change the program.
- **Limits**:
  - 200 frames;
  - a value cut to 1,000 characters;
  - a source map of at most 50 MB;
  - 1,000 files, 500 breakpoints a file, 5,000 in all;
  - a condition or log message of at most 2,000 characters, an expression to evaluate of at most 8,000.

### The folder's debugger (`packages/workspace/src/debug.ts`, `debug-configs.ts`)

- **The ways to run** come from the folder:
  - its own `.encode/debug.json` (launch a program or an npm script, or attach);
  - the file open in the editor;
  - each script of `package.json`;
  - a program already listening on port 9229.
- **What runs it.** Node.js is the one on PATH, as a terminal would run it, or eNCode's own when none is installed.
  TypeScript goes through the project's tsx, or Node.js's type stripping when it is new enough.
- **Trust.**
  - A run starts only in a folder the person trusts, and only when the person starts it.
  - Not trusted, the panel says why and keeps the breakpoints.
  - Attaching connects only to 127.0.0.1 or localhost.
- **Breakpoints are kept by eNCode, per folder**, in its profile (`debug/breakpoints`), never in the folder. A folder
  cannot bring breakpoints, and with them conditions to run.

### The app

- **The agent host owns the runs.** Requests: `debugState`, `debugConfigs`, `debugStart`, `debugAct`,
  `debugBreakpoints`, `debugExceptions`, `debugScopes`, `debugVariables`, `debugEvaluate`. Events: `debug`, which says
  that something changed, and `debugOutput`, which carries what a run printed.
  - The main process checks run ids, numbers and lengths, and turns a file into its path in the folder.
  - The host checks breakpoints, actions and filters with the workspace's validators.
  - A folder over SSH (0111) debugs on that machine, like its language servers.
  - Opening another folder stops the runs of the one before, since nothing shows them any more.
- **The editor's gutter** gets a column left of the line numbers (`breakpoints` in editor-view, 16 px).
  - A click there sets or takes away a breakpoint, and so does F9.
  - The column's context menu adds a conditional breakpoint, a hit count or a log point, and edits or removes one.
  - Breakpoints move with their lines as the text changes. The host is told once typing pauses (300 ms). A state read
    meanwhile keeps the moved lines.
  - Marks are layers of the line number's background, so folding and the change bars keep their own:
    - a dot for a breakpoint, with a bar for one with a condition;
    - a diamond for a log point;
    - grey for one turned off;
    - a ring for one not yet in code that runs.
  - The line the program is paused on has an amber band and arrow. A frame chosen further down the stack has a green
    one. When the program pauses somewhere new, the editor opens the file there.
- **Hover.** While the program is paused in the file, a hover shows the value of the name under the pointer with the
  names before it (`item.price`). It is read in the chosen frame. A name after a call or an index is not read
  (`load().name`, `list[0].name`): its last name alone would be another value.
- **The Debug tab** in the bottom panel (`Ctrl+Shift+D`):
  - the toolbar, with the configuration to start;
  - Variables, Watch, the call stack (runs of Node.js's own frames folded into one line) and the breakpoints, in two
    columns when the panel is wide and in one when it is narrow;
  - the console, with what the program printed and a prompt that evaluates in the chosen frame.
- **Keys**, the ones every debugger has:

  | Key | Action |
  | --- | --- |
  | F5 | Start, or continue when paused |
  | Shift+F5 | Stop |
  | Ctrl+Shift+F5 | Restart |
  | F6 | Pause |
  | F10, F11, Shift+F11 | Step over, into, out |
  | F9 | Toggle a breakpoint |

  - A Run menu lists them.
  - F11 stays full screen except while a program is paused. A command can now take another's key while it is enabled
    (`takesKeyFrom`), and the shortcut check accepts that one pairing.

## Consequences

- A Node.js or TypeScript program, a test runner or a dev server can be debugged without leaving eNCode or adding an
  extension, from the file or from a script of the project.
- What a run starts runs with the person's environment and outside the agent's sandbox, as in a terminal. Trust and the
  person's own F5 are the gate. The agent cannot start one yet; the agent's tool (part 3) will go through approvals.
- Every program of a run listens on a port of 127.0.0.1 while it runs, as `node --inspect` does. Another program of
  the same user can connect to it meanwhile.
- When no Node.js is installed, a run uses eNCode's own through `ELECTRON_RUN_AS_NODE`, which T14 of the threat model
  plans to close for anything else.
- Still to come, under this plan:
  - Python, Go and C/C++, through debugpy, Delve and lldb-dap as separate programs over the Debug Adapter Protocol;
  - the agent's own debug tool.
