# 0078. Inlay hints and semantic tokens are kept by line beside the text, and follow edits until the server answers again

- Status: Accepted, builds on 0003, 0072, 0074 and 0077
- Date: 2026-10-23

## Context

A language server knows more about a file than the editor's lexer can: which name is a type, a parameter or a
deprecated function (semantic tokens), and the types it worked out and the parameter each argument goes to (inlay
hints). Both are drawn on every line on screen, so they must cost next to nothing as the person types and scrolls,
and both arrive late, for text that has often changed since. Five questions needed an answer.

- **What is asked, and when.** Hints for a whole large file are slow for a server to work out; tokens are cheap per
  line but come as one list for the file.
- **How a hint sits among the text without being text.** Every offset the editor counts (the caret, selections,
  search, copying) is an offset in the document; a hint must not shift any of them.
- **Where the caret goes beside a hint.** A type's hint belongs to the name before it, a parameter's to the argument
  after it.
- **What happens between an edit and the next answer.** Dropping everything on each keystroke makes colours and hints
  flicker; keeping them where they were draws them in the wrong place.
- **What the renderer may ask the servers**, and what of an answer from another program reaches the screen.

## Decision

### What is asked, and when

- **Hints for the lines on screen and a screen either side** (`textDocument/inlayHint` with that range), asked when a
  file is shown, 350 ms after typing pauses, 120 ms after scrolling stops once the lines on screen leave the ones
  asked for, and once a server that started late marks the file. Only while hints are on.
- **Semantic tokens for the whole file** (`textDocument/semanticTokens/full`, in the standard relative format), asked
  when a file is shown, 300 ms after typing pauses, and when the server marks the file while its last answer had no
  tokens (it was still loading the project). Only while semantic colours are on, and not for a file over 50,000 lines
  or 2,000,000 characters, which keeps the lexer's colours.
- An answer for text that has changed since it was asked is dropped and asked again; one for another file, or a
  newer question, is dropped.
- eNCode tells the servers it knows the standard token types and modifiers, wants whole-file requests, and keeps its
  own syntax colours (`augmentsSyntaxTokens`). The catalogue turns hints on where a server needs asking:
  TypeScript and JavaScript (parameter names for literals, the types of variables, properties, parameters and return
  values, and enum values; not where a name already says its type), gopls (hints and semantic tokens), and Lua.

### How a hint is drawn

- **A hint is an element with no text**: its label is an attribute drawn by the style sheet, so a line's text nodes
  still add up to the line's text and every offset counts as the document does. Copying, search and the caret never
  see it. It shows on a faint chip in a colour a step below comments.
- **The caret beside a hint**: at a type's hint (or one of no kind) the caret is drawn before it, with the name it
  follows; at a parameter's it is drawn after it, by the argument. A click on a hint puts the caret at its column.
- A line with hints is measured in the page, like a line with wide characters, and a hint after the last character
  counts toward the line's width. A line longer than 4,000 characters, which is drawn only in part, shows no hints;
  a line shows at most 50.

### What the colours are

- The host turns each token's type into one of the editor's own kinds (a class, struct, enum, interface, namespace
  or type parameter is a type; a parameter or variable a variable; a property or event a property; an enum member a
  constant; a function or method a function; a macro or decorator meta; and the plain ones, keyword, comment, string,
  number, regular expression and operator, themselves) and the deprecated modifier into a flag; types it does not
  know, including those a server makes up beyond the few it maps, are left to the lexer.
- The view draws a token's kind over the lexer's for its stretch of the line, then colours brackets by depth on top;
  a deprecated name is struck through. The pinned lines and the minimap use the same tokens.

### What happens between an edit and the next answer

- **Both are kept line by line, in columns**, and followed through each edit without mapping them one by one: an
  edit drops the tokens it reaches into, moves those after it on its own line by what it added, splits or joins
  lines as it does, and shifts the lines below it. The lines it did not reach keep their arrays, so they are not
  drawn again. A hint at the very place text is typed moves with the text after it. A property test checks the result
  against mapping each one's place through the edit.
- A new answer replaces them all; another file starts with none.

### What the renderer may ask

- **Two new questions**, rebuilt by the main process field by field: `semanticTokens` from a file of the folder alone,
  and `inlayHints` from a file of the folder and two whole line numbers at most 2,000 lines apart.
- **The host reads answers field by field**: a hint needs a place of two whole numbers and a label (a string, or the
  values of its parts joined) with control, bidi and zero-width characters made spaces, cut at 120 characters; at most
  2,000 are read. Tokens must be five whole numbers each, in order; reading stops where they stop making sense, and at
  most 100,000 are read. Kinds come from the legend the server declared, read once its capabilities are known.

## Consequences

- With a server that gives them, the editor colours names by meaning and shows the types and parameter names the
  person would otherwise hover for; without one nothing changes.
- Typing costs no more than before: a keystroke touches only the items of the lines it edits, and a line's colours
  are merged once per change of its tokens.
- A line being typed on keeps the lexer's colours for the stretch typed into until the server answers again.
- Not done: a hint's tooltip, clicking a part of a hint's label to go to a type, a server's own refresh requests (a
  server that marks the file stands in for them), and range or delta token requests.
