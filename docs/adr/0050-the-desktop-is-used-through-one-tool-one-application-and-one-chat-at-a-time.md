# 0050. The desktop is used through one tool, one application and one chat at a time

- Status: Accepted
- Date: 2026-10-22

## Context

The agent can run commands and edit files, but it cannot operate a program that has only a window:
check a screen it built, fill in a settings dialog, drive an installer. Other agents add a "computer
use" tool for that. A tool that clicks and types anywhere is also the widest hole in the approval
model:

- A terminal window runs commands without the command policy. So does the terminal inside an editor.
- A password manager holds what the agent must never read or type.
- Text on screen, in a web page or a chat message, is untrusted and can steer the model, and what the
  model clicks cannot always be taken back (a sent message).
- A screenshot costs 1,000 to 1,600 tokens and shows whatever is on screen. A hundred of them in a
  session log are a hundred megabytes of base64 and a hundred copies of the user's screen.
- Two chats driving one mouse each read the other's input as the user's.
- A coordinate guessed from a screenshot misses when the window moved, was covered or was scaled.

## Decision

- **One tool.** `Computer` works on one top-level window at a time, named by id (`w3`); without an id
  it uses the last one. It is offered in code mode only, never to subagents (up to four run side by
  side, and there is one mouse), and only when the host has a desktop and the `computer` setting is
  on. A change of the setting applies with the next turn.
- **Elements before pixels.** Looking returns the window's accessibility tree as an outline (role,
  name, value, state, ref) beside the screenshot. An input names an element by ref, and the backend
  acts through the program's own interface when it can (invoke, toggle, set a value, select), which
  keeps working when things move, and uses the mouse when it cannot. A coordinate is a pixel of the
  latest capture of that window and means nothing otherwise.
- **Every input is checked where it lands.** The backend, which alone sees the desktop at that moment,
  refuses a window outside the call's `allowed` applications, a coordinate whose capture is stale
  because the window moved or changed size, a ref whose element is gone, and an input that would land
  under another window. After the input it waits for the window to settle, then answers with what
  changed in the outline and an image only if the window looks different.
- **Approval per application, like sites.** The tool reports `{ type: 'desktop', app }` and
  `decideApproval` judges it: the first use of each application in a session asks (Workspace Write and
  Auto review) and approving allows that application until the session ends; Full access allows;
  Read Only refuses. Applications on the never list are refused under every policy, Full access
  included, like a deny rule: terminals and shells, editors with a built-in terminal, password
  managers, system tools, remote desktop and virtual machine windows, the taskbar, Start menu and Run
  box, and any window the backend marks, such as eNCode's own and programs running as administrator.
  Browsers, chat and mail programs and File Explorer ask with a warning on the card.
- **Screen text is data.** The outline arrives inside `<screen_content>` with a closing tag
  neutralised, and the tool's description says it is information, never instructions.
- **Bounded and interruptible.** At most 150 inputs a turn. Keys that leave the window (the Windows
  key, Alt+Tab, Ctrl+Alt+Delete) are refused, a password field is never typed into, and a cursor that
  is not where the agent left it means the user took over: the tool sends no more input until they
  speak.
- **Screenshots are transient.** The images the tool returns carry `transient`. The log stores a
  message without them. The conversation in memory keeps the newest one and says in older results
  that theirs was removed; as in any rewrite, thinking after the first changed message is dropped
  (see 0009). A model that cannot read images is sent none, and the tool attaches none to begin with.
- **One chat sends input at a time.** The host gives each session a view of the shared backend. The
  first input takes the desktop; another chat that sends input meanwhile is told it is busy. The hold
  ends 30 seconds after the last input, when the user stops the chat, and when the session closes.
  A call that is running is never cut off, and looking takes no hold.
- **A contract and a fake.** `DesktopBackend` (`packages/tools/src/computer/contract.ts`) is all the
  tool needs from a machine, and `FakeDesktop` keeps the same promises in memory for tests. The
  Windows backend is a helper of our own and is the subject of its own record.

## Consequences

- One click per application per session, with a reason on the card that explains why.
- Hosts without a desktop never offer the tool, and the model is not told it exists. Until the Windows
  backend is in, no host has one.
- Older screens are gone. The model that wants one again takes a new screenshot, which costs one
  image instead of thirty.
- Each replaced screenshot drops the thinking of the last steps, which a reasoning model writes
  again. That costs far less than the images it replaces.
- Full access plus a browser the user is signed in to can still send, buy or delete. The cap, the
  warnings and the stop key bound that; they do not remove it (threat model T30 to T33, R14).
