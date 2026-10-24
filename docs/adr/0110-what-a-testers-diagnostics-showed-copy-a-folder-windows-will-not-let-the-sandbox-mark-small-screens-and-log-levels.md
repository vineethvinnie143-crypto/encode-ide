# 0110. What a tester's diagnostics showed: Copy, a folder Windows will not let the sandbox mark, small screens, and log levels

- Status: Accepted, builds on 0063 and 0109; the one-click fix is built by 0118
- Date: 2026-10-24

## Context

The first tester sent Help > Save diagnostics from their PC, running the 0.1.0 tester build (16146c2) on a
1366 x 768 screen. Their project was `D:\TEST SERVEr`, and the report showed four problems:

- **Copy did nothing.** The log held three `NotAllowedError: Failed to execute 'writeText' on 'Clipboard': Write
  permission denied`. eNCode's page may ask the browser engine only for what `restrictPermissions` allows, and that was
  only the list of fonts. So every Copy button failed: copy a message or a reply, a code block, an install command, the
  build information, the status, a problem's details, the folder path. They failed silently, as unhandled rejections.
- **The sandbox could not prepare the folder.** The log said `D:\TEST SERVEr could not be prepared for the sandbox:
  CreateFile(\\?\D:\TEST SERVEr) failed: Access is denied (error 5)`. The Windows sandbox marks a folder with the low
  integrity level (0063), and Windows lets only an account that may change a folder's owner set that mark. An account
  with plain Modify rights cannot. That is common for a folder on a second drive made by an administrator or by an
  earlier Windows installation. Every command in the folder then failed inside the sandbox, the agent retried it
  outside, and under Workspace Write that was a second card for every command.
- **The chat was squeezed.** At 1366 px, the sessions list (272 px) and the side panel (440 px) left the thread about
  560 px.
- **Routine lines were logged as errors.** Every line the agent host printed went into the log as `ERROR`, with its
  name twice. That included the model router's own notes and requests that worked on a second try, so the report read
  worse than it was.

## Decision

- **Copy works.** eNCode's own page, in its main frame, may write plain text to the clipboard
  (`clipboard-sanitized-write`). Reading the clipboard stays refused; the editor pastes from the paste event, which
  needs no permission. The rule is a pure function (`electron/permissions.ts`) with tests. Every Copy button goes
  through `copyText`, which tells the person when a copy fails. The smoke clicks Copy reply, pastes into the message
  box and checks that the text comes back; that fails against the old rule.
- **A folder Windows will not let the sandbox mark is said plainly.**
  - The Windows engine turns an access-denied answer from the helper into `SandboxError('no-permission')` naming the
    folder. Its words tell the agent to run commands there with `unsandboxed` from the start, so it no longer fails
    each command first.
  - The sandbox keeps those folders until one prepares or the machine is checked again.
  - Settings > Sandbox says why commands there run only outside the sandbox: the person is asked each time, unless
    they chose Full access. It names what helps: a copy of the folder inside the user folder, or Full control of the
    folder for the account (Properties > Security), then Check again.
  - A one-click fix with administrator rights (a UAC prompt for icacls) was written up and refused by the coding
    agent's own safety check, because it changes a folder's permissions. It was not built then and waited for the
    owner's call; the owner asked for it, and 0118 builds it.
- **Room for the thread.** On a small screen the side panel gives up width, down to 360 px, and then the sessions list,
  down to 220 px, before the thread's column drops under 720 px. That holds while their widths are as shipped: from the
  first touch of a divider the width is the person's and is kept, as before. Below 1100 px the side panel still floats
  over the thread, and the sessions list keeps its width. The smoke takes its
  screenshots at 1366 x 768 too, and checks that the thread's column stays at 700 px or more with the side panel open.
- **The host's lines keep their level.** The main process reads a line from the agent host as the router's level for
  `router <level>:`, as info for a request that ended done or was stopped by the person, and as a warning for one that
  failed. Everything else stays an error. The host is named once.

## Consequences

- Copy buttons work in the tester build, and a failure says so instead of passing in silence.
- In a folder like `D:\TEST SERVEr`, Workspace Write asks once per command, not twice. Full access runs commands outside
  the sandbox without asking (0109). Fixing the folder's permissions is the person's own step until the owner decides
  on the one-click fix.
- At 1366 x 768 the thread gets about 712 px with the side panel open. A narrower side panel cuts long tab names short.
- A diagnostics report shows errors only for what went wrong.
