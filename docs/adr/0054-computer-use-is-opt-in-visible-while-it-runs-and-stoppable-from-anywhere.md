# 0054. Computer use is opt-in, visible while it runs, and stoppable from anywhere

- Status: Accepted
- Date: 2026-10-22

## Context

0050 decides what the Computer tool may touch (one application at a time, asked once per application) and 0053
gives it a real Windows desktop. Neither tells the person it is happening. An agent that has the mouse and the
keyboard is the one feature of eNCode whose effects happen outside eNCode, in front of the person, in programs
that are not ours. Three things must therefore hold whatever the model does:

- Nothing reaches the desktop until the person has turned the feature on.
- While the agent is at the controls the person can see it at a glance, from whatever window is in front.
- The person can end it with one gesture that does not depend on where the keyboard focus is, and that the
  agent cannot make for itself.

## Decision

- **A setting, off by default, on Windows only.** `computer` in Settings → Agent, shown only where
  `computerSupported` is true (the platform has a backend). The agent host gets a desktop, and the model is
  offered the tool, only when both are true. Turning it off hides the banner at once.
- **Activity is read from what the agent does.** `ComputerWatch` reads the event stream that already crosses the
  main process. A session counts as using the computer from its first Computer call of a turn that was let through
  (running, done or failed; not one that waits for approval or was declined) until the turn is over, and also
  between two calls, when the model is thinking and someone who wants it to stop reaches for the control. A turn
  that waits for the person (an approval or a question) reads "waiting". A session that is removed, reset or
  whose host died is forgotten, so nothing keeps the banner up. Events are read only while the setting is on: a
  model that invents a Computer call without the tool has touched nothing and shows nothing.
- **A banner, a window of its own.** Bottom centre of the screen eNCode is on, above the taskbar: "eNCode is
  using your computer" (or "is waiting for you"), the stop key, and a Stop button. It is always in front, never
  takes the focus (the agent is typing into some other program, and a banner that took it would receive those
  keys), is out of the taskbar and Alt+Tab, and is **left out of screenshots**: the agent has no use for it and
  must not read it or aim at it. It is created when the agent starts and destroyed when it is done; it holds no
  memory in between.
- **The banner's page can do almost nothing.** It is a `data:` page with one script, allowed by the hash of its
  text in a `default-src 'none'` policy. It runs in a sandboxed process of its own session with no permissions,
  no network (the session cancels any other request), no navigation and no new windows, and its preload script
  gives it four calls: ready, size, stop, and hear what to draw. The main process answers only the banner's own top
  frame on those channels, and the renderer's channels refuse the banner, because they accept only the main window.
- **Ctrl+Alt+Esc stops it from anywhere.** The combination is registered with the system only while the agent is
  using the computer, so no other program loses it the rest of the time. The Computer tool already refuses Alt+Esc
  and Ctrl+Esc (`keys.ts`), so the agent cannot press its own stop. If another program holds the combination the
  banner shows no key, says so in the log, and the button still works.
- **Stop is the Stop button of the chat.** It cancels every session that is using the computer, the same way the
  button in the window does: the turn ends, what the agent already did stays done, and the conversation stays.
  Pressed again while a turn has not ended, it asks again. The user's own use of the mouse or keyboard already stops
  the agent from inside the helper (0053); this adds the gesture that does not need either.
- **The work log says what was done in words.** A desktop step reads "Clicked button "Save" in Notepad", "Pressed
  Ctrl+S in Notepad", "You took over", from the call's input and the one line the tool keeps for people. No
  screenshot is shown or kept: 0050 has them transient, and a picture of the person's screen in a log that is
  saved, exported or sent as a report is the exact thing they would not want.

## Consequences

- The person always knows, and can always stop, without opening eNCode. The cost is a small always-on-top window
  while the agent works and a global hotkey for the same time.
- Another program that is always on top, or a full-screen program with exclusive access to the display, can cover the
  banner. The shortcut still works, and the agent's inputs are still checked and stopped by the user's own input
  (R18).
- The banner follows the screen eNCode is on, not every screen; the agent can see all of them.
- A new banner window each time the agent starts costs a fraction of a second and no memory afterwards.
- macOS and Linux get the setting, the banner and the stop key unchanged if they get a backend: nothing in this
  decision is Windows-specific except the backend.
