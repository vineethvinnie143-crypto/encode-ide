# 0069. The agent asks before planning, hooks hear what it waits for, notebooks change by cell, and PDFs are read by eNCode's own reader

- Status: Accepted, builds on 0031, 0042, 0059, 0062 and 0066
- Date: 2026-10-23

## Context

Five things Claude Code's agent has were missing, and each has a trap:

- **EnterPlanMode.** A model that sees work worth agreeing on first should be able to say so. But plan mode only
  holds the agent back, so letting the model switch on its own is safe, and letting it switch without the person
  knowing is not: the person reads "it stopped doing anything" as a fault.
- **Notification, SessionEnd and SubagentStart hooks.** Scripts people already wrote for Claude Code expect these
  names, fields and reasons. They run the person's commands at moments the person may not be looking (a minute after
  a turn, on quit), so a slow or failing script must not hold eNCode up or break a session.
- **NotebookEdit.** A notebook is JSON. Edit on it works on escaped strings, corrupts outputs and breaks the file's
  layout; a rewrite of the whole file shows a diff of everything and loses the writer's key order and indentation.
- **PDF reading.** Specifications, papers and invoices come as PDFs. Read refused them. Outside libraries are out
  (own code only, 0001), and a PDF is hostile input: compressed streams that expand to gigabytes, cross-reference
  tables that point anywhere, encryption, deep nesting, fonts that map to nothing.
- **Pages to see, at a price.** A model that reads PDFs natively (Claude, GPT-4o and later, OpenRouter models that
  take files) sees figures, charts and scans; it also pays about 1,500 to 3,000 tokens a page for the image of each
  page. Most pages are only text. Sending every page natively, as Claude Code does, spends tokens on pages whose text
  says everything; sending only text loses the figures.

## Decision

- **EnterPlanMode asks, in its own words.** The tool runs only in code mode. Under Workspace Write and stricter the
  person gets a card, "Plan before changing anything", with Plan first, Plan first whenever it asks (a session grant),
  Go ahead without a plan and Say how to go ahead; a note given with the refusal reaches the model ("They said: ...").
  Full access and Auto review ask nothing, since plan mode only holds the agent back. The tool's result tells the
  model; the next request carries no extra plan-mode reminder.
- **The three hooks only look.** They take Claude Code's names and fields: Notification gets `notification_type`
  (`permission_prompt`, `idle_prompt`, and eNCode's `question` and `plan_review`), `title` and `message`; SessionEnd
  gets Claude Code's `reason` (`clear`, `prompt_input_exit`, `other`) and eNCode's own in `encode_reason`; SubagentStart
  gets `agent_type`. Each matches on those values. A hook's exit 2 is a message shown to the person; nothing it does
  stops the event. A SubagentStart hook's output is context put before the subagent's task. The idle notice comes a
  minute after a turn ends with nobody answering, never after a stop. SessionEnd is owed only by a session that started
  in this process, and waits at most 5 s on quit and 15 s otherwise.
- **NotebookEdit changes one cell and nothing else.** It replaces, inserts or deletes a cell found by id, index or
  `cell-N`, splicing into the file's own bytes: line endings, indentation, key order, string or array sources and
  ASCII escaping stay as the writer left them, and a change outside the cell is a bug. Replacing a code cell clears
  its outputs and execution count, since they came from the old code. New cells get ids when the format has them.
  Read shows a notebook cell by cell (offset is the first cell, limit counts cells); Edit and MultiEdit refuse a
  notebook and point at NotebookEdit.
- **PDFs are read by eNCode's own reader** (packages/tools/src/pdf), written to ISO 32000:
  - The file's structure: cross-reference tables and streams, object streams, PNG and TIFF predictors, and when the
    table is missing or wrong, the objects found by scanning the file, as viewers do; the person is told.
  - Filters: Flate, LZW, ASCIIHex, ASCII85 and RunLength. Image-only filters are never decoded.
  - Encryption with an empty user password (RC4 40 and 128 bit, AES-128, AES-256 R5 and R6), which is most "protected"
    PDFs: anyone may open them, and the encryption only carries the author's restrictions. A file that needs a password
    is refused with that reason.
  - Text: ToUnicode maps first, then Unicode and legacy CJK CMaps, then encodings and glyph names (ligatures, Greek,
    Cyrillic, TeX names, uniXXXX), with ActualText in place of what is drawn. Glyphs are placed by running the content
    stream (forms included, inline images skipped) and joined into lines by where they land: a gap becomes a space, a
    wide gap three, a drop larger than the lines around it a paragraph. Content order is kept, which keeps columns
    apart; a page drawn out of order is read top to bottom. Text turned sideways comes after the page. Indentation drawn
    by position is kept, so code in a PDF keeps its shape.
  - Limits on everything: 48 MB per stream and 256 MB per read decoded, 2,000,000 operators a page, nesting 64 deep,
    forms 10 deep with no cycles, 20 s per read with a yield to the event loop every 40 ms, and Read gives at most 20
    pages and 30,000 characters a call.
- **Read gives pages, an outline and notes.** `pages` takes "3", "1-5", "1,3,5-7" or "10-". A first read shows the
  title and the outline with page numbers, then each page in a `<page number="N">` block, and says which pages are left
  and how to ask for them. Notes say when pages have figures the text leaves out, are scans, were read only in part,
  lack characters a font does not map, or came from a damaged file.
- **Only the pages with something to see go natively.** A page counts when an image covers 8% of it, images together
  cover 30%, or it paints 150 paths (a chart, a diagram, a ruled table). When the model that answered last reads PDFs,
  Read attaches up to 10 such pages as a new PDF of just those pages (unencrypted, links and metadata left behind, at
  most 10 MB) in a document block, and the text of every page stays text. The block carries a short text of its own.
- **Every model gets what it can read.** The Anthropic adapter puts the document inside the tool result; the
  chat-completions adapter sends it as a `file` part in the user message after the tool messages, as it does images.
  A model whose capabilities do not include documents gets the block's text instead, so a document in history never
  breaks a switch of model. The capability comes from the model tables (Claude; GPT-4o, 4.1, 5 and o-series), from
  OpenRouter's catalog (`file` input) or a model's settings; a provider that says it cannot take a PDF teaches the
  router so, and the same model is asked once more with the text.
- **Documents are sent, not stored.** The session log keeps each document's text, like screenshots (screens.ts), and
  compaction replaces an old one with its text. The context estimate counts 1,800 tokens a page.

## Consequences

- PDFs work for every model, and the ones that read PDFs see figures and scans while paying for images only on pages
  that have them.
- A damaged or unusual PDF reads as it does in a viewer more often than not; a PDF eNCode cannot read says why.
- The reader is eNCode's code to keep: new font kinds, vertical writing (read top to bottom without its own layout
  yet) and Type 3 fonts drawn without names are where text can still go missing, and the note on missing characters
  says so. There is no OCR: a scan without a text layer is readable only by a model that reads PDFs.
- Hooks written for Claude Code's Notification, SessionEnd and SubagentStart run unchanged.
- The tool list grew by about 1,300 characters (NotebookEdit, EnterPlanMode, Read's `pages`); the request ceiling of
  0062 still holds, with less room.
