# 0120. The Computer tool opens applications from the Start menu, and the pointer goes where it acts

- Status: Accepted, builds on 0050 and 0054
- Date: 2026-10-25

## Context

A tester asked the agent to "use your GUI skill and open my Discord". Their diagnostics and screenshots showed this:

- Discord was running with its window hidden in the notification area. The Computer tool lists only windows that
  show, so it found nothing to work on.
- The tool's description told the model to start programs with Bash. The agent ran `Start-Process`, ended Discord
  with `Stop-Process -Force` to get a window, wrote PowerShell scripts in the temporary folder, and never used the
  screen.
- The model searched for a skill named "gui" before it found the tool.
- The tester saw no pointer move at all. When the outline lists an element, the tool uses it through the
  application's own interface (0050): the button is pressed, but the mouse never moves. The banner of 0054 was up
  for the two minutes of the turn, and nothing visible happened under it.

## Decision

- **`open`, by the name the Start menu shows.** The helper reads the shell's Applications folder
  (`shell:AppsFolder`), which lists programs and Store apps alike, the way the Start menu does. For each entry it
  reports the name, the shell's id, and the program it runs when the shell knows it. The program comes from the id
  when that is a program's path, or else from the shortcut behind the entry. For Squirrel installs (Discord, Slack),
  that is the program `Update.exe --processStart` names.
- **The shell starts it.** `explorer.exe shell:AppsFolder\<id>` hands the request to the running shell and ends. So
  the application is the person's own program, with the person's own environment, not a child of eNCode or of the
  helper's short environment. An application that already runs is asked to show itself, just as a second click on it
  in the Start menu would, and that is how a window comes back from the notification area.
- **What `open` takes:**
  - It never takes a command line or a path, only an entry of the list the helper read, checked again by the helper
    before it starts anything.
  - Entries that are not applications are left out: documents, web links and help files.
  - So are entries that change the computer instead of opening an application: uninstallers, setup and repair.
  - The approval is the one for any application (0050). It asks about the program the entry runs, so allowing the
    open allows working in its window. For a Store app whose program is not named, it asks about the app by its name.
  - Terminals, shells and system tools are refused, by their program as in `apps.ts`, and by their name for Store
    apps (Terminal).
- **The answer is the window that showed.** The helper waits up to 15 seconds for:
  - a new window of that program (the largest one, if several show);
  - a window of it that comes to the front;
  - for a launcher, a new window in front that bears the application's name;
  - for an application that was open already and shows nothing new, its window after two seconds.

  A window that closes again at once was a splash screen, and the wait goes on. The tool then looks at the window
  and gives the model its outline (and its picture, for a model that reads pictures). If no window showed, the model
  is told to look again in a moment and never to end the program to get a window.
- **The pointer goes to what is used.** At the person's pace (`smooth`, the default), the pointer travels to an
  element before the element is used through its own interface: invoke, toggle, set a value, select or focus. Whoever
  watches sees what is about to be pressed, and the press still goes through the application's interface, which
  keeps working when things move. The trip never fails a step: if the element is out of view or under another
  window, it is still used. The person's own hand on the mouse still stops the agent, as it always does. At
  `instant` pace (tests) nothing moves, as before.
- **The tool's description names it.** "GUI", "the screen", "the desktop" and "computer use" all mean this tool,
  and it is not a skill. `open` comes first in how to work with it.

## Consequences

- "Open Discord" works whether Discord is closed, in the notification area, or behind other windows. The agent no
  longer needs PowerShell, and has no reason to end a program.
- The pointer moves during desktop work wherever the agent acts. That was already true of everything done with the
  mouse; now it is true of everything.
- Starting a program from the Start menu takes the person's approval for that program the first time in a session
  (except under Full access), like any other use of it.
- An application that shows no window of its own and no window bearing its name (a tray-only program) gets "no
  window showed", which is the truth.
- `tool.test.ts` covers: matching names, refusals, approvals, the Start menu read once for an approval and its call,
  no window, and a window not yet allowed. `desktop.test.ts` covers the requests and checks. The Windows integration
  test covers two things on a real desktop: a Start menu shortcut is listed with its program, opened through the
  shell, and answered with the fixture's window; and the pointer ends on a button pressed through its interface.
