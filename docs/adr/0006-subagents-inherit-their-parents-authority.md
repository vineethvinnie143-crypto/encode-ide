# 0006. Subagents inherit their parent's authority

- Status: Accepted
- Date: 2026-10-21

## Context

The `task` tool started every subagent in Code mode and dropped its events. That caused
three failures:

- From a Plan or Ask session, a subagent could edit files and run commands that the session
  itself could not.
- In Code mode, an approval the subagent needed went nowhere, so it waited forever.
- Stopping the session did not stop the subagent.

## Decision

- A subagent runs in its parent's mode, under the parent's approval policy and the same
  approved-sites list ([0007](0007-web-fetch-asks-per-site.md)).
- Its approvals and questions go through the parent. They appear on the parent's task card
  ("Subagent: Run command") and resolve like any other card.
- It is cancelled with the parent: Stop, or the parent's run ending.
- A failed subagent reports a failure, not an empty success. A plan it proposes in Plan mode
  comes back in its report.
- Stopping while an approval card is pending clears the card. A tool cut short by Stop shows
  as stopped.

## Consequences

- Delegation cannot escalate privileges. The smoke checks that a subagent started from Plan
  mode cannot write a file (it could without this change).
- Subagent definitions with narrower tools or their own models (M3) can only restrict this
  inherited authority, never widen it.
