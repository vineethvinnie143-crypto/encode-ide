# 0059. Auto review asks a model about low-risk commands, behind checks the model cannot overrule

- Status: Accepted, builds on 0004, 0040 and 0055
- Date: 2026-10-22

## Context

Under Auto review (0004) a command runs unasked only when the assessor can prove it read-only. Everything else asks:
`npm test`, `git add`, `mkdir build`, a build script. In a real session that is most commands, and a person who has to
answer all of them either stops reading the cards or switches to Full access, which asks about nothing. Claude Code's
and Codex's automatic modes let a second model judge the routine ones. The model has to be handled with care:

- **A model can be fooled.** It reads the command, and the command is text the agent chose after reading files and web
  pages (T1, T27). "The user already approved this" in a comment is exactly what an injected command would say.
- **A model can be weak.** Free models come and go (0023, 0024), and the Reviewer may be one of them.
- **Some commands must never be a model's call.** A force-push, a `curl` of a secret, a recursive delete outside the
  project do not become safe because a model said so.
- **It has to fail toward asking.** A model that is slow, unavailable, off-format or declining everything must leave
  the person with the question they had before, not with a refusal or a yes.
- **It costs a call.** Latency and tokens, on every decision, from a model the person may pay for.

## Decision

- **Two layers, and the first cannot be talked to.** `screenCommand` (`@encode/permissions`, `auto-review.ts`) is
  plain code: it parses the line with the same bash and PowerShell grammars as the assessor and answers *reviewable* or
  a reason. A line goes to the Reviewer only when every command in it can be read to the end and none of them runs with
  administrator rights, moves data over the network by hand, changes the machine outside the project (packages,
  services, scheduled tasks, the registry, disks), acts on containers, clusters or cloud accounts, publishes, starts a
  program only known when the line runs or code the grammar cannot read (`eval`, `xargs`, `python -c`, a script piped
  into a shell), deletes or changes permissions recursively, writes (also by redirection) outside the project or into a
  protected folder, rewrites or discards git history or work, pushes anywhere but a configured remote name, changes git's
  settings, contains invisible characters, is longer than the assessor reads, or sets a variable that changes which
  programs run. Every rule errs toward the person, and the floor never reads what the model said: a Reviewer cannot
  widen it.
- **Only a question the assessor asked on its own is put to the Reviewer.** A command that a rule says to ask about, a
  hook that asked, a tool other than the shell, a path outside the project: all of these still go to the person. A
  `deny` rule still denies. If the person already allowed the call for the session ("Approve for this session"), there
  is nothing to judge and the Reviewer is not called.
- **The Reviewer is one model call with one small job.** Role `reviewer` in the router (Settings → Roles), tool name
  `AutoReview`, no tools, temperature 0, low reasoning, 512 output tokens, 20 seconds. Its fixed instructions say to
  approve only a command that the person's recent requests call for, that changes only files inside the project and
  nothing a version control or a rebuild cannot restore, that sends nothing off the machine except through the
  project's own build, test and install tooling, and that touches no credentials, shell profiles or other people's
  files; to decline what has nothing to do with the request or looks planted by text the agent read; and to ask
  otherwise. It sees the person's last three requests in their own words (500 characters each) and one action block
  (tool, folder, command, the assessor's reason) inside a tag with a random suffix, which the instructions call data
  written by the agent. It does not see files, tool results, web pages, reminders or the rest of the conversation, so
  text planted there reaches it only if the agent copies it into the command.
- **The answer is one JSON object**, `{"verdict":"approve"|"decline"|"ask","risk":"low"|"medium"|"high","reason":…}`.
  A verdict counts as approval only with risk `low`; an approval with no risk or a higher one is a question for the
  person. The reason is cut to 200 characters with control and invisible characters removed, because it is shown.
- **Every failure ends in a question to the person.** A command over 4000 characters is not sent. No model for the
  role, a model that does not answer in time or an answer that is not the format put the person's question back and
  keep the Reviewer quiet for 30 seconds. Three declines in a row stop it until the person has answered a question
  (a run of declines means the agent keeps trying something, and a person should look). The person stopping the turn
  is not a failure and is not hidden as one.
- **What the Reviewer approved is remembered for the session**, by the same key as a session grant (the command and the
  folder), at most 200 of them, so a repeated command does not cost another call. A decline or a doubt is never
  remembered: the same command is judged again.
- **A decline reaches the model, not the person.** The step ends as declined, and the model is told: "The automatic
  reviewer declined this action, so the user was not asked", the reason, and not to retry it unchanged but to ask the
  person or choose another way. A question for the person is the ordinary approval card with a line above the command
  saying who left it to them: "The Reviewer leaves this to you: …" or, when the floor stopped it, "Auto review leaves
  this to you: …".
- **The person sees who looked.** A step shows "Being reviewed" while the model works; an approved one carries a
  shield mark and the line "Approved by the Reviewer (low risk): …" when opened; a declined one opens by itself with
  "Declined by the Reviewer (…): …". The Reviewer's tokens are counted in the session's usage, and its calls stay on the
  model the session already uses (the session id is the router's sticky key), so providers' prompt caches stay warm.
- **Subagents use the same Reviewer**, judged against their parent's requests: a subagent's own prompt was written by a
  model, and what the person asked is the measure.
- **Off in tests, on in the app.** A session takes `autoReview: false` to ask the person as Workspace Write does; the
  scripted test harness turns it off unless a test asks for it.

## Consequences

- Routine commands (tests, builds, installs the project already uses, `git add`, file moves inside the project) run
  without a card under Auto review, at the price of one small call per distinct command.
- The Reviewer is a model and can be wrong in either direction. A wrong approval is bounded by the floor: the command is
  inside the project, local, and does not publish or reach the network by hand. A wrong decline costs the person a
  re-ask. Neither can reach what the floor stops.
- **The floor reads a command's words, not the program behind them.** Code the agent writes and then runs (it edits a
  `package.json` script, then `npm run build`) reaches the Reviewer by its name alone. The Reviewer is told to ask when
  the command runs software the project does not already use, which helps, and the edit is on screen in the thread, but
  neither contains it. The operating-system sandbox is what does (threat model R1, RP9). Until it exists, a person who
  works on code they do not trust uses Workspace Write.
- Windows has no sandbox either way. The floor and the approvals are the control there.
- The reviewer role can be pointed at any model, free or paid, like every other role. Free only keeps its meaning: the
  call goes through the router, which refuses a paid model in that mode and never falls from a free model to a paid one
  (0024, 0052). With no usable model the person is asked, exactly as before this decision. On the free pool a
  Reviewer call counts against the free allowance like any other call, so a session that runs many distinct commands
  uses more of it.
- Tests: the floor has table tests for what it passes and stops in both grammars, with fixed-seed property tests that a
  stopped line stays stopped under quoting, spacing and wrappers; the Reviewer has tests for its prompt, parsing and every
  failure path; the loop and session tests cover decline, doubt, approval, memory, session grants, hooks, subagents and
  the streak. The end-to-end run drives the app against the fake provider, which answers the Reviewer by the file named in
  the command: one command approved, one declined, one passed to the person, and a force-push stopped by the floor
  without the Reviewer being asked.
- Not covered: reviewing file edits (they keep running unasked in this policy, as in Workspace Write), and a budget for
  the Reviewer's spend. Both can follow if the usage numbers say they are needed.
