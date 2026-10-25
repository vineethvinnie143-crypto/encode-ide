# 0133. A command's output reaches the model as a digest of what it is

- Status: Accepted, builds on 0093 and 0132
- Date: 2026-10-25

## Context

0130 shortens old outputs, but every output goes in whole first and is paid for whole on every step until it is
shortened. A test run is the costliest kind: its passing tests carry nothing the model acts on, and the failures it
needs are often in the middle, where the start-and-end excerpt of a long output (0093) does not show them. A build's
warnings, an install's download lines, git log's message bodies and the path printed on every line of a search are the
same: the model pays for them each step and seldom reads them.

## Decision

- **A digest by kind** (`packages/tools/src/shell/digest.ts`). Bash works one out once a command ends by itself. The
  model reads the digest, with a note that says what it left out and where the whole output is kept (0093). The person
  sees the whole, as before.
  - **Tests**, known by their summary line, whatever command started them: node --test (TAP and spec), jest, vitest,
    mocha, pytest, go test, cargo test, unittest, dotnet test, playwright and gradle. A passing test's lines are left
    out, and so is the header of a suite or test that passed. What is left is each failure with its error, expected
    and actual values and location, the first 5 frames of its stack, the totals, and every line the digest does not
    recognize. Each run of left-out lines is marked with how many passing tests it held.
  - **Builds and type checks**, known by their command (tsc, cargo build, go build, dotnet build, make, gradle and
    others): every error with up to 12 lines after it, the first 10 warnings, the last 8 lines, and the name of the
    file a diagnostic is in when it is on a line of its own. Linters are not builds, since their warnings are what
    they are run for.
  - **Installs**, known by their command: every error, the first 5 warnings and the last 10 lines.
  - **git log** in its default form, run on its own: one line a commit, with hash, refs, date, author and subject.
    Emails are left out. A log with patches is left as it is.
  - **git diff and git show**, run on their own and only past 25,000 characters, when 0093 would otherwise show the
    start and end: each file's added and removed counts first, then the whole diffs that fit in about the same size,
    in git's order. The table marks which are shown.
- **When there is no digest:**
  - a command that pipes its output on, or shows or filters a file (cat, head, grep, Get-Content);
  - an output under 3,000 characters (2,000 for an install, 4,000 for git log);
  - a failed command under 8,000 characters;
  - a failed build or install in which no error can be told apart;
  - a digest that is more than half of the output;
  - and anything that timed out or was stopped.
- **The loop** (`execute`) sends the digest only when it can keep the whole in the session's outputs folder, and the
  digest is under 25,000 characters. Otherwise the output goes as before.
- **Back-off.** The session's watch (0132) counts each digest and each time the model reads a digest's whole output: a
  Read, Grep or command naming its file, once for each output. After three such reads in a session, its commands'
  outputs go in whole. Save diagnostics adds "N command outputs went in as a digest, M read back whole" to "Context,
  last 7 days".
- **Progress lines.** A run of four or more lines that differ only in their numbers is collapsed to its last line,
  when each line looks like progress. A progress line starts with a percentage, holds a bar, or starts with a word
  such as Progress, Downloading or Receiving objects. This is how pnpm and webpack print progress when there is no
  terminal. Error lines, log lines and test names that differ only in numbers stay.
- **Grep content.** When a file has several matching lines, each file's name heads its lines, as ripgrep's --heading
  prints them, rather than starting every line. When a search found several files, one file shows at most 30 lines.
  Then a line counts the rest and says to search that file alone. A page that starts inside a file's lines starts
  with "<file> (continued)". When every file has one line, the output is one line a file, as before.

## Measured

Real output, from node 22, go 1.24 and cargo 1.97 on small generated projects, and from this repository's history.
"Model reads" is what reached the model before this change: the whole output, or 0093's start and end past 25,000
characters.

| Output | Characters | Model reads before | Digest |
| --- | --- | --- | --- |
| node --test (TAP), 306 tests, 2 failing | 36,980 | 14,100, failures maybe not among them | 2,634 |
| node --test (spec), the same run | 9,568 | 9,568 | 1,525 |
| go test -v, 302 tests, 1 failing | 19,227 | 19,227 | 202 |
| cargo test, 305 tests, 1 failing | 8,411 | 8,411 | 1,316 |
| cargo build, 40 warnings | 7,023 | 7,023 | 2,161 |
| git log -40 | 32,052 | 14,100 | 4,955 |
| git diff over 52 files | 199,800 | 14,100 | 12,988, every file's counts and 6 whole diffs |

Grep, 250 lines in packages/core/src:

| Search | Files | One line a match | Under headings | With the 30-line cap |
| --- | --- | --- | --- | --- |
| `export function` | 53 | 23,603 | 19,187 (−19%) | 19,187 |
| `assert\.equal` | 8 | 28,746 | 19,843 (−31%) | 10,831 |
| `await ` | 3 | 31,151 | 22,168 (−29%) | 5,745 |

## Consequences

- A test run, a build or a long log costs a small fraction of what it did on every step it stays in the conversation.
  The failures are always in what the model reads, rather than only when they fall in the start or end of the output.
- The model can always read the whole: the note says where it is. A session whose model reads the whole of three
  digests stops getting them, and the diagnostics show how often that happens.
- **Accuracy risks.**
  - A digest can drop a line the model needed: a passing test's log output, a warning past the tenth, a commit's body.
    Lines the digest does not recognize stay, and a failed build with no error it recognizes goes in whole.
  - A linter's warnings and git log with patches are left whole on purpose.
  - The cap on Grep can hide matches in a file with many. Its note says how to see them.
- The Bash description does not list the kinds, so as not to grow the fixed prompt. Its line on long output is shorter
  than it was.
- BashOutput, which reads a background command's output, is not digested yet.
