# 0118. Fix this folder gives your account Full control after an administrator's yes

- Status: Accepted, builds on 0063 and 0110
- Date: 2026-10-24

## Context

A tester's project, `D:\TEST SERVEr`, still could not use the sandbox in the fourth tester build. The Windows
sandbox marks a folder with the low integrity level (0063). Windows only lets an account set that mark where it may
change the folder's owner (WRITE_OWNER), and plain Modify rights do not include that. A folder an administrator made,
often on a second drive, gives other accounts only Modify. Since 0110 eNCode says so on Settings > Sandbox, and
commands there run outside the sandbox: asked about each time, or without a card under Full access.

0110 left the fix to the person: give the account Full control in Properties > Security, or work in a copy inside the
user folder. A one-click fix was written up then and left for the owner to decide. The owner asked for it after the
fourth build.

## Decision

- **Fix this folder.** On Windows, Settings > Sandbox lists each folder the sandbox was refused, with a Fix this folder
  button. A confirmation says what happens first: Windows asks for an administrator's yes, then the person's account
  gets Full control of that folder and what is inside it. It also says the account that says yes may take ownership
  first, that nothing else changes, and that Remove marks does not take this back.
- **What runs.** `windows/grant.ts` builds two PowerShell scripts as pure functions:
  - The first runs as the person. It starts the second with `Start-Process -Verb RunAs` (the UAC prompt), waits for
    it, and ends with code 1223 when the person says no or closes the prompt.
  - The second runs elevated. It runs Windows' own `icacls <folder> /grant *<sid>:(OI)(CI)F`, with the person's SID
    from `whoami /user`. Only if Windows refuses that does it run `takeown /F <folder>` and add the entry again as the
    owner. The folder and the log file reach it as base64 inside a constant script, so no command line or shell
    quoting is involved. Every program is named by its full path under `System32`.
  - What icacls and takeown say goes to a log in the sandbox's folder. It is read back for a failure, then removed.
  - It does not walk the folder file by file (no `/T`). Windows passes the inherited entry down to what inherits.
- **Only what was refused.** The host fixes a folder only if the sandbox itself was refused it (`blocked`, by the
  folder's own name), and the Windows engine checks `tooBroad` again: never a whole drive, the user folder, the
  folders programs keep settings in, Windows' own folders, or eNCode's own. A share, a relative path, a name Windows
  does not allow, or one too long for a command line (over 1,024 characters) is refused before Windows is asked.
- **The answer is the sandbox's own.** After the grant the sandbox prepares the folder at once, as a command there
  would. The screen then says "Commands run in a sandbox", or why not if Windows still refuses. A no to Windows'
  prompt is a note ("Nothing changed"), not an error.
- **Tests.**
  - `grant.test.ts` checks the folders taken, the scripts (the folder never appears as text, a SID that is not one is
    refused, ownership only after a refused grant, no recursive or reset switches) and how each answer is read.
  - `grant.windows.test.ts` runs it on the Windows CI runner. It narrows a folder to Modify for the account, as on the
    tester's computer, and checks the sandbox is refused there. Then Fix this folder runs for real (the runner says yes
    without a prompt), the folder carries the entry, a confined command writes there, and the folder around it stays
    out of reach.

## Consequences

- In a folder like `D:\TEST SERVEr` the person fixes the sandbox with one click and one yes to Windows. Commands there
  run inside it from then on, without the cards 0110 described.
- The grant stays after Remove marks, and after eNCode is uninstalled. It gives the person's own account Full control
  of their own project folder, which is what Properties > Security would have done by hand.
- Where the yes comes from another administrator account, and Windows lets no administrator change the folder's
  permissions, that other account becomes the folder's owner. The note after the fix says so.
- A conversation that already ran commands outside the sandbox in that folder may go on asking to. A new
  conversation, or telling the agent the folder is fixed, ends that.
- The UAC prompt itself is not tested on CI, where an administrator's yes needs no prompt. Saying no is covered by the
  unit tests only.
