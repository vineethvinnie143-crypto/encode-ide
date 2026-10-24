# 0103. Browser tabs are pages in their own process, and each chat has an agent tab the Browser tool drives

- Status: Accepted, builds on 0007, 0010 and 0015
- Date: 2026-10-24

## Context

The Browser tab of the side panel (0015) was an `<iframe>` of the app window. A site that forbids framing does not
load in a frame, so the main process took X-Frame-Options and `frame-ancestors` off the responses of the window's
sub-frames (T29, R13). The frame shared the window's process and session, could not keep a sign-in apart from the
app, and offered nothing to drive: the agent could build a web page but not look at it. Codex opens the page it is
working on in a browser beside the thread and checks it there.

## Decision

### A tab is a `<webview>`

Each Browser tab is an Electron `<webview>`: a page in a renderer process of its own, with no access to the window's
page. The window enables `webviewTag`, and the main process decides what every tab gets in `will-attach-webview`,
whatever the page asked for (`electron/browser/guard.ts`):

- no preload, no Node, `sandbox`, `contextIsolation`, `webSecurity`, no plugins, no nested `<webview>`, no navigation
  by a dropped file;
- one of two kinds of session, by partition: `persist:encode-browser`, kept on disk and shared by the person's tabs,
  so a sign-in lasts; or `encode-agent-<16 hex>`, in memory, one per chat (rules.ts). Any other partition, or a first
  address that is not http, https or `about:blank`, and there is no tab;
- a plain user agent, without the Electron and eNCode tokens a site would read as an odd browser;
- no permission but full screen and writing the clipboard for the person's tabs, and none at all for an agent tab;
  device access is refused for both;
- a download in an agent tab is cancelled and told to the agent; the person's go where Chromium puts them.

Once attached, a tab's main frame loads only web pages. A new window a person's page opens becomes a new Browser tab.
The keys the app answers to in a browser (Ctrl+L, Ctrl+R, F5, Alt+Left and Right, Ctrl+plus, minus and 0, and in the
person's tabs Ctrl+W and Ctrl+T) are taken before the page sees them and sent to the tab's bar. The context menu has
copy, paste, open link in a new tab, back, forward, reload and Inspect.

The frame's header rewriting and its framing rules are gone: nothing is lifted from any response.

### The tab's bar

Back, forward, reload or stop, the address with a lock for https, zoom (kept per tab, reset from the bar), open in
the person's own browser, a progress line, and a page that says why a load failed with Try again. A person's tab
keeps its address and comes back on it after Reopen and a restart; its pages join the New tab page's recent ones. A
Browser tab behind another stays laid out (`is-kept`), so a page keeps its size and the agent can read it.

### The agent tab and the Browser tool

The Browser tool (`@encode/tools`) opens, looks, clicks, double-clicks, types, presses a key, scrolls, chooses an
option, goes back, forward, reloads, waits for text or a time, reads the console, and closes. Each answer is the page
as an outline: up to 150 elements with refs (`e12`), roles, names, values and states, preferring those near the view,
across shadow roots; the visible text, cut to 6,000 characters; console errors and warnings since the last answer; and,
for a model that reads images, a JPEG of the view in CSS pixels with the scale when the page is wider.

The request crosses from the agent host to the main process as plain data, checked field by field
(`parseBrowserRequest`). The main process keeps one agent tab per chat (agent-browser.ts): the first `open` asks the
window to show the chat's tab, marked Agent, and waits for it to attach; later steps go to it while it lives. The tab
is driven over the DevTools protocol of its own contents (`webContents.debugger`): real mouse events at the element's
centre after a hit test, `Input.insertText` for typing, key events, and scripts in an isolated world (7311) for the
outline and for actions by ref. A step waits for the page to settle; a page whose process crashed is loaded again and
the answer says so. Dialogs answer themselves (alert is dismissed, confirm is yes, prompt is empty) and the console
says what was asked.

Where the tab may go: addresses on this computer open without asking; any other host is a web access the approval
policy decides, by the same `WebFetch(domain:...)` rules. After that the tab follows a link or redirect on its own only
to this computer or a host the agent opened; anything else is held and the next answer says where the page wanted to
go. It never types into a password field and never reads one's value. The agent tab is not saved with the person's
tabs, not reopened, and its pages are not the person's recent ones. A subagent has no Browser tool.

## Consequences

- Sites that forbid framing load as they are, in a process of their own; the window's page and its bridge are out of
  their reach, and nothing in the app rewrites any response.
- The agent can check what it builds the way a person would, and the person sees each step in the tab.
- An agent tab is signed in to nothing and forgotten when eNCode closes; to test a signed-in flow the agent signs in
  in its own tab. The person's sign-ins are never the agent's.
- Electron's `<webview>` is on its long-term path rather than WebContentsView; moving later changes only the guard and
  the panel.
