# 0052. Every model call goes through the router, and keys are asked for by origin

- Status: Accepted
- Date: 2026-10-22

## Context

The owner will use the free models with one key, a paid key beside it, and a model of his own on his computer, and
three friends will test the same build. Each of them must be able to give any role (writing, exploring, planning,
reviewing, compaction, small tasks) any model from any connection, and none of them may be billed for a call they
did not choose. The router (`@encode/router`) already knows how to do that: it ranks models, fails over, learns what
a provider refuses, and counts the free tier. The desktop still called one profile's model directly.

Three things were in the way. The agent host is a separate process, and a key that is part of its configuration is a
key in a place the interface cannot take back. Two connections can serve the same model at different prices, so
"fail over to the next one" can mean "charge a different account". And a person who has never seen the app has to get
from nothing to a model that works without reading anything.

## Decision

- **A connection is a profile, a job is a role.** A profile is an address and a key. A role is an ordered list of
  references: `<profile id>:<model id>` (the model id may hold colons) or `@free`. The roles are main, explore,
  planner, reviewer, summarizer and utility; a role without a list follows another (explore, planner and reviewer
  follow main, summarizer follows utility, utility follows main). Settings that predate roles keep working: with no
  main list, the active profile's model is the main model. `shared/models.ts` holds these rules for the interface,
  the main process and the tests.
- **The host builds the router from settings and nothing else.** `routerSettingsOf` turns profiles into the router's
  providers (`p-<id>`, typed by address, a server on this machine free and keyless unless a key was given) and roles
  into its lists; the offline demo stays the host's own client. It is a pure function, so a test reads what the router
  will be told for any settings.
- **Keys are asked for at every use, by origin.** The host's configuration carries, for each provider, a key
  revision number and never a key. When the router needs one the host asks the main process for the profile's key and
  names the origin it is about to call; the main process answers only if that is the origin of the profile's address.
  A new key, or a changed address (which drops the stored key), changes the revision, and the host tells the router
  (`keysChanged`), which lifts what a refused key or a payment problem set.
- **A key goes only where the router would send it.** An address is `https://`, or `http://` for a server on this computer,
  with no user name, password, query or fragment. The dialog says so beside the field, the model list request refuses
  anything else before it carries a key, and the router drops a connection with such an address.
- **Free only is a switch with one safe default.** `freeOnly` is on until the person chooses a model that costs
  money, and choosing one asks first and turns it off. `@free` is served by one OpenRouter connection (the one named,
  else the first with a key); with none it is dropped from every list, so it can never fall to another key. A billed
  call never fails over to another key's account or from a free model to a paid one (the router's rule, 0023, 0024);
  the interface only shows what it decided.
- **A connection is tried before it is chosen.** *Connect a model* stores the connection and its key first, then
  tries it: OpenRouter's `/key` (its catalog is public, so a wrong key would pass a listing), the provider's own
  model list for the rest. A model of one's own is then asked for a tool call, the way the agent will use it, because
  a model that cannot call tools cannot drive the agent. A failure is shown in words with a way past it ("Use it
  anyway", "Keep this model"); closing the dialog goes back a step, and on a first start it never closes by a stray
  click.
- **Problems are told where the person is.** The router's alerts (refused key, sign-in, payment, billed, quota, model
  refused, catalog) arrive in the interface as one notice each (the same one is not shown twice in a minute), with a
  button to the Settings tab that helps. Settings → Roles shows each connection's state: models and free ones, free
  requests left today, what is paused and until when, and *Check again*.
- **What the router learns is kept, privately.** Health, cooldowns, free-request tallies and learned prices are
  written to `eNCode-models.json` in the user data folder (owner-only mode) every 30 seconds and at shutdown, and read
  back at the next start. It holds no prompts and no keys.

## Consequences

- The agent, the title and compaction calls and the connection test all use the same path, so a refusal looks the same
  everywhere and is explained once.
- A key is in the main process and, for the length of one request, in the host. A compromised host can ask for a key,
  but only for the origin the profile points at.
- The free models need an OpenRouter key of the person's own until the gateway (0020) is deployed. The dialog and the
  Roles tab say that free models can be slower and that their providers may keep and learn from prompts (R16).
- `freeOnly` on a first start means a model chosen from the menu that costs money asks once. That is a click the
  owner may find tedious; the alternative is a bill nobody expected.
- A connection that does not list its models (some OpenAI-compatible servers) is still usable: the model id can be
  typed, and the check does not need the list.
- The gateway's error table (`packages/providers/src/errors.ts`) is not yet derived from the router's `errorAction`,
  so a gateway refusal is explained by the generic path until that follows.
