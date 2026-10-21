# 0021. Sessions are short-lived tokens with rotating, device-bound refresh tokens

- Status: Accepted
- Date: 2026-10-21

## Context

The gateway has to know which account a request belongs to, because quotas bind to accounts.
The app runs on machines we do not control, so anything it stores can be copied: from disk,
from a backup, from a process dump, by another local user. Three things shape the design:

- The app must not hold a GitHub token, a password or a client secret. A desktop app cannot
  keep a client secret, and a GitHub token would give a thief the user's repositories.
- Several processes can share one session (the desktop app and the CLI), and a refresh
  response can be lost in transit. Neither may sign the user out.
- A stolen credential should expire quickly, and stealing a refresh token should be noticed.

## Decision

- **GitHub's device flow, run by the gateway.** The app shows a user code and opens
  `github.com/login/device`. The gateway polls GitHub, reads the user's id and login with the
  token it gets back, drops the token, and issues eNCode's own session. It asks GitHub for no
  scopes. There is no client secret, no redirect and no GitHub token on the user's machine.
- **Access tokens are stateless and last an hour.** The format is `ea1.<claims>.<tag>`, an
  HMAC-SHA256 over the claims (account, session, issued, expires) under a key derived from
  `GATEWAY_SECRET`. `GATEWAY_SECRET_PREVIOUS` still verifies old tokens while the secret is
  rotated. Quotas bind to the account, so a stolen access token gives one hour of the owner's
  own limits and nothing more.
- **Refresh tokens are single use.** They are 256 random bits (`er1_…`) and only their SHA-256
  is stored. Each refresh returns a whole new session. They expire after 30 days unused and
  180 days at most.
- **Device binding.** The app makes a random device id once and keeps it in the keychain next
  to the session. D1 stores its hash with the session. A refresh from another device id ends
  the session, so a copied refresh token alone is not enough.
- **Reuse detection with a grace window.** The previous refresh token is honored once more for
  120 seconds, so a lost response is retried instead of signing the user out. A spent token
  presented after that means a copy exists. The session ends on every device, and the next
  refresh fails with `invalid_grant`.
- **Revocation is immediate.** Sign-out, suspension and reuse mark the session revoked in D1
  and in the account's Durable Object, which the chat path checks for as long as an access
  token could still be valid.
- **The client keeps the rules** (`@encode/accounts`):
  - one refresh in flight however many callers ask (single-flight);
  - the new session is stored before its token is used, because the old refresh token is spent
    the moment the gateway answers;
  - a process adopts a newer session another process stored, and retries once on
    `invalid_grant` before concluding that the session has ended;
  - tokens live only in a `SecretStore` backed by the OS keychain
    ([0008](0008-api-keys-in-the-os-keychain-only.md)), never in settings, logs or the renderer.

## Consequences

- A thief who copies the saved session can act as the user for at most the life of the access
  token, one hour. A refresh without the device id ends the session. A thief who also copied
  the device id gets one refresh, after which the app's next refresh presents a spent token
  and ends the session everywhere. Same-user malware can read the keychain, as with API keys
  (R5 in the threat model).
- The gateway keeps one D1 row per session. Rows are pruned 30 days after they end.
- GitHub limits device-flow submissions per OAuth app per hour. At personal scale this does not
  matter, and a public release should add a loopback web flow before it does.
- Rotating `GATEWAY_SECRET` ends nobody's session: refresh tokens do not depend on it. Access
  tokens signed with the old secret work until `GATEWAY_SECRET_PREVIOUS` is removed.
- Offline use does not sign anyone out: an unreachable gateway is `network` or `unavailable`,
  never `session_ended`.
