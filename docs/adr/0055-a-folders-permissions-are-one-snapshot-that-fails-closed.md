# 0055. A folder's permissions are one snapshot that fails closed

- Status: Accepted
- Date: 2026-10-22

## Context

0040 and 0041 built the rules engine, the trust store and the settings loader as libraries; nothing in the app
used them. The app's approvals came from three fixed policies and a protected-folder list, so a person who said
"don't ask again about `npm test`" had no way to say it, and a cloned project could neither be trusted nor refused.

Wiring them in has three ways to go wrong that the libraries cannot prevent:

- **A read that fails is read as "no settings".** A deny rule that cannot be read must not become a default that
  allows what it denied. The failure may be a half-written file, a sharing violation on Windows, or a typo.
- **Two pictures of the same folder.** The approval card, the Permissions screen and the assessor each reading
  the files on their own will disagree for the moment between two reads, and a person will read one while the
  agent acts on the other.
- **A rule that is saved is not a rule that applies.** A project's grants wait for trust and for approval of the
  folder's settings as they are (0041). A button that says "Always allow" and then asks again anyway looks broken,
  and one that applies a grant the person never read is worse.

## Decision

- **One snapshot per folder: `WorkspaceConfig` (`@encode/workspace`).** It holds the resolved settings, the trust
  state, the digest that was approved, the rule set, and the shell assessor and file/web/MCP judge built from
  them. Everything that decides or shows anything reads the same snapshot. It is rebuilt when the text of a
  watched file (user, project, local settings; `.mcp.json`) is different from the text it was built from, or
  after a read that failed, and never for a change that is only a timestamp.
- **A snapshot that cannot be trusted is `broken`, and a broken snapshot refuses everything.** A settings file
  that exists but cannot be read, or is not valid, and a deny or ask entry that cannot be understood, make the
  folder broken: the session's scope refuses every tool with the reason, the Permissions screen and the banner
  above the composer say what is wrong and where, and nothing falls back to defaults. A read is retried a few
  times first, because the common cause is another program holding the file for a moment. A missing file is not
  broken: nothing was said.
- **Rules decide before modes do.** deny, then ask, then allow. A deny refuses under every approval policy, Full
  access included. A rule that asks cannot be turned into "Always allow" from the card it caused, and an allow rule
  lets a command run unasked in Workspace Write and Auto review; in Read Only a command still runs only if it is
  proven read-only, since a rule says the person wants it to run, not that it changes nothing. Protected folders
  still always ask.
- **The card finishes before the rule is saved.** "Always allow" answers the approval first and saves afterwards,
  and says what happened in a notice: saved and applying, saved and waiting for trust or review, or why it could
  not be saved. The default place is the person's private project settings, the narrowest. The card shows the
  exact rules it will write, one per line, and offers to trust the folder with the rule only when the folder
  has no settings of its own that grant anything; a folder that does is never trusted on the way.
- **What a folder takes away applies at once; what it grants waits.** Deny and ask rules in any settings file
  apply immediately, in a folder that is not trusted too. Allow rules, environment variables, extra folders and
  hooks apply only in a trusted folder whose settings, as they are now, were approved. The approval is of the
  folder's settings as a whole (the digest of every file in it), so a rule saved to the private file waits with a
  project file that changed after it, and the screen says so.
- **The screen is the only way to change trust.** Trust, approve, revoke, add a rule and remove a rule are
  actions of one IPC handler that accepts only the app's top frame and checks the action's shape. Trusting a
  home folder or a drive root needs a second, explicit confirmation. An agent has no tool that changes any of
  this. What it writes into `.encode/` asks (except under Full access) and, being a change to the folder's
  settings, waits for the person's approval whatever the policy.

## Consequences

- A settings file that is broken stops the work in that folder until it is fixed. That is a stop the person can
  see and fix from the screen; the alternative is a silent loss of a protection.
- The snapshot's rebuild check reads a handful of small files before a decision. That is a few milliseconds
  and is the price of never deciding on a stale picture.
- Per-file approval (so that a pull does not hold up the person's private rules) would be friendlier and is
  deliberately not done: it would let a project file and a local file be approved apart, and a project can
  write the local file too.
- Hooks, checkpoints and the MCP client are still libraries (`docs/m3-integration.md`); they hang off the same
  snapshot when they are wired.
