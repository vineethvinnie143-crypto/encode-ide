# 0140. Checks run when a step is done, a missing name is looked up, and a stronger model first reads the stuck steps

- Status: Accepted, amends 0095 and 0100; builds on 0094, 0096 and 0139
- Date: 2026-10-26

## Context

After 0139, DeepSeek V4.1 Flash passes most of eNCode's own benchmark. The tasks it still fails, there and on harder
suites such as Terminal-Bench, fail in three ways:

- **Long chains of steps.** The project's checks run only before the agent finishes (0095). On a task of many steps, a
  slip in the second step comes back after the eighth, when the change is no longer fresh and later steps are built on
  it.
- **A command or an API it does not know.** A program that is not installed, an option this version does not take, a
  script the project does not have, a module or a member a library does not have. A smaller model then guesses another
  spelling, and another, where a look at `--help`, the manifest or the installed source would end it.
- **A wrong first approach.** After two setbacks, the person could only let a stronger model take over the rest of the
  request (0100). That costs the stronger model's price for every step after, and many stuck requests need only to be
  told what is wrong.

None of this has been measured on a paid model yet: the person tries it on real work first.

## Decision

- **Checks when a step of the task list is done (amends 0095).**
  - When a successful TodoWrite marks an item done that was not done before, and code changed in the request, the
    project's checks that have not run since the last change run then, as calls of eNCode's own (the same approval,
    sandbox and hooks as the agent's commands).
  - Only a new failure goes back, with the step's words, the output and how it compares with before the request. The
    agent fixes it while the change is fresh, unless a step still open on its list is what will fix it, and then it says
    so and goes on. The person sees a notice.
  - At most 5 such runs a request. A check that takes longer than 120 s is left to the end of the request for the rest
    of the session, with a notice. A step whose edits the language servers already found errors in runs none.
  - Off when the checks are off, outside code mode, for helpers, and once the person declined a check.
  - The finish gate is unchanged: a check that passed after the last change is not run again there.
- **A missing name is looked up before the next guess.** A failed command of the agent's is read from the end of its
  output for what it named that was not there:
  - a program (bash, sh, zsh, cmd and PowerShell);
  - an option (getopt, argparse, commander, click, clap, cobra and Go's flag), with the program it went to, wrappers such
    as `sudo`, `npx` and `env` left out;
  - a package script (npm, pnpm and yarn);
  - a module (Python, Node, TypeScript, Rust);
  - a member of a module or a type (Python, TypeScript, Node, Ruby, Rust, Go).

  Its result then says what was not there and how to look up what is, at the version installed: `command -v` or
  `where.exe`, the program's `--help`, the project's scripts, the manifest and lockfile, CodeMap on the dependency when
  the agent has it, Grep. It ends with "Don't guess another spelling or another name." Each name is told once a request,
  at most three a request.
- **A stronger model reads the stuck steps first (amends 0100).**
  - After two setbacks, when the Plan or Review role has a strong model, the person is first asked whether it may read
    the last steps and say how to get past them. The card names the setbacks and what the one call should cost: the
    request and the last steps read (at most 32,000 characters), and about 1,500 tokens written, at that model's price.
  - On yes, it gets the person's last three requests, what went wrong, the task list and the steps since the request,
    newest kept when they do not all fit, in one call without tools. Its answer, at most 250 words, says the cause and
    the next steps. It goes to the agent as advice to check against the code, and the agent goes on with its own model.
  - After two more setbacks the person is asked, as before, whether that model may do the rest of the request.
  - On no, the agent goes on and nothing more is offered in the request. "Ask it whenever one is stuck" allows the look
    for the session; the take-over stays its own question.
  - Nothing here runs unasked: print mode and the bench decline every approval.

## Consequences

- A slip in a long task comes back one step old, at the cost of the checks running more often. The cap of five runs a
  request, and the slow checks left to the end, bound that.
- A smaller model stops guessing at names: it reads what is there. A misread is possible: the note says what the output
  said, and the agent can still see the output itself.
- A stuck request costs one call of the stronger model, cents on a paid model, where a take-over costs every step after.
  The take-over is still there when the advice was not enough.
- The detection rules are English error texts of common tools. Other tools' errors get no note, as before.
