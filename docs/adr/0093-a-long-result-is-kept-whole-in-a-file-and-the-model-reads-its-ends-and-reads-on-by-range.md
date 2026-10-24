# 0093. A long result is kept whole in a file, and the model reads its ends and reads on by range

- Status: Accepted, builds on 0062 and 0092
- Date: 2026-10-24

## Context

Every step of a request sends the whole conversation again. A tool result that enters it is paid for on every step
after, cached or not, until a compaction takes it out. The benchmark of 0092 shows where the tokens go: the task whose
command prints a long log spends about 76,000 input tokens over five calls, two and a half times a task of the same
length whose results are short.

Three habits made results long:

- Bash cut its output at 30,000 characters, in the middle, and the loop cut any other result at 60,000. What was cut
  was gone: a failure in the middle of a build log could not be found again but by running the build again.
- Read with no range sent up to 2,000 lines, or 100,000 characters (about 28,000 tokens). On the benchmark's
  2,400-line file it sent 90,717 characters and still stopped before the function the request was about.
- A model that changed a few lines of a long file with Write sent the whole file, and a weak model's Write could put
  `// ... rest of the code unchanged` where hundreds of lines had been.

The person also could not see what a request cost: the Status dialog and the message box show the session's totals,
not one request's.

## Decision

### A long result is kept whole

A tool's text longer than 25,000 characters is kept whole in a file, and the model gets its first 8,000 and last
6,000 characters, cut at line ends, with one line between them:

```
[… Lines 121-20,200 of 20,345 (1,180,231 characters) are not shown. All of it is in <path>: Read it with offset and limit, or Grep it. …]
```

The line numbers are the file's, so the model reads on from where the start stops. Bash and BashOutput no longer cut
their output themselves; the shell still keeps at most its first 200,000 and last 800,000 characters. A tool whose
results keep within a size of their own (`bounded`: Read) is never kept in a file, only cut at the loop's ceiling of
60,000 characters. Where nothing can be kept (no room left, a disk error), the model gets twice as much of each end
and is told to narrow what the call returns.

The files are kept by the agent host (`packages/core/src/outputs.ts`), a folder for each session, by default in
`outputs/` beside the session logs:

- named for the tool and the call (`Bash-call_1.txt`), with every character of the call's id that could leave the
  folder replaced, and never over another file;
- readable by their owner only (0600, the folder 0700);
- at most 64 MB for one session and 512 MB for all, the folders kept in longest ago removed first to make room;
- removed with their session, and once nothing was kept in them for two weeks.

A session's folder is one of its read roots: its agent and subagents read and search it without asking, as they read
the person's skills. Another session's folder is outside its workspace like any folder, and asks.

### A long file read with no range shows its start and what the rest defines

Read with no offset and no limit, of a file whose numbered lines would pass 28,000 characters, shows lines from the
start up to 20,000 characters and then an outline of the rest, from the code index's rules (0090): each definition's
line and its line as written, members under their class, up to 4,000 characters, then how many more there are and
that CodeMap or Grep finds them. On the benchmark's 2,400-line file that is 24,128 characters instead of 90,717. A
file in no language the index reads shows its start and a note to read on by range or Grep it.

A Read with a range is cut to 56,000 characters (it was 100,000), at the last whole line that fits instead of by
halves. Every Read now fits under the loop's ceiling, so any of them can be answered by pointing back to it when it is
read again unchanged.

### A Write that is an edit is turned back once

Write over an existing file is turned back, once, when:

- the file has 200 lines or more and the new content keeps all but a fifth of them: it sends the whole file to change
  a few lines, which Edit or MultiEdit does by sending only what changes; or
- the new content is 20 or more lines shorter and has a comment that stands for left-out code (`// ... rest of the
  code unchanged`, `# ...existing code...`, `<!-- rest of the page -->`) that the file did not have: the lines it
  stands for would be lost.

The same Write sent again goes through: the model was told, and meant it.

### The prompt's start stays the same from step to step

A provider's prompt cache serves the start of a prompt that is the same as the one before. The audit found it already
holds, and a test now keeps it so: from one step to the next and from one request to the next, the instructions and
the tools are the same, in every mode (a tool not offered in a mode is refused when called, not taken off the list),
and each request starts with the whole of the one before it. The date, the mentioned files and the news of
background work go in the new message. Anthropic's and OpenRouter's cache marks stay where they were: the
instructions, then the last two of your side's messages.

What still changes the start: a tool ToolSearch loads (once), a switch of model, a compaction, and the shortening of
old tool results near the context limit. The last is Efficiency 2's.

### What a request cost

Each model call of a request (the agent's, its subagents', the Auto reviewer's) adds to your message: calls, input
tokens, of them how many came from the cache, output tokens, and the cost when every call said what it cost, as
OpenRouter does. It is shown live at the head of the work log, and stored with the message:

```
Worked for 2m 14s  18.4k tokens · 72% cached · $0.031
```

A cost of nothing reads `free`. A cost only some calls reported is not shown: a part of it would read as the whole.

## Consequences

- On the benchmark's reference runs, the long-output task goes from 76,232 to 53,740 input tokens (-30%) and the
  mean of all tasks from 29,719 to 27,902 (-6%); every task still passes with no tool failure. The reference
  solutions read by range, so the change to Read shows on a model that does not; the numbers for a live model need
  a key.
- A failure in the middle of a long log can be found again without running the command again.
- The kept files hold what commands printed, which can include what a command shows of the person's secrets, at rest
  in the profile folder for up to two weeks. The hardening step that keeps the agent out of eNCode's profile folder
  leaves each session its own folder of outputs to read.
- A replay (0092) does not have the outputs of commands, which it never runs: a Read of a kept output fails in a
  replay, and shows as a call that did something else.
- Open:
  - A turned-back Write costs its output tokens once more as Edit; the Write it saves is the one the model would send
    next time, and the lines it would lose.
  - Requests through a provider that reports no cost show tokens only; the router's prices could fill it in.
  - An outline of a long file of near-copies stops before its end; CodeMap or Grep finds the rest.
