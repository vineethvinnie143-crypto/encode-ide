# @encode/accounts

The app's side of eNCode accounts, for Node (the desktop main process and the CLI):

- **GitHub sign-in through the free-tier gateway.** The app shows a code, the user approves it on
  GitHub, and the app never sees a GitHub token ([ADR 0021](../../docs/adr/0021-sessions-are-rotating-device-bound-refresh-tokens.md)).
- **A session that keeps itself alive.** `accessToken()` hands the model router a bearer token
  that is always good for at least two minutes, refreshing it first when it is not.
- **Connect OpenRouter.** The user approves eNCode on OpenRouter's page and gets an API key of
  their own, with PKCE on a one-time loopback listener, or by pasting a code
  ([ADR 0022](../../docs/adr/0022-connect-openrouter-with-pkce-on-a-loopback-listener.md)).

It has no UI and no Electron dependency, and it needs only `@encode/gateway-protocol`. The
gateway it talks to is `apps/gateway`, and the wire format is in
[docs/gateway-protocol.md](../../docs/gateway-protocol.md).

## Setting it up

```ts
import { Accounts } from '@encode/accounts'

const accounts = new Accounts({
  gatewayUrl: 'https://<the deployed gateway>',   // https; http only on loopback, for development
  store,                                          // a SecretStore, see below
  client: { app: 'desktop', version: app.getVersion() },
})
await accounts.restore()
accounts.onChange((state) => send(state))         // safe to forward to the renderer: it holds no token
```

`state` is one of `loading`, `signed_out` (with `ended` when the gateway ended the session),
`signing_in` (the code and link to show) or `signed_in` (the account, and whether it was
`persisted`). Call `accounts.idle()` before the app quits so a replaced session is ended on the
gateway, and `accounts.dispose()` to drop listeners and cancel a sign-in.

### The secret store

`store` is where the session and the device id live between launches:

```ts
interface SecretStore {
  get(name: string): Promise<string | undefined>
  set(name: string, value: string): Promise<void>
  delete(name: string): Promise<void>
}
```

Back it with the key vault ([ADR 0008](../../docs/adr/0008-api-keys-in-the-os-keychain-only.md)),
so the values are sealed by the OS keychain. Never use a settings file, a log or anything the
renderer can read: a refresh token is as good as a password for the free tier until it rotates.

- `set` must **throw** when the value could not be stored durably, for example when no keychain is
  usable. `Accounts` then keeps the session in memory for this run and reports
  `persisted: false`, so the UI can say that the user must sign in again after a restart.
- Values are opaque text of a few hundred bytes. The names are in `StoreKeys`
  (`accounts.session`, `accounts.device-id`).
- `MemorySecretStore` forgets everything at exit. Tests use it, and so can a headless run with no keychain.

## Signing in

```ts
const flow = await accounts.beginSignIn()
show(flow.userCode, flow.verificationUri)    // the link is always https on github.com
openInBrowser(flow.verificationUri)
try {
  const account = await flow.result          // { id, login, avatar_url? }
} catch (error) {
  // denied, expired, cancelled, refused, network, ...: see the table below
}
// flow.cancel() or the signal passed to beginSignIn() stops it
```

Only one sign-in runs at a time: starting another cancels the first. A poll that fails eight
times in a row ends the sign-in instead of spinning until the code expires.

`accounts.me()` returns the account and today's quota for the account menu. `accounts.status()`
needs no sign-in and says whether the free tier is available and what the data policy is. Show
the policy before the first free request.

`accounts.signOut()` removes the saved session first and then tells the gateway on a short
deadline, so it signs the user out even when offline.

## Using the token (the router's contract)

```ts
let token = await accounts.accessToken({ signal })
let response = await send(token)
if (response.status === 401) {
  token = await accounts.accessToken({ rejected: token, signal })   // never the same token again
  response = await send(token)
}
```

- Any number of callers can ask at once. The refresh is **single-flight**, so one request
  serves them all, and one caller's `signal` stops that caller waiting without stopping the
  refresh for the others.
- The new session is **stored before its token is used**, because the old refresh token is spent
  the moment the gateway answers.
- If another process that shares the store (the CLI beside the desktop app) refreshed first, this
  one adopts its session instead of replaying a spent token, and retries once on `invalid_grant`.
- A gateway that is unreachable never signs anyone out: `network`, `unavailable` and
  `rate_limited` keep the session, and the next call tries again.

Send the gateway's own errors to the router's next-tier logic with `errorAction()` from
`@encode/gateway-protocol`. The mapping for sign-in and refresh is below.

### Errors

Everything thrown is an `AccountsError`. Its message is written for the user and never contains a
token. `gatewayCode` carries the gateway's code when there was one, and `retryAfterMs` says when to try again.

| Code | Means | The app should |
| --- | --- | --- |
| `signed_out` | There is no session | Offer sign-in, or use the next tier |
| `session_ended` | The gateway ended the session, or it expired. The saved copy is already gone. | Say so and offer sign-in |
| `denied`, `expired`, `cancelled` | The user declined, ran out of time, or the caller cancelled | Return to the sign-in screen |
| `refused` | The gateway will not serve this account: invite-only, too new, suspended, or sign-in switched off (`gatewayCode` says which) | Show the message. It already ends with "Your own keys still work." |
| `rate_limited` | Too many requests | Wait `retryAfterMs` |
| `unavailable`, `network`, `timeout` | The gateway failed, could not be reached, or did not answer in time | Keep the session, use the next tier now, try again later |
| `client_outdated` | This build is too old for the gateway | Ask the user to update |
| `invalid_response` | Not an eNCode gateway, or another protocol version | Check the gateway address |
| `listen_failed`, `exchange_failed` | Connect OpenRouter could not start its listener, or OpenRouter refused the code | Offer the paste-a-code route, or start again |

## Connect OpenRouter

```ts
import { connectOpenRouter, connectOpenRouterByCode } from '@encode/accounts'

const connection = await connectOpenRouter()
openInBrowser(connection.url)
const { key } = await connection.result      // rejects: cancelled, timeout, exchange_failed, ...
keyVault.put(profileId, key)                  // straight into the key vault; never into settings or the renderer
```

The listener binds a random port on `127.0.0.1` (and `::1` where there is one), serves a single
`GET /callback` and closes. It checks `state` in constant time and the `Host` header, accepts the
first valid callback only, and holds the browser's request until the key has been exchanged, so
the page the user lands on says connected or failed truthfully. `connection.cancel()` stops it.
The user's key is billed to their own OpenRouter account and can be revoked there.

Where a listener cannot start (a remote shell, a locked-down machine), use the code route:

```ts
const connection = connectOpenRouterByCode()
openInBrowser(connection.url)                 // OpenRouter shows a code to copy
const { key } = await connection.submit(pasted)
```

None of this touches the gateway, and eNCode's free-tier key never leaves it.

## Hardening

Everything the gateway or OpenRouter sends is treated as hostile input:

- the gateway address must be `https` (or loopback `http`) with no credentials, query or fragment,
  and redirects are refused, so a token is never sent anywhere else;
- responses are size-capped, and tokens are checked for shape before they are stored or sent;
- the verification link must be `https` on an allowed host (`github.com` by default);
- messages shown to the user lose control and bidirectional characters and are length-capped;
- the saved session is parsed strictly, and anything unreadable counts as signed out.

## Tests

```bash
pnpm test packages/accounts         # this package
pnpm test accounts-client           # the real client against the real gateway core, in process
pnpm --filter @encode/accounts typecheck
```

Unit tests cover sign-in, the session lifecycle (single-flight refresh, lost answers, replay,
suspension, sign-out elsewhere), the saved-session parser, the HTTP hardening, PKCE and the loopback
listener's refusals. `apps/gateway/src/core/accounts-client.test.ts` holds this package to the
gateway's real behavior.
