# 0113. Pictures and files go with a message: pasted, dropped or picked

- Status: Accepted, builds on 0054, 0069 and 0111
- Date: 2026-10-24

## Context

A tester could not paste a screenshot into the chat box, nor attach a file from the computer. The box attached only
the file open in the editor, or a project file by `@`, both as text. The providers already carried images (the
Computer tool's screenshots, Read on a picture), and Read already read PDFs, but nothing let the person hand eNCode a
picture of what they saw.

## Decision

- **Three ways in, one list.** In the chat box: paste (Ctrl+V; a screenshot on the clipboard is attached, text on it is
  pasted as text, so a table copied from a spreadsheet stays words), drop files on the box (it says what a drop does
  while they are over it), or **+ → Pictures or files from this PC…**, a file picker. What is attached shows above the
  words: a picture as a thumbnail, a PDF or a text file by name, each with an ×. A pasted screenshot is called
  "Screenshot 1.png" and so on.
- **What can go.** Pictures (PNG, JPEG, GIF, WebP, and BMP drawn again as PNG), PDFs up to 10 MB, and text files up to
  1 MB (told by their bytes: UTF-8 without NUL bytes, whatever the extension). Ten pictures and PDFs a message.
  Anything else is named in one note ("Not attached: setup.exe is not a picture, a PDF or a text file.").
- **Pictures are made smaller in the app, before they travel.** No side longer than 1,568 pixels, what a model reads
  anyway; a picture already that small and light goes as it is, else it is drawn again as PNG so that text stays
  sharp, or JPEG when the PNG is still over 3.5 MB. A 240-pixel JPEG thumbnail goes along for the message's own view.
- **What the model reads.** The person's words come last, after what came with them: the files and the PDFs as text
  in `<attached_files>` (a PDF as Read gives its text to a model that does not read PDFs, with what the text leaves out
  said, at most 20 pages), then each picture as an image after `<attached_picture name="…" />`. A text file over
  20,000 characters is cut there, saying so. Names are kept to one plain line.
- **A model that cannot see pictures.** A request whose conversation holds pictures goes to a model of the role that
  reads images while one is ready (the router's budget takes `images`, as `complete` already chose). When none is, the
  model is sent a note in the place of each picture ("A picture is here, but the model in use cannot see pictures."),
  and the person is told once, in the chat, which model could not see them and that a model that reads images can be
  chosen in Settings. A Read of a picture by such a model now goes the same way, where before the request found no
  model at all.
- **The message shows what came with it**: the pictures' thumbnails and the files' names, above the bubble. The full
  picture stays in the session's log, as Read's do.
- **While the agent works**, a message with pictures or files waits in the queue (a running request reads words only)
  and keeps them; editing it gives them back to the box.
- **Checked at the boundary.** The agent host's schema takes at most ten, base64 only, of the five types, and a
  thumbnail only as a `data:image/jpeg` URL. Nothing new reads a path: the app reads only what the person pasted,
  dropped or picked, so no new channel reads files by name. A folder on another machine (0111) gets them over its
  connection like any request.

## Consequences

- A screenshot of an error is one paste away, and the free models that cannot see pictures say so instead of failing.
- Pictures make a session's log larger, about a megabyte each at most; compaction drops old images as before.
- Not yet: side chats take words only; a picture cannot be opened full size from the message; a PDF goes as text, not
  as pages a model that reads PDFs could see (Read still does that for a PDF in the project).

## Verification

- `attachments.test.ts`: what is a picture, a PDF or text; NUL and non-UTF-8 bytes; the size a picture is drawn at;
  names; what goes as files and what as media.
- `session.test.ts`: pictures as images before the words, a PDF as its text, a long file cut and said; a model that
  cannot see pictures gets the note, and the person is told once for each new picture.
- `router.test.ts`: the budget names a model that sees pictures while one is ready, else the best one.
- `screens.test.ts`, `host-api.test.ts`, `chat.test.ts`: the notes in place of images; the schema's refusals; a queued
  message keeps its pictures.
- The end-to-end `attach` part: a 2400 × 1350 screenshot pasted becomes "Screenshot 1.png, 1568 × 882"; a PDF and a Lua
  file dropped join it and an .exe is refused in one note; the sent message shows a thumbnail and both names; the mock
  model, which cannot see pictures, is sent the note, the PDF's text and the file, and no image.
