# 0104. A side chat is a copy of a chat to ask about it on the side: read-only, unlisted, and deleted when closed

- Status: Accepted, builds on 0015, 0030 and 0031
- Date: 2026-10-24

## Context

While the agent works, or after, a person often wants to ask something about the conversation ("why this way?",
"what is left?") without adding the question and its answer to the chat the agent carries on from. Codex has a side
chat for this. A fork (0031) copies a session, but it is listed, kept, and works in Code mode, so it is a second chat,
not a question on the side.

## Decision

A side chat is a session made by `host.side(sessionId)`: a fork of the chat as it stands, with `sideOf` in its header
naming the chat (a side chat of a side chat names the same chat). Its title is "Side chat", which is not the default,
so it is never named after its first message; its goal and plan are cleared.

- **Unlisted.** `SessionStore.list` leaves side chats out unless asked for them (`sides: true`), so the sidebar, the
  wake-ups and resets never see one.
- **Read-only.** The side tab always sends in Ask mode, which the tool registry enforces: it reads and searches, and
  changes nothing. On its first request the model is told it is a side chat: answer here, do not carry on with the
  work above, nothing goes back.
- **Its own tab.** It opens in a side panel tab (`kind: 'chat'`) from `/side [question]`, the Session menu, the
  header's menu or the palette. The tab shows only what is said in it (entries made after it was), its steps folded as
  in the thread, approval and question cards, and a small message box with stop. It is not saved with the tabs and not
  reopened.
- **Short-lived.** Closing the tab deletes the side chat. Deleting the chat deletes its side chats. One left open when
  eNCode closed is deleted when the agent host starts again.

## Consequences

- A question about the chat costs one copy of its records on disk while the tab is open, and a request with the whole
  conversation as context; the chat itself is untouched.
- A side chat runs while the chat runs: two requests may run at once, each in its own session.
- Its usage is counted while it exists and goes with it, like any deleted session's.
