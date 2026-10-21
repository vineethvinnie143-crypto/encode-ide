# 0031. A folder's settings grant only what the user approved

- Status: Accepted
- Date: 2026-10-21

## Context

Settings live in `~/.encode/settings.json` (the user's), `<root>/.encode/settings.json` and
`<root>/.encode/settings.local.json` (the folder's), and on the command line. The folder's
files come with the folder, so whoever wrote the folder wrote them. A cloned repository that
ships `allow: ["Bash(*)"]`, a hook, an environment variable or an MCP server would otherwise
grant itself authority the moment it is opened ([threat model](../security/threat-model.md), T1).

## Decision

- What a folder's settings restrict always applies: deny and ask rules, disabled MCP servers.
- What they grant applies only when the user has trusted the folder and approved its
  configuration as it is: allow rules, a default mode, extra directories, hooks,
  environment variables, MCP servers, sandbox settings. `grantingPart` names exactly these
  keys.
- Approval is by digest. `folderConfigDigest` hashes the granting parts of the project and
  local files (canonical JSON, sorted keys). Any change, from a pull or from the agent
  editing the file, turns the grants off until the user approves the new digest. Adding a
  deny rule does not, because restrictions are not part of the digest.
- Trust is per folder and not inherited: trusting `~/code` does not trust a repository cloned
  into it tomorrow. A home folder or a drive root draws a warning before it can be trusted.
- The trust store (`~/.encode/trust.json`) is written atomically, keyed by the real path
  (case-insensitive on Windows), and an unreadable store trusts nothing.
- A project's MCP servers are approved one at a time by the digest of their entry
  ([0034](0034-an-in-house-mcp-client-with-per-server-approval.md)).
- When the user saves a rule from the approval card into a folder's file, the new digest is
  approved with it only if the configuration was approved just before. Otherwise the rule is
  saved and reported as held back, so a click never approves unrelated changes.

## Consequences

- The core resolves settings with `folderApproved` taken from the trust store, and shows
  `heldBack` so the user can review what a folder asks for.
- Git runs unasked only in trusted folders (R3) once the core passes `trusted` to the
  assessor.
- The digest covers what a folder grants today. Keys the settings model does not know are
  kept for the features that read them and are not part of the digest, so a feature that
  starts reading a new key from a folder's files must add it to `grantingPart` first.
