# 0070. A problem is said in a sentence with what can be done, and what the provider said is folded under it

- Status: Accepted, builds on 0052 and 0068
- Date: 2026-10-23

## Context

The chat showed failures the way the code met them. The person saw a red line such as
`deepseek/deepseek-chat-v3:free: HTTP 429: {"error":{"message":"Rate limit exceeded: free-models-per-min",...}}`,
`TypeError: Cannot read properties of undefined (reading 'path')` or `EBUSY: resource busy or locked, open
'C:\Users\...'`. A toast or a Settings check did the same. Codex says what happened in a sentence, offers what can be
done next, and keeps the rest out of the way. The owner asked for exactly that: "no raw errors should throw in chat".

A provider's text cannot simply be shown. It is written for developers, it differs per provider and per day, it can
carry the key that was sent (some providers echo it back), and the person's user name sits in every path. Hiding it
completely is wrong too: a tester's report needs it, and a person who knows the provider learns most from its own words.

## Decision

- **A sentence from what eNCode knows, never from what it was told.** `failureSentence()` in @encode/providers makes
  one sentence from the kind of failure, the model and the provider ("openrouter did not accept the API key.",
  "qwen/coder is getting too many requests right now.", "deepseek/v3 cannot read PDFs."). The router builds every
  switch, wait and pause from it (`failureOf()`, `skipSentence()`), and so does a direct client. Its alerts (a refused
  key, credit, a daily limit, a model list that would not load, a refused model) carry a sentence as `message`, and the
  provider's words as `detail`. The connection check in Settings does the same, and so does the listing check in the
  main process, with the HTTP status as detail.
- **The provider's words go to `detail`, keys removed.** `redactSecrets()` takes out the keys in use and anything
  shaped like a key or a credential (sk-, GitHub, Slack, AWS and Google keys, JWTs, Bearer and Basic values, and
  `api_key=`, `authorization:`, `token=`, `secret=` or `password=` assignments). Details also have the home folder
  replaced by `~` and are cut at 4,000 characters.
- **A request that fails ends on a problem.** A conversation entry of kind `error` holds the sentence, a `problem`
  (a code, the actions it offers, when a retry may work, and whether it was resolved) and the `details`. The codes
  are the router's pause reasons (rate-limit, quota, payment, auth, network, unavailable, no-model, refused) and the
  session's own (context, empty, host, internal). Each code has fixed actions, the most useful first: rate-limit
  offers Retry and Switch model, auth offers Open Settings and Switch model, an internal fault offers Retry and Save
  diagnostics. A paused request says when it can be tried again ("You can try again at 14:05.").
- **The chat shows one card.** The card the conversation ends on has the sentence, its buttons and a Details fold with
  the text in the code font and a copy button. An older card, one already tried again, or a card while something runs
  keeps only its text and Details. A notice between steps (a model switched, a wait) is one line with its own Details.
  Errors that reach the window without an entry (the agent's process stopped) become the same card from the renderer.
- **Retry runs the same request on.** `session.retry()` runs the turn that did not finish again from where it
  stopped, with no new message from the person, and marks the problem resolved so its buttons go. It refuses when the
  last request finished or the session is busy. The desktop calls it through the host (`agent:retry`).
- **Thrown errors are worded too.** A system error is said in words with its path ("C:\a.txt is in use by another
  program"). A fault in eNCode's own code (TypeError, ReferenceError, RangeError, SyntaxError and the like) is one
  fixed sentence for the person ("Something went wrong inside eNCode, so that did not finish. Try again."). The whole
  account (class, code, the first 12 frames and the cause) goes to the details and the log. The model still gets a
  fault's own message in a tool result (`plainError()`), since it can act on it; only the person sees the fixed
  sentence (`shownError()`).
- **One filter in the window, enforced.** Every failure the interface shows goes through `errorText()`. It drops
  Electron's IPC wrapper, a class prefix and a stack, takes out key shapes and turns a fault into the fixed sentence,
  logging what it said. The main process words a failure before it crosses IPC and logs the whole of it. A test reads
  every renderer source and fails the build when one reads an error's `message` or `stack` itself, or makes text of a
  caught error.

## Consequences

- The chat, toasts and Settings speak the same plain language for every provider, and a tester's Diagnostics report
  still holds what the provider said.
- A new failure kind falls back to "M is not available right now." until it gets its own sentence; the router's test
  checks that every known kind and skip reason is one sentence that names the model or the provider and quotes nothing.
- Retry is honest only for problems that can pass: a refused key offers Open Settings, not Retry, because the provider
  stays blocked until a key changes (0052).
- Sentences name providers by their ids in the router; the desktop replaces ids with the person's profile names, as
  it already did for the rest of the router's text.
- Settings checks no longer show HTTP statuses in the sentence. The status is in the detail.
