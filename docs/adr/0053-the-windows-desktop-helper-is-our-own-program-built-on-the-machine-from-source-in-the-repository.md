# 0053. The Windows desktop helper is our own program, built on the machine from source in the repository

- Status: Accepted
- Date: 2026-10-22

## Context

0050 fixed what the Computer tool needs from a machine (`DesktopBackend`). On Windows that is a way to
list windows, take a picture of one, read its accessibility tree (UI Automation), and send mouse and
keyboard input that lands where it was aimed. Node cannot do any of that by itself, and the usual ways
to add it do not fit:

- A native Node module is a binary per Electron version, an outside library in the app's own code
  (0003) and one more thing the installer must carry and sign.
- PowerShell scripts start in a third of a second to a second, are what antivirus programs distrust
  most, and cannot hold a hook, a handle or a cache between calls.
- A prebuilt helper checked into the repository is a binary nobody can review.

Every Windows 10 and 11 already has the .NET Framework 4 and its C# compiler (`csc.exe`, C# 5), and
the WPF assemblies that wrap UI Automation.

## Decision

- **A program of our own, in C#, in this repository.** `packages/tools/src/computer/windows/helper/`
  holds it: about four thousand lines, no libraries beyond the Framework, no reflection. The sources
  are embedded in the host bundle as text and the helper is **compiled on first use**, with the
  compiler Windows ships, into a folder named by the hash of the sources under
  `%LOCALAPPDATA%\eNCode\helper`. The hash of the built file is recorded beside it and checked before
  every start: a file that does not match is built again, so an altered or half-written copy never runs.
  A finished build moves into place by one rename, one build serves every window of eNCode, and builds
  older than two weeks are removed. The first use takes a few seconds; later ones start in a fraction of one.
- **One request at a time over standard input and output**, one JSON object per line, with a protocol
  number in the helper's hello (a helper of another number is not used). Looking and acting can be
  cancelled: the helper stops at its next safe point and lets go of every key and button, and one that
  is still busy eight seconds later is killed and started again. A UI Automation call runs on a
  thread that is given up on when the program does not answer, so a program that shows a dialog from
  inside a call, or has hung, costs one call and not the helper. Window numbers go on from where the
  last helper stopped, so an id from before a restart never names another window.
- **The outline is the first way in.** Elements get refs that stay the same while the element lives.
  A click, a text, a value or a selection goes through the element's own patterns (invoke, toggle,
  value, selection) when it has them, and through the mouse or the keys when it has not, and the
  answer says which was used and why. A pattern call that does not return in two and a half seconds
  is taken as done by a program that is busy with it (usually a dialog) and reported as such.
- **Input is checked where it lands**, as 0050 requires. Before the pointer moves and after it has
  arrived, the window under it must be the one the call is about (or a menu, list or dialog it owns);
  a coordinate must belong to a picture whose window has not moved; the keyboard goes only to the
  window in front, which the helper brings forward first with the foreground-lock workaround and
  proves it did. A password field is never typed into: the check asks the program which field has the
  focus and refuses on any doubt. Combinations that leave the window are refused again here, behind
  `keys.ts`. Everything pressed is released in a `finally`.
- **The user's own input stops the agent without being recorded.** While an action runs, low-level
  hooks watch for mouse and key events that are not injected and nothing else: the helper reads the
  "injected" flag of each event and never its key, position or text. The hooks exist only for the
  length of one action and are removed at its end.
- **Pictures show only what the call may see.** The picture is of the window's own area, with every
  window of another program that lies in front of it, and every password field, painted over; the
  number painted over is part of the answer. It is a PNG, or a JPEG when the PNG would pass 900 KB,
  at a size the model reads well, and the arithmetic from picture to screen is the same code as in
  `geometry.ts`: a parity test runs both against each other.
- **eNCode's own windows and windows of programs running as administrator are never used.** The
  second cannot be driven from a normal process anyway (UIPI), and a click that cannot land must say
  so. The first is by process id and by program path, and the host gives both.
- **The helper starts with a short list of environment variables**, not eNCode's, and with no more
  rights than eNCode has. It opens no network connection and writes nothing to disk; what it was built
  from sits in its own folder, which only eNCode writes.
- **Tested on the real thing.** The pure parts (arithmetic, key table, JSON, outline rules) are
  compiled and run against the TypeScript from node:test. The rest runs on Windows CI against a window
  of our own (`fixture/Fixture.cs`) that writes down every event it receives, so a click is checked by
  where it arrived, not by what the helper said.

## Consequences

- Nothing is downloaded, nothing is signed separately and the whole of what runs is in a diff.
- A computer without the .NET Framework 4 compiler (a damaged Windows) cannot use the tool, and the
  message says what to repair. An antivirus program may block a program it has never seen: the message
  names the file to allow.
- The helper is C# 5 and .NET Framework 4: no newer syntax, no packages, and Windows-only. macOS and
  Linux get their own backends behind the same contract, or none.
- Reading a very large window's tree takes up to three and a half seconds and is cut after 2,500
  elements; the answer says how many were not listed, and `find` searches the whole tree.
- Elements a program does not expose (games, canvases, some Electron views until accessibility is
  switched on) are reached by picture and coordinate only, with the same landing checks.
