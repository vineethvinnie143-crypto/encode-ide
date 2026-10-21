# 0022. Connect OpenRouter with PKCE on a loopback listener

- Status: Accepted
- Date: 2026-10-21

## Context

Users who want more than the free tier bring their own models, and for OpenRouter the easy
route is to approve eNCode on OpenRouter's page and receive an API key of their own, instead
of copying a key by hand. OpenRouter supports this with an authorization code and PKCE: the
page sends the browser back to a callback URL with a one-time code, and the app trades the
code and its verifier for the key.

A callback to the user's own machine means a listener on a local port, and a local port is
reachable by every process on the machine and by every web page the user opens. The key that
comes out is a paid credential ([0008](0008-api-keys-in-the-os-keychain-only.md)).

## Decision

- **PKCE with S256.** A 32-byte random verifier, and its SHA-256 challenge sent in the
  authorization URL. The code is useless to anyone without the verifier.
- **A one-time loopback listener** (`packages/accounts/src/loopback.ts`):
  - a random port on `127.0.0.1`, plus `::1` where available, and a callback URL on
    `localhost` as OpenRouter requires;
  - `state` is a random value, checked in constant time, so a page that guesses the port cannot
    inject its own code;
  - the `Host` header must name the listener, which defeats DNS rebinding;
  - only `GET /callback` is served, the first valid callback wins, and the listener closes
    soon after;
  - the browser is held on the callback until the exchange finishes, then redirected to a
    page that says connected or failed, so the page never claims a success that did not happen;
  - responses carry a strict CSP, `no-store` and `no-referrer`, and say nothing about the code.
- **A paste fallback.** Where a listener cannot start (a remote shell, a locked-down machine),
  `connectOpenRouterByCode` opens OpenRouter's page without a callback, which shows the code on
  screen for the user to paste back.
- **The key goes straight into the key vault.** The result is a value for the caller to hand to
  `KeyVault`. It is never written to settings or logs and never sent to the renderer. The
  exchange is made by the main process, redirects are refused, and responses are size-limited.
- **The gateway is not involved.** The key is the user's, billed to their OpenRouter account,
  and revocable there. The free-tier key and this flow never meet.

## Consequences

- Another process on the machine can connect to the listener during the minutes it is open, but
  without `state` it cannot get a code accepted, and without the verifier a stolen code is
  worthless. Same-user malware can read the keychain afterwards anyway (R5).
- The flow needs a browser on the same machine, or the paste fallback.
- OpenRouter owns the consent page. If it changes its endpoints, only
  `packages/accounts/src/openrouter.ts` changes.
