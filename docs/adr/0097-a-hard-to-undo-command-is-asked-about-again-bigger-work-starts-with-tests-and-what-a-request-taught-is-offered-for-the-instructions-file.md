# 0097. A hard-to-undo command is asked about again, bigger work starts with tests, and what a request taught is offered for the instructions file

- Status: Accepted, builds on 0052, 0059, 0095 and 0096
- Date: 2026-10-24

## Context

0095 and 0096 hold a finished request to the project's checks, a scan and the Reviewer. Three gaps remain, all
sharper with the cheap and free models most testers will use:

- under Full access, or a rule that allows a command, the agent runs commands nobody sees first. Most are harmless. A
  few cannot be taken back: a recursive delete of source, `git reset --hard`, a force push, `npm publish`,
  `terraform destroy`, `DROP TABLE`. A weak model writes one of these when it misreads the request, and nothing in the
  loop asks it twice;
- bigger work (a plan, a task list) is written code first and tested after, if at all, so the tests end up checking
  what the code does rather than what was asked;
- what the person corrects in one session ("we use pnpm here", "don't use default exports"), and what the agent
  learns from a failed command, is lost at the next session, which makes the same mistake.

## Decision

### The second look before a hard-to-undo command

`hardToUndo(line, context)` in `@encode/permissions` (`irreversible.ts`) says why a shell line would be hard to undo,
as a clause ("deletes src and everything in it"), or null. It reads the line the way Auto review does (0059: the
bash and PowerShell words, now in `command-words.ts`, shared by both), each command of a list or pipeline, the command
behind a wrapper (`sudo`, `env`, `timeout`, `npx`, `xargs`, ...), the folder a `cd` or `Set-Location` moved to, and
the line given to `sh -c`, `bash -c` or `pwsh -Command` (three levels deep at most). What it counts:

- **deletes**: a recursive delete (`rm -r`, `Remove-Item -Recurse`), a delete outside the project, `shred`, `find
  -delete`, `find -exec rm`, and a recursive delete of a folder only known when the line runs (`rm -rf "$DIR"`, from
  `xargs`). A folder a build or an install makes again (`node_modules`, `dist`, `target`, `.next`, `__pycache__`, ...)
  and the temporary folders are not counted; `build`, `out` and `bin` are, since they hold source in some projects;
- **git**: `reset --hard`, `checkout -- <files>` or `checkout .`, `restore` of the work tree, `clean -f`, `stash
  drop`/`clear`, `branch -D`, `reflog expire`, `gc --prune=now`, `filter-branch`/`filter-repo`, `worktree remove
  --force`, and every `push` (a force push, a delete on the remote, `--mirror`/`--prune`, and a plain push, which
  others can fetch);
- **publishing and services**: package registries (`npm`/`pnpm`/`yarn`/`bun publish`, `cargo publish`/`yank`,
  `twine`, `poetry publish`, `gem push`, `dotnet nuget push`, `vsce publish`), `gh`/`glab` commands that change the
  repository for everyone (merge, close, delete, release), `gh api` with a writing method, and infrastructure:
  `terraform`/`tofu` apply and destroy, `pulumi up`/`destroy`, `kubectl` delete and apply, `helm` install and uninstall,
  `aws`, `gcloud`, `az` deletes, `docker`/`podman` push and prune, deploys to production (`fly`, `heroku`, `vercel
  --prod`, `netlify --prod`, `wrangler`, `firebase deploy`);
- **databases**: a client (`psql`, `mysql`, `sqlite3`, `mongosh`, `redis-cli`, ...) given SQL that drops a table,
  truncates, deletes every row (no `WHERE`) or drops a column, and `FLUSHALL`; `dropdb`; an ORM's reset (`prisma
  migrate reset`, `rails db:drop`, `manage.py flush`, `artisan migrate:fresh`, ...);
- **the machine**: disk tools (`mkfs`, `fdisk`, `diskpart`, `Format-Volume`, ...), `dd of=`, shutdown and restart,
  `chmod`/`chown -R`;
- a line it cannot read (a `cmd /c` line, a construct its reader does not take) is matched by its words with a bounded
  pattern, toward asking: "may delete, overwrite or send out what cannot be brought back (eNCode could not read all of
  it)".

Every pattern reads a line in linear time (a test holds it to that on long, repetitive lines).

In the loop, when a command would run without the person seeing it (it needs no approval: Full access, a rule that
allows it, or a read-only proof) and the Reviewer of Auto review did not approve it, and `hardToUndo` gives a reason,
the agent's own model (the role that runs the agent) is asked once more, with no tools and in other words
(`second-look.ts`): only the person's last three requests, the command and its folder, and what makes it hard to undo.
It answers `{"run": true|false, "reason": "..."}`. When it says yes the command runs, and its card says "Checked again
before it ran: ...". When it says no, cannot be read, or cannot be asked within 60 seconds, the person decides: the
approval card says "This command deletes src and everything in it. Asked again before it ran, the agent's model did not
confirm it." with the model's reason, and approving it is for this one call only. A command the person sees anyway, or
one Auto review's Reviewer approved, is not asked about again.

**Settings → Agent → Approvals → Before a command that is hard to undo**: ask the model again (default) or run as
allowed (`askAgain`: `on`, `off`).

### Tests first on bigger work

Once a request, when bigger work starts in Code mode (the person approved a plan, or the agent wrote a task list of
three steps or more), the project has a test check (0095), the checks are not off and no test file changed yet, the
agent's next step carries: "This is bigger work, and the project has tests (`npm test`). Write the tests first: add or
change tests for what this work adds or fixes, the edge cases with it; run them, and see the new ones fail for the
reason you expect; then change the code until they pass, and run the whole suite once at the end. Leave out a part
that cannot be tested, and say so in your reply." It is a reminder, not a gate: the checks and the Reviewer (0095,
0096) still hold the result.

### What a request taught

When a request ends on an answer (or `attempt_completion`), and the person's message set a rule for later requests by
its words ("always", "never", "from now on", "in this repo", "we use", "instead of", ...) or a command failed and
another worked after it, eNCode asks the model of the Small jobs role (0094) for at most three lines that would have
saved the correction or the failed attempt (`conventions.ts`). It is given the person's message, the failed commands
with the end of their error and what worked after (keys removed), and the project's instructions file as it is now
(the first of `ENCODE.md`, `.encode/ENCODE.md`, `AGENTS.md`, `CLAUDE.md`, the order memory reads them in; 8,000
characters at most). The call has no tools, 2,000 output tokens and 30 seconds, and runs after the turn is over, so
nobody waits on it; the next request, Stop, a rewind or the close stops it.

The lines (one each, at most 200 characters, flattened, keys removed, none the file already holds and none offered
before in the conversation) show below the answer: "Keep what this request taught in ENCODE.md?", each line, and
**Add to ENCODE.md** or **Dismiss**. Nothing is written before Add. Add puts them as bullets under the file's
`## Conventions` heading, made at the end when there is none, in the file's own line endings, and creates `ENCODE.md`
when the project has no instructions file. It writes only where the file's real path, and its folder's, stay inside the
project, so a link in a repository cannot turn the click into a write elsewhere. The card then says "Added to
ENCODE.md"; a dismissed one shrinks to a line. The next session reads the file as it always does.

**Settings → Agent → Checks → Keep what a request taught**: offer to keep (default) or never (`learnConventions`).

### Tests and the benchmark

The scripted models of the core's test harness and of the benchmark's reference and replay runs answer only what they
were scripted for, so both turn the second look and the offer off, as they do the checks and the Reviewer.

## Consequences

- A command that cannot be taken back no longer runs unseen on one reading of the request: the agent's model reads it
  again with only the request in view, and the person decides when the two readings differ. It costs one short call
  per such command, under Full access or an allowing rule only.
- Bigger work in a tested project is asked to start from the tests, and the person's corrections and the agent's
  failed attempts become project instructions the next session reads, by the person's click.
- `irreversible.test.ts` holds the deletes, git, publishing, infrastructure, databases, the machine, nested shells,
  unreadable lines and linear time; `second-look.test.ts` the yes, the no, the unreadable answer, and when it is not
  asked; `tests-first.test.ts` the reminder and when it is not given; `conventions.test.ts` the words, the parser,
  where the lines go, the link refusal, the offer through the loop and the session, Add, Dismiss and the offer the
  next request stops. The desktop's end-to-end run denies a recursive delete the second look did not confirm, and adds
  an offered line to the demo's ENCODE.md.
- Open:
  - `hardToUndo` reads words, not effects: a script file the command runs (`./deploy.sh`, `npm run release`) is not
    read, and a delete through a language (`node -e "fs.rmSync(...)"`) is not seen.
  - The second look is the same model reading again; a model that is wrong both times is not caught. Auto review's
    Reviewer, a second model, is the stronger check when the person uses it.
  - Best-of-N (several attempts at a risky change, the best kept) is the next step, opt-in, in its own record.
  - The words that mark a rule are English.
