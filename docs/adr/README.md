# Architecture decision records

Each record states one decision, the forces behind it and what follows from it. Records are
never rewritten after they are accepted: a later decision supersedes an earlier one and both
say so.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-pnpm-monorepo-and-in-house-test-tooling.md) | A pnpm monorepo with in-house test tooling | Accepted |
| [0003](0003-own-code-above-the-platform.md) | Own code above the platform | Accepted |
| [0004](0004-command-approval-from-one-grammar.md) | Command approval from one grammar and one policy | Accepted |
| [0005](0005-programs-from-absolute-path-entries.md) | Programs resolve only from absolute PATH entries | Accepted |
| [0006](0006-subagents-inherit-their-parents-authority.md) | Subagents inherit their parent's authority | Accepted |
| [0007](0007-web-fetch-asks-per-site.md) | web_fetch asks per site and never reaches private addresses | Accepted |
| [0008](0008-api-keys-in-the-os-keychain-only.md) | API keys in the OS keychain only | Accepted |
| [0009](0009-compaction-keeps-every-tool-call-answered.md) | Compaction keeps every tool call answered | Accepted |
| [0010](0010-renderer-isolation.md) | A sandboxed renderer that only the app's page can use | Accepted |
| [0011](0011-agent-commands-run-in-the-os-shell.md) | The agent's commands run in the OS shell | Accepted |
| [0012](0012-windows-first-ci.md) | Windows-first CI with a sandboxed end-to-end smoke | Accepted |
| [0013](0013-own-icons-tokens-and-bundled-fonts.md) | Own icons, one token set and bundled fonts | Accepted, amends 0003 |
| [0014](0014-one-command-registry-and-no-project-switch-under-a-running-agent.md) | One command registry, and no project switch under a running agent | Accepted |
| [0015](0015-one-tab-model-for-the-side-and-bottom-panels.md) | One tab model for the side and bottom panels | Accepted |
| [0016](0016-windows-fonts-by-default-our-own-one-setting-away.md) | Windows' fonts by default, eNCode's own one setting away | Accepted, amends 0013 |
| [0017](0017-the-thread-draws-once-per-frame-and-only-what-changed.md) | The thread draws once per frame, and only what changed | Accepted |
| [0020](0020-the-free-tier-runs-behind-our-own-gateway.md) | The free tier runs behind our own gateway | Accepted |
| [0021](0021-sessions-are-rotating-device-bound-refresh-tokens.md) | Sessions are short-lived tokens with rotating, device-bound refresh tokens | Accepted |
| [0022](0022-connect-openrouter-with-pkce-on-a-loopback-listener.md) | Connect OpenRouter with PKCE on a loopback listener | Accepted |
| [0023](0023-failover-is-silent-and-only-a-clean-reply-is-committed.md) | Failover is silent, and only a clean reply is committed | Accepted |
| [0024](0024-a-model-is-free-only-when-the-listing-and-the-bill-say-so.md) | A model is free only when the listing and the bill say so | Accepted |
| [0030](0030-the-agent-runs-in-a-host-that-clients-drive.md) | The agent runs in a host that clients drive over a message port | Accepted |
| [0031](0031-sessions-are-append-only-logs.md) | Sessions are append-only logs | Accepted |
| [0032](0032-claude-code-tool-contracts-and-reminders.md) | Claude Code's tool contracts, and reminders instead of a changing prompt | Accepted |
| [0033](0033-the-editor-is-our-own-engine.md) | The editor is our own engine: text model, core and view | Accepted; right-to-left reading order (opt-in) and screen readers refined by 0081 |
| [0034](0034-documents-live-outside-the-ui-store.md) | Open documents live outside the UI store, and "unsaved" is derived from the text | Accepted |
| [0035](0035-openrouter-presets-with-server-tools-go-through-the-messages-api.md) | A preset whose server tool chat-completions refuses is asked on the Messages API | Accepted |
| [0040](0040-permission-rules-are-judged-over-parsed-commands.md) | Permission rules are judged over parsed commands | Accepted |
| [0041](0041-folder-settings-grant-only-when-approved.md) | A folder's settings grant only what the user approved | Accepted |
| [0042](0042-hooks-in-claude-codes-format-fail-closed.md) | Hooks in Claude Code's format, and a broken guard denies | Accepted |
| [0043](0043-checkpoints-record-what-the-file-tools-change.md) | Checkpoints record what the file tools change, and rewinding never overwrites silently | Accepted |
| [0044](0044-an-in-house-mcp-client-with-per-server-approval.md) | An in-house MCP client, with per-server approval | Accepted |
| [0050](0050-the-desktop-is-used-through-one-tool-one-application-and-one-chat-at-a-time.md) | The desktop is used through one tool, one application and one chat at a time | Accepted; `open` and the pointer's trip are added by 0120, numbers and the taskbar by 0121 |
| [0051](0051-tester-builds-carry-their-commit-keep-a-scrubbed-log-and-report-in-one-file.md) | Tester builds carry their commit, keep a scrubbed log and report in one file | Accepted |
| [0052](0052-every-model-call-goes-through-the-router-keys-are-asked-for-by-origin.md) | Every model call goes through the router, and keys are asked for by origin | Accepted |
| [0053](0053-the-windows-desktop-helper-is-our-own-program-built-on-the-machine-from-source-in-the-repository.md) | The Windows desktop helper is our own program, built on the machine from source in the repository | Accepted |
| [0054](0054-computer-use-is-opt-in-visible-while-it-runs-and-stoppable-from-anywhere.md) | Computer use is opt-in, visible while it runs, and stoppable from anywhere | Accepted |
| [0055](0055-a-folders-permissions-are-one-snapshot-that-fails-closed.md) | A folder's permissions are one snapshot that fails closed | Accepted, builds on 0040 and 0041 |
| [0056](0056-hooks-run-from-the-trusted-snapshot-and-every-write-is-kept-before-it-is-made.md) | Hooks run from the trusted snapshot, and every write is kept before it is made | Accepted, builds on 0042, 0043 and 0055 |
| [0057](0057-mcp-servers-run-from-the-folders-files-one-hub-per-folder-and-looking-starts-nothing.md) | MCP servers run from the folder's files, one hub per folder, and looking starts nothing | Accepted, builds on 0044, 0055 and 0056 |
| [0058](0058-web-search-goes-through-the-provider-the-person-chose-and-its-key-goes-to-that-provider-alone.md) | Web search goes through the provider the person chose, and its key goes to that provider alone | Accepted, builds on 0007, 0008 and 0052; DuckDuckGo's pacing and the advice after a failed search are added by 0122; Parallel as the free default by 0123 |
| [0059](0059-auto-review-asks-a-model-about-low-risk-commands-behind-checks-the-model-cannot-overrule.md) | Auto review asks a model about low-risk commands, behind checks the model cannot overrule | Accepted, builds on 0004, 0040 and 0055 |
| [0060](0060-text-that-reads-differently-from-how-it-runs-is-shown-to-the-person-and-told-to-the-model.md) | Text that reads differently from how it runs is shown to the person and told to the model | Accepted, builds on 0004, 0012 and 0032 |
| [0061](0061-subagents-are-defined-in-markdown-and-what-a-repository-fills-is-read-as-a-stranger-s-file.md) | Subagents are defined in Markdown, and what a repository fills is read as a stranger's file | Accepted, builds on 0006, 0041 and 0055 |
| [0062](0062-every-step-pays-for-the-whole-request-so-its-parts-have-a-budget-and-the-large-ones-wait-until-asked-for.md) | Every step pays for the whole request, so its parts have a budget and the large ones wait until asked for | Accepted, builds on 0009 and 0057 |
| [0063](0063-the-agents-commands-run-in-the-operating-systems-sandbox-and-the-person-is-told-what-it-does-not-hold-back.md) | The agent's commands run in the operating system's sandbox, and the person is told what it does not hold back | Accepted, builds on 0004, 0011, 0041, 0053 and 0059 |
| [0064](0064-the-review-tab-reads-git-itself-and-stages-a-hunk-the-way-git-add-p-does.md) | The Review tab reads git itself, and stages a hunk the way `git add -p` does | Accepted, builds on 0033, 0060 and 0063 |
| [0065](0065-the-turn-view-reads-the-agents-record-and-writes-back-only-over-what-the-person-saw.md) | The Turn view reads the agent's record, and writes back only over what the person saw | Accepted, builds on 0056 and 0064 |
| [0066](0066-what-a-message-mentions-comes-from-the-core-under-the-tools-rules-and-the-palette-runs-the-menus-actions.md) | What a message mentions comes from the core under the tools' rules, and the palette runs the menus' actions | Accepted, builds on 0055, 0059 and 0062 |
| [0067](0067-steering-goes-through-what-a-request-goes-through-the-reviewer-reads-the-change-as-data-and-a-shortcut-leaves-typing-alone.md) | Steering goes through what a request goes through, the Reviewer reads the change as data, and a shortcut leaves typing alone | Accepted, builds on 0014, 0017, 0031, 0042, 0052, 0054 and 0064 |
| [0068](0068-settings-is-a-page-that-keeps-each-change-as-it-is-made-and-a-chat-is-a-session-in-a-folder-of-its-own.md) | Settings is a page that keeps each change as it is made, and a chat is a session in a folder of its own | Accepted, builds on 0052, 0054, 0066 and 0067 |
| [0069](0069-the-agent-asks-before-planning-hooks-hear-what-it-waits-for-and-pdfs-are-read-by-encodes-own-reader.md) | The agent asks before planning, hooks hear what it waits for, notebooks change by cell, and PDFs are read by eNCode's own reader | Accepted, builds on 0031, 0042, 0059, 0062 and 0066 |
| [0070](0070-a-problem-is-said-in-a-sentence-with-what-can-be-done-and-what-the-provider-said-is-folded-under-it.md) | A problem is said in a sentence with what can be done, and what the provider said is folded under it | Accepted, builds on 0052 and 0068 |
| [0071](0071-work-goes-on-in-the-background-and-what-it-reports-reaches-the-agent-between-steps-or-in-a-turn-of-its-own.md) | Work goes on in the background, and what it reports reaches the agent between steps or in a turn of its own | Accepted, builds on 0031, 0042, 0062 and 0070 |
| [0072](0072-language-intelligence-comes-from-real-language-servers-that-encode-talks-to-through-its-own-client.md) | Language intelligence comes from real language servers that eNCode talks to through its own client | Accepted, refines 0003; where servers run is settled by 0073 |
| [0073](0073-worktrees-are-made-by-encode-with-hooks-off-and-language-servers-run-in-trusted-folders-for-the-editor-and-the-agent.md) | Worktrees are made by eNCode with hooks off, and language servers run in trusted folders for the editor and the agent | Accepted, refines 0072 |
| [0074](0074-the-editor-asks-the-language-servers-through-checked-questions-and-draws-their-answers-with-its-own-widgets.md) | The editor asks the language servers through checked questions, and draws their answers with its own widgets | Accepted, builds on 0072 and 0073 |
| [0075](0075-a-change-a-language-server-plans-is-checked-whole-goes-into-the-editor-or-onto-the-disk-and-can-be-seen-first-and-taken-back.md) | A change a language server plans is checked whole, goes into the editor or onto the disk, and can be seen first and taken back | Accepted, builds on 0072, 0073 and 0074 |
| [0076](0076-the-editor-finds-its-way-by-symbols-the-servers-name-asked-only-while-shown-and-calls-are-followed-a-level-at-a-time.md) | The editor finds its way by the symbols the servers name, asked only while shown, and calls are followed a level at a time | Accepted, builds on 0072, 0074 and 0075 |
| [0077](0077-the-editor-folds-by-the-servers-ranges-or-the-indentation-and-pins-colours-and-maps-the-text-from-what-it-already-reads.md) | The editor folds by the servers' ranges or the indentation, and pins, colours and maps the text from what it already reads | Accepted, builds on 0003, 0072, 0074 and 0076 |
| [0078](0078-inlay-hints-and-semantic-tokens-are-kept-by-line-beside-the-text-and-follow-edits-until-the-server-answers-again.md) | Inlay hints and semantic tokens are kept by line beside the text, and follow edits until the server answers again | Accepted, builds on 0003, 0072, 0074 and 0077 |
| [0079](0079-large-files-are-coloured-on-another-thread-counted-from-indexed-points-and-held-to-measured-limits.md) | Large files are coloured on another thread, counted from indexed points, and held to measured limits | Accepted, builds on 0003, 0072, 0074 and 0077 |
| [0080](0080-long-lines-wrap-into-rows-the-layout-counts-and-spaces-and-tabs-are-marked-without-changing-the-text.md) | Long lines wrap into rows the layout counts, and spaces and tabs are marked without changing the text | Accepted, builds on 0003, 0077 and 0079 |
| [0081](0081-input-methods-compose-in-place-screen-readers-read-the-lines-around-the-cursor-and-right-to-left-text-reads-in-its-own-order-only-where-it-cannot-move-code.md) | Input methods compose in place, screen readers read the lines around the cursor, and right-to-left text reads in its own order only where it cannot move code | Accepted, builds on 0003 and 0080, refines 0033 |
| [0082](0082-the-editor-is-held-to-its-invariants-by-shrinking-properties-timed-fuzzing-real-edits-replayed-and-random-use-of-the-browser-and-the-app.md) | The editor is held to its invariants by shrinking properties, timed fuzzing, real edits replayed, and random use of the browser and the app | Accepted, builds on 0033, 0079 and 0081 |
| [0083](0083-a-language-server-is-installed-on-request-from-pinned-sources-unpacked-by-encode-and-run-from-its-own-folder.md) | A language server is installed on request, from pinned sources, unpacked by eNCode, and run from its own folder | Accepted, builds on 0072 and 0073 |
| [0084](0084-fivem-lua-is-read-through-encodes-own-plugin-runtime-definitions-and-natives-written-from-cfx-re-typings.md) | FiveM's Lua is read through eNCode's own plugin, runtime definitions, and natives written from Cfx.re's typings | Accepted, builds on 0072, 0073 and 0083 |
| [0085](0085-json-css-and-html-are-read-by-encodes-own-language-server.md) | JSON, CSS and HTML are read by eNCode's own language server | Accepted, builds on 0072 and 0083 |
| [0086](0086-a-companion-server-runs-beside-a-files-own-server-tailwind-and-svelte.md) | A companion server runs beside a file's own server; Tailwind and Svelte | Accepted, builds on 0072, 0083 and 0085 |
| [0087](0087-the-editor-suggests-code-as-you-type-from-the-inline-suggestions-role-drawn-as-ghost-text-and-sent-without-secrets.md) | The editor suggests code as you type, from the Inline suggestions role, drawn as ghost text and sent without secrets | Accepted, builds on 0052, 0060, 0062 and 0079 |
| [0088](0088-report-editor-issue-replays-what-was-recorded-and-the-app-reaches-the-editor-through-a-fixed-interface.md) | Report editor issue replays what was recorded, and the app reaches the editor through a fixed interface | Accepted, builds on 0051, 0075, 0082 and 0087 |
| [0089](0089-a-weaker-models-tool-calls-are-read-as-meant-mended-inputs-calls-written-as-text-and-closer-edit-matches.md) | A weaker model's tool calls are read as meant: mended inputs, calls written as text, and closer Edit matches | Accepted, builds on 0032, 0062 and 0073 |
| [0090](0090-the-agent-knows-where-things-are-a-code-index-of-its-own-a-ranked-map-in-the-first-message-and-codemap.md) | The agent knows where things are: a code index of its own, a ranked map in the first message, and CodeMap | Accepted, builds on 0062, 0073 and 0089 |
| [0091](0091-the-agent-writes-for-the-versions-installed-their-names-in-the-first-message-and-their-api-through-codemap.md) | The agent writes for the versions installed: their names in the first message, and their API through CodeMap | Accepted, builds on 0084 and 0090 |
| [0092](0092-the-agent-is-measured-by-a-benchmark-of-its-own-and-a-reported-request-replays-into-it.md) | The agent is measured by a benchmark of its own, and a reported request replays into it | Accepted, builds on 0062, 0088, 0089, 0090 and 0091 |
| [0093](0093-a-long-result-is-kept-whole-in-a-file-and-the-model-reads-its-ends-and-reads-on-by-range.md) | A long result is kept whole in a file, and the model reads its ends and reads on by range | Accepted, builds on 0062 and 0092 |
| [0094](0094-old-results-are-shortened-early-and-seldom-strong-models-get-a-short-guide-and-small-jobs-a-small-model.md) | Old results are shortened early and seldom, strong models get a short guide, and small jobs a small model | Accepted, builds on 0062 and 0093 |
| [0095](0095-before-the-agent-finishes-the-projects-checks-run-and-what-its-reply-claims-is-tested.md) | Before the agent finishes, the project's checks run, and what its reply claims is tested | Accepted, builds on 0073 and 0093 |
| [0096](0096-before-the-agent-finishes-its-changes-are-scanned-and-read-by-the-reviewer-and-a-plan-is-read-before-the-person-sees-it.md) | Before the agent finishes, its changes are scanned and read by the Reviewer, and a plan is read before the person sees it | Accepted, builds on 0064, 0094 and 0095 |
| [0097](0097-a-hard-to-undo-command-is-asked-about-again-bigger-work-starts-with-tests-and-what-a-request-taught-is-offered-for-the-instructions-file.md) | A hard-to-undo command is asked about again, bigger work starts with tests, and what a request taught is offered for the instructions file | Accepted, builds on 0052, 0059, 0095 and 0096 |
| [0098](0098-several-attempts-at-one-request-run-side-by-side-in-worktrees-and-the-person-keeps-the-one-the-reviewer-picks.md) | Several attempts at one request run side by side in worktrees, and the person keeps the one the Reviewer picks | Accepted, builds on 0052, 0063, 0073, 0094, 0095, 0096 and 0097 |
| [0099](0099-each-model-family-gets-its-own-reasoning-back-and-is-asked-in-its-own-terms.md) | Each model family gets its own reasoning back, and is asked in its own terms | Accepted, builds on 0009, 0035 and 0052 |
| [0100](0100-smaller-models-get-help-and-a-strong-model-takes-the-hard-steps-when-the-person-says-so.md) | Smaller models get help, and a strong model takes the hard steps when the person says so | Accepted, builds on 0052, 0094, 0095, 0096 and 0099 |
| [0101](0101-test-this-model-scores-a-model-on-the-benchmark-from-settings-before-it-takes-a-role.md) | Test this model scores a model on the benchmark from Settings, before it takes a role | Accepted, builds on 0052, 0092, 0094 and 0100 |
| [0102](0102-the-settings-pages-show-usage-hold-your-instructions-skills-agents-themes-and-servers-and-change-them-in-their-own-files.md) | The Settings pages show usage, hold your instructions, skills, agents, themes and servers, and change them in their own files | Accepted, builds on 0057, 0063, 0068 and 0093 |
| [0103](0103-browser-tabs-are-pages-in-their-own-process-and-each-chat-has-an-agent-tab-the-browser-tool-drives.md) | Browser tabs are pages in their own process, and each chat has an agent tab the Browser tool drives | Accepted, builds on 0007, 0010 and 0015 |
| [0104](0104-a-side-chat-is-a-copy-of-a-chat-to-ask-about-it-on-the-side-read-only-unlisted-and-deleted-when-closed.md) | A side chat is a copy of a chat to ask about it on the side: read-only, unlisted, and deleted when closed | Accepted, builds on 0015, 0030 and 0031 |
| [0105](0105-a-chat-moves-into-a-worktree-and-back-from-the-chat-and-brings-the-worktrees-changes-into-the-project.md) | A chat moves into a worktree and back from the chat, and brings the worktree's changes into the project | Accepted, builds on 0073 and 0098 |
| [0106](0106-encode-profile-is-off-limits-to-the-agent-and-files-a-folder-brings-are-read-with-care.md) | eNCode's profile is off limits to the agent, and the files a folder brings are read with care | Accepted, builds on 0061, 0063 and 0093 |
| [0107](0107-the-chrome-dice-is-the-logo-and-the-theme-is-black-and-silver-from-it.md) | The chrome dice is the logo, and the theme is black and silver from it | Accepted, supersedes the logo and default colours of 0013 |
| [0108](0108-the-command-line-runs-the-apps-agent-host-in-its-own-process-with-its-own-sessions.md) | The command line runs the app's agent host in its own process, with its own sessions | Accepted, builds on 0030, 0063 and 0106 |
| [0109](0109-what-the-first-tester-round-showed-edits-in-another-shape-longer-requests-full-access-and-a-chat-that-never-scrolls-sideways.md) | What the first tester round showed: edits in another shape, longer requests, Full access, and a chat that never scrolls sideways | Accepted, builds on 0009, 0063, 0089, 0097 and 0107 |
| [0110](0110-what-a-testers-diagnostics-showed-copy-a-folder-windows-will-not-let-the-sandbox-mark-small-screens-and-log-levels.md) | What a tester's diagnostics showed: Copy, a folder Windows will not let the sandbox mark, small screens, and log levels | Accepted, builds on 0063 and 0109; the one-click fix is built by 0118 |
| [0111](0111-a-folder-on-another-machine-opens-over-ssh-the-agent-works-there-and-the-keys-stay-on-the-pc.md) | A folder on another machine opens over SSH: the agent works there, and the keys stay on the PC | Accepted, builds on 0040, 0064, 0106 and 0108 |
| [0112](0112-the-dice-rolls-while-the-agent-works.md) | The dice rolls while the agent works | Accepted, builds on 0107; where the dice sits superseded by 0116 |
| [0113](0113-pictures-and-files-go-with-a-message.md) | Pictures and files go with a message: pasted, dropped or picked | Accepted, builds on 0054, 0069 and 0111 |
| [0114](0114-a-server-that-needs-a-toolchain-gets-one-in-encodes-own-folder.md) | A server that needs a toolchain gets one in eNCode's own folder | Accepted, builds on 0083; the C# and Go installs on Windows are fixed by 0119 |
| [0115](0115-a-finished-task-list-folds-away-and-the-thread-follows-until-you-scroll-up.md) | A finished task list folds away, and the thread follows until you scroll up | Accepted, builds on 0017 |
| [0116](0116-the-dice-rolls-under-the-latest-step.md) | The dice rolls under the latest step | Accepted, builds on 0112 and 0115 |
| [0117](0117-a-preset-is-known-by-the-model-that-answers-for-it.md) | A preset is known by the model that answers for it | Accepted, builds on 0035 and 0113 |
| [0118](0118-fix-this-folder-gives-your-account-full-control-after-an-administrators-yes.md) | Fix this folder gives your account Full control after an administrator's yes | Accepted, builds on 0063 and 0110 |
| [0119](0119-toolchain-installs-read-encodes-own-package-sources-and-clean-up-what-go-leaves-read-only.md) | Toolchain installs read eNCode's own package sources, and clean up what Go leaves read-only | Accepted, builds on 0114 |
| [0120](0120-the-computer-tool-opens-applications-from-the-start-menu-and-the-pointer-goes-where-it-acts.md) | The Computer tool opens applications from the Start menu, and the pointer goes where it acts | Accepted, builds on 0050 and 0054; numbers, grids and hit checks are added by 0121 |
| [0121](0121-the-computer-tool-numbers-what-it-shows-and-checks-what-it-hits.md) | The Computer tool numbers what it shows, and checks what it hits | Accepted, builds on 0050 and 0120 |
| [0122](0122-the-agent-finds-pages-before-it-fetches-them-and-duckduckgo-is-asked-one-search-at-a-time.md) | The agent finds pages before it fetches them, and DuckDuckGo is asked one search at a time | Accepted, builds on 0058; Parallel replaces DuckDuckGo as the default in 0123 |
| [0123](0123-parallel-answers-searches-for-free-and-a-free-tavily-key-is-offered-when-it-cannot.md) | Parallel answers searches for free, and a free Tavily key is offered when it cannot | Accepted, builds on 0058 and 0122 |
| [0124](0124-a-request-always-ends-with-words-for-the-person-also-at-the-step-limit.md) | A request always ends with words for the person, also at the step limit | Accepted, builds on 0095 and 0109 |
| [0125](0125-what-the-agent-waits-on-is-shown-and-the-task-list-moves-with-the-work.md) | What the agent waits on is shown, and the task list moves with the work | Accepted, builds on 0116 and 0124 |
| [0126](0126-the-agent-tells-its-work-and-checks-the-outcome-itself.md) | The agent tells its work, and checks the outcome itself | Accepted, builds on 0095, 0116 and 0124 |
| [0127](0127-tester-builds-update-themselves.md) | Tester builds update themselves | Accepted, builds on 0051 |
| [0128](0128-a-conversation-stays-where-its-cache-is-and-the-usage-page-says-how-much-was-cached.md) | A conversation stays where its cache is, and Usage says how much was cached | Accepted, builds on 0062 and 0094 |
| [0129](0129-a-cost-change-is-measured-beyond-noise-in-a-small-window-and-by-the-code-it-leaves.md) | A cost change is measured beyond noise, in a small window, and by the code it leaves | Accepted, builds on 0092 |
| [0130](0130-old-results-are-shortened-by-what-the-models-cache-charges.md) | Old results are shortened by what the model's cache charges | Accepted, builds on 0094 and 0128 |
| [0131](0131-long-tasks-measure-what-shortening-and-summaries-keep.md) | Long tasks measure what shortening and summaries keep | Accepted, builds on 0092, 0129 and 0130 |
| [0132](0132-a-session-counts-what-shortening-cut-and-keeps-more-when-the-model-reads-it-back.md) | A session counts what shortening cut, and keeps more when the model reads it back | Accepted, builds on 0093, 0095, 0130 and 0131 |
| [0133](0133-a-commands-output-reaches-the-model-as-a-digest-of-what-it-is.md) | A command's output reaches the model as a digest of what it is | Accepted, builds on 0093 and 0132 |

## Template

```markdown
# NNNN. Title in the imperative or as a statement

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context
What forces are at play, and what was wrong or missing.

## Decision
What we do, precisely enough to check code against it.

## Consequences
What gets easier, what gets harder, and what is still open.
```
