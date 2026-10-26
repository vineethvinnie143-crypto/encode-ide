/**
 * A tiny OpenAI-compatible streaming server used to test eNCode's real provider
 * path (SSE parsing, tool-call deltas, approval round-trips, command execution,
 * subagents) without an API key.
 *
 * Run standalone:  node scripts/fake-provider.mjs
 * Then add a profile in eNCode: base URL http://127.0.0.1:8787/v1, model mock-model
 *
 * Conversations follow a script. A `[scenario:<name>]` marker in the latest
 * user message picks it; the step is the number of tool results since then.
 * A message the person sent while the agent worked (eNCode marks it) belongs
 * to the request it came in during, so it neither picks a script nor resets
 * the count.
 * Like OpenAI, it refuses a transcript whose tool calls and results do not
 * pair up, and a request without tools is answered as a summary request,
 * unless it asks for the name of a session.
 */
import { createHash } from 'node:crypto'
import http from 'node:http'

const port = Number(process.env.FAKE_PROVIDER_PORT || 8787)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One word of about 900 characters: nowhere to break it. */
const WIDE = `start${Array.from({ length: 60 }, (_, index) => `_segment${String(index).padStart(2, '0')}`).join('')}_end`

/** A table of sixteen columns, wider than any thread. */
const WIDE_TABLE = [0, 1, 2]
  .map((row) => `| ${Array.from({ length: 16 }, (_, column) => (row === 1 ? '---' : `column ${column + 1} of the wide table`)).join(' | ')} |`)
  .join('\n')

// A step is the model's next message: some text, and a tool call when it has not finished yet.
// The calls use the tool names and inputs of the agent engine (Claude Code's contracts).
const SCENARIOS = {
  default: [
    {
      text: 'I will create provider-check.txt so we can verify the real provider path.',
      call: { name: 'Write', args: { file_path: 'provider-check.txt', content: 'hello from a real provider stream\n' } },
    },
    {
      text: 'File written. Running a command to verify the shell.',
      call: { name: 'Bash', args: { command: 'echo provider-command-ok' } },
    },
    {
      text: 'Provider path verified: streamed a tool call, wrote provider-check.txt, and ran a shell command.',
    },
  ],
  // More steps than the smoke's limit of two (ADR 0124): the reply after the last is asked for with tools off
  // (tool_choice none), and says how far the work got. Continue, as the step limit's button sends it, goes on with it.
  'step-limit': [
    { text: 'Listing the project.', call: { name: 'Glob', args: { pattern: '*' } } },
    { text: 'Listing the notes.', call: { name: 'Glob', args: { pattern: '**/*.md' } } },
    { text: 'Listing everything.', call: { name: 'Glob', args: { pattern: '**/*' } } },
    { text: 'Listed it all.' },
  ],
  // What the person sees while the agent waits (ADR 0125): the model's thinking under the live line, a clock on a command
  // that runs for a while, a blind wait refused, and the task list it left open brought up to date before it ends.
  waits: [
    {
      thinking: 'Reading the layout first, then the build. The build takes a few seconds, so the agent waits for it and checks the result.',
      thinkingDelayMs: 150,
      text: 'Planning the work.',
      call: {
        name: 'TodoWrite',
        args: {
          todos: [
            { content: 'Look at the project', status: 'in_progress', activeForm: 'Looking at the project' },
            { content: 'Wait for the build', status: 'pending', activeForm: 'Waiting for the build' },
          ],
        },
      },
    },
    { text: 'Waiting for the build.', call: { name: 'Bash', args: { command: 'sleep 7', description: 'Wait for the build' } } },
    { text: 'Waiting a while longer.', call: { name: 'Bash', args: { command: 'sleep 110', description: 'Wait two minutes' } } },
    {
      text: 'The build finished.',
      todoBack: {
        text: 'Bringing the task list up to date.',
        call: {
          name: 'TodoWrite',
          args: {
            todos: [
              { content: 'Look at the project', status: 'completed', activeForm: 'Looking at the project' },
              { content: 'Wait for the build', status: 'completed', activeForm: 'Waiting for the build' },
            ],
          },
        },
      },
    },
    { text: 'Looked at the project and waited for the build by checking for it.' },
  ],
  // The agent says what it found before each batch of steps, the chat folds each batch to a line, and an answer that
  // leaves a check to the person goes back once for the agent to make it (ADR 0126).
  story: [
    { text: 'Looking at the server notes first.', call: { name: 'Read', args: { file_path: 'README.md' } } },
    { text: 'The notes name port 7777. Next I probe both ports.', call: { name: 'Bash', args: { command: 'echo 7777-open', description: 'Probe the game port' } } },
    { text: '', call: { name: 'Bash', args: { command: 'echo 30001-closed' } } },
    {
      text: 'Port 7777 answers and 30001 does not. I have not tested a real join, so that last mile needs you.',
      handBack: { text: 'Joining as a test client to check it myself.', call: { name: 'Bash', args: { command: 'echo joined', description: 'Join as a test client' } } },
    },
    { text: 'Port 7777 answers and a test client joined it; 30001 has nothing listening.' },
  ],
  // A side chat's question (ADR 0104): one answer, which says what the copy of the conversation held.
  'side-check': [{ text: 'Side answer: the chat above wrote provider-check.txt.' }],
  // A file written with an error in it: the language server says so after the step, and the error gate sends the agent
  // back when it wants to finish, so it writes the file again without the error.
  'lsp-gate': [
    { text: 'Adding the gate module.', call: { name: 'Write', args: { file_path: 'src/lsp-gate.ts', content: 'export const gate = 1\nconst broken = ERROR\n' } } },
    {
      text: 'Done.',
      gated: { text: 'The language server reports an error in src/lsp-gate.ts; fixing it.', call: { name: 'Write', args: { file_path: 'src/lsp-gate.ts', content: 'export const gate = 1\n' } } },
    },
    { text: 'Added src/lsp-gate.ts; the language server reports no errors in it.' },
  ],
  // Test this model (ADR 0101) gives the benchmark's tasks, which carry no marker (see BENCH_PROMPTS): its two questions
  // and one change are made as the tasks want; its other tasks get the default script, which their checks fail.
  'bench-trace': [{ text: 'markPaid in orders/paid.js handles it; events/index.js hooks it up to order:paid.' }],
  'bench-session': [{ text: 'A session times out after 45 minutes, set by SESSION_TIMEOUT_MINUTES in config/session.js.' }],
  // One writing task done right, so a check runs on eNCode's own Node.js and passes.
  'bench-json': [
    { text: 'Reading the flags.', call: { name: 'Read', args: { file_path: 'config/features.json' } } },
    {
      text: 'Turning newCheckout on and adding fastShipping.',
      call: {
        name: 'Edit',
        args: {
          file_path: 'config/features.json',
          old_string: '    "newCheckout": { "enabled": false, "rollout": 0 },\n    "betaSearch": { "enabled": true, "rollout": 25 }\n',
          new_string: '    "newCheckout": { "enabled": true, "rollout": 10 },\n    "betaSearch": { "enabled": true, "rollout": 25 },\n    "fastShipping": { "enabled": false, "rollout": 0 }\n',
        },
      },
    },
    { text: 'newCheckout is on for 10%, and fastShipping is added, off with a rollout of 0.' },
  ],
  // The smoke makes this one fail on purpose (see /__fail), then lets it through when the person tries again.
  'retry-check': [{ text: 'Answered after trying again.' }],
  // The agent asks to plan first; the person says to go ahead.
  'plan-first': [
    { text: 'This touches several files, so a plan first.', call: { name: 'EnterPlanMode', args: { reason: 'The change touches several files.' } } },
    { text: 'Going ahead without a plan, as asked.' },
  ],
  // A PDF read by page, then a notebook read and one of its cells changed.
  'pdf-notebook': [
    { text: 'Reading the second page.', call: { name: 'Read', args: { file_path: 'smoke.pdf', pages: '2' } } },
    { text: 'Reading the notebook.', call: { name: 'Read', args: { file_path: 'smoke.ipynb' } } },
    { text: 'Changing the first cell.', call: { name: 'NotebookEdit', args: { notebook_path: 'smoke.ipynb', cell_id: '0', new_source: 'print(2)' } } },
    { text: 'Read page 2 and changed the cell.' },
  ],
  // The subagent's command must ask on the parent's card.
  'subagent-check': [
    {
      text: 'Delegating a shell check to a subagent.',
      call: {
        name: 'Task',
        args: {
          description: 'Shell check',
          prompt: '[scenario:subagent-command] Run echo subagent-command-ok and report back.',
          subagent_type: 'general-purpose',
        },
      },
    },
    { text: 'Delegation verified.' },
  ],
  'subagent-command': [
    { text: 'Running the check.', call: { name: 'Bash', args: { command: 'echo subagent-command-ok' } } },
    { text: 'Subagent ran the command.' },
  ],
  // A subagent in the background: the turn ends once it is started, its command asks on a card while no turn runs, and
  // its report starts a turn of its own (background-wake), which is no message of the person's.
  'background-check': [
    {
      text: 'Starting a subagent in the background.',
      call: {
        name: 'Task',
        args: {
          description: 'Background check',
          prompt: '[scenario:background-sub] Run echo background-sub-ok and report back.',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
      },
    },
    { text: 'Started it in the background.' },
  ],
  'background-sub': [
    { text: 'Running the check.', call: { name: 'Bash', args: { command: 'echo background-sub-ok', description: 'Echo a word' } } },
    { text: 'background-report-ok' },
  ],
  'background-wake': [{ text: 'The background check reported back.' }],
  // Started in Plan mode: the subagent must not be able to write either.
  'plan-escalation': [
    {
      text: 'Delegating to a subagent.',
      call: {
        name: 'Task',
        args: { description: 'Create a file', prompt: '[scenario:subagent-write] Create escalation.txt.', subagent_type: 'general-purpose' },
      },
    },
    { text: 'Plan mode delegation finished.' },
  ],
  // WebFetch asks once for a new site, then refuses it because localhost is a private address.
  'web-check': [
    {
      text: 'Fetching a page.',
      call: { name: 'WebFetch', args: { url: `http://localhost:${port}/health`, prompt: 'What does the page say?' } },
    },
    {
      text: 'Fetching another page on the same site.',
      call: { name: 'WebFetch', args: { url: `http://localhost:${port}/v1/models`, prompt: 'Which models are listed?' } },
    },
    { text: 'Web check finished.' },
  ],
  // WebSearch asks first, naming the host of the provider chosen in Settings. The check refuses it, so no search is sent.
  // The agent's debugger (ADR 0145): it loads the tool, starts the smoke's checkout with a breakpoint of its own (which
  // asks), reads a value at the stop and leaves the run paused for the person to see and stop.
  'debug-agent': [
    { text: 'Loading the debugger.', call: { name: 'ToolSearch', args: { query: 'select:Debug' } } },
    { text: 'Stopping where a line total is worked out, for the first item with more than three.', call: { name: 'Debug', args: { action: 'start', file: 'debug-cart.js', breakpoints: [{ file: 'debug-cart.js', line: 10, condition: 'item.qty > 3' }] } } },
    { text: 'Reading the quantity there.', call: { name: 'Debug', args: { action: 'evaluate', expression: 'item.qty * 2' } } },
    { text: 'The run stopped at Oat milk, whose quantity doubled is 8. It is still paused in the Debug tab.' },
  ],
  'search-check': [
    { text: 'Searching the web.', call: { name: 'WebSearch', args: { query: 'eNCode search check' } } },
    { text: 'Search check finished.' },
  ],
  'subagent-write': [
    { text: 'Creating the file.', call: { name: 'Write', args: { file_path: 'escalation.txt', content: 'must not exist\n' } } },
    { text: 'Subagent finished.' },
  ],
  // A command asks the first time. "Always allow" saves a rule for it, so the same command runs without asking, and a
  // different one still asks.
  'always-allow': [
    { text: 'Running the check.', call: { name: 'Bash', args: { command: 'echo always-allow-ok', description: 'Echo a word' } } },
    { text: 'Running it again.', call: { name: 'Bash', args: { command: 'echo always-allow-ok', description: 'Echo a word' } } },
    { text: 'Now another command.', call: { name: 'Bash', args: { command: 'echo another-command-ok', description: 'Echo another word' } } },
    { text: 'Always allow check finished.' },
  ],
  // The folder's hooks wait for trust, so nothing guards or logs this request; its file is what a later rewind leaves alone.
  'hooks-untrusted': [
    { text: 'Writing a note.', call: { name: 'Write', args: { file_path: 'untrusted-note.txt', content: 'written before the folder was trusted\n' } } },
    { text: 'Note written.' },
  ],
  // With the folder trusted its hooks apply: the log hook runs after each change of a file, and the guard refuses the
  // command before it can ask. The two files are what the rewind of this request puts back.
  'hooks-check': [
    { text: 'Reading the helpers.', call: { name: 'Read', args: { file_path: 'src/utils.ts' } } },
    { text: 'Changing add.', call: { name: 'Edit', args: { file_path: 'src/utils.ts', old_string: 'return a + b', new_string: 'return b + a' } } },
    { text: 'Adding a file.', call: { name: 'Write', args: { file_path: 'rewind-new.txt', content: 'created by the hooks check\n' } } },
    { text: 'Running a command.', call: { name: 'Bash', args: { command: 'echo guarded-command-ran', description: 'Echo a word' } } },
    { text: 'Hooks check finished.' },
  ],
  // The Computer tool lists the windows (nothing to approve), then a command waits for the person: the banner that says the
  // agent uses the computer reads "waiting" meanwhile, and its Stop button or Ctrl+Alt+Esc ends the turn (Windows only).
  'computer-check': [
    { text: 'Looking at what is open.', call: { name: 'Computer', args: { action: 'windows' } } },
    { text: 'Now a command.', call: { name: 'Bash', args: { command: 'echo computer-check-ok' } } },
    { text: 'Computer check finished.' },
  ],
  // The Browser tool in the chat's own tab (ADR 0103): a form filled and sent, a confirm dialog answered by itself, a
  // password field refused, a link to another site held back, a link on the same host followed, and the console read.
  'browser-check': [
    { text: 'Opening the app.', call: { name: 'Browser', args: { action: 'open', url: `http://127.0.0.1:${port}/__browser/app` } } },
    { text: 'Typing a name.', call: { name: 'Browser', args: { action: 'type', ref: 'e1', text: 'Ada' } } },
    { text: 'Choosing a size.', call: { name: 'Browser', args: { action: 'select', ref: 'e2', value: 'Large' } } },
    { text: 'Greeting.', call: { name: 'Browser', args: { action: 'click', ref: 'e3' } } },
    { text: 'Trying the secret field.', call: { name: 'Browser', args: { action: 'type', ref: 'e6', text: 'hunter2' } } },
    { text: 'Following the link elsewhere.', call: { name: 'Browser', args: { action: 'click', ref: 'e5' } } },
    { text: 'Following the next link.', call: { name: 'Browser', args: { action: 'click', ref: 'e4' } } },
    { text: 'Reading the console.', call: { name: 'Browser', args: { action: 'console' } } },
    { text: 'Browser check finished.' },
  ],
  // A tool of an MCP server asks like any tool. "Always allow" saves a rule for that tool alone: the same tool then runs
  // without asking, and the server's other tool still asks.
  'mcp-check': [
    { text: 'Calling the server.', call: { name: 'mcp__fake__echo', args: { text: 'mcp-check-ok' } } },
    { text: 'Calling it again.', call: { name: 'mcp__fake__echo', args: { text: 'mcp-check-again' } } },
    { text: 'Now the other tool.', call: { name: 'mcp__fake__add', args: { a: 2, b: 3 } } },
    { text: 'MCP check finished.' },
  ],
  // Under Auto review a second model call, the Reviewer (answered by reviewerAnswer below), is asked about each command the
  // assessor could not prove read-only: it approves the first, declines the second and passes the third to the person.
  // The fixed checks keep the force-push for the person without asking the Reviewer at all.
  'auto-review': [
    { text: 'Writing the first note.', call: { name: 'Bash', args: { command: 'echo review-approved > review-approved.txt', description: 'Write a note' } } },
    { text: 'Writing the second note.', call: { name: 'Bash', args: { command: 'echo review-declined > review-declined.txt', description: 'Write another note' } } },
    { text: 'Writing the third note.', call: { name: 'Bash', args: { command: 'echo review-asked > review-asked.txt', description: 'Write a third note' } } },
    { text: 'Now publishing.', call: { name: 'Bash', args: { command: 'git push --force origin main', description: 'Publish' } } },
    { text: 'Auto review check finished.' },
  ],
  // A second request in a session that already finished a task or was stopped.
  'follow-up': [{ text: 'Follow-up handled.' }],
  // The command asks first, and the person sends messages while its card waits. The request takes them with the
  // command's result, and the next answer repeats the last one, so the smoke can tell the model read it.
  'steer-check': [
    { text: 'Running the check.', call: { name: 'Bash', args: { command: 'echo steer-check-ok', description: 'Echo a word' } } },
    { text: 'Steer check finished.', answersSteer: true },
  ],
  // The message mentions src/utils.ts with @, so the file comes with it and counts as read: an Edit works without a Read first.
  'mention-check': [
    { text: 'Swapping the operands.', call: { name: 'Edit', args: { file_path: 'src/utils.ts', old_string: 'return a + b', new_string: 'return b + a' } } },
    { text: 'Mention check finished.' },
  ],
  // A change to code, then a reply that says the tests pass: eNCode runs the demo's npm test before the turn ends (ADR 0095).
  'check-gate': [
    { text: 'Reading it first.', call: { name: 'Read', args: { file_path: 'src/utils.ts' } } },
    { text: 'Swapping them.', call: { name: 'Edit', args: { file_path: 'src/utils.ts', old_string: 'return a * b', new_string: 'return b * a' } } },
    { text: 'Swapped them; all tests pass.' },
  ],
  // A change that divides by an empty list's length: the Reviewer finds it before the person sees the reply (ADR 0096).
  'review-gate': [
    {
      text: 'Adding it.',
      call: { name: 'Write', args: { file_path: 'src/average.ts', content: 'export function average(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0) / values.length\n}\n' } },
    },
    {
      text: 'Added average in src/average.ts.',
      reviewed: {
        text: 'The Reviewer is right; an empty list now gives 0.',
        call: {
          name: 'Write',
          args: { file_path: 'src/average.ts', content: 'export function average(values: number[]): number {\n  if (values.length === 0) return 0\n  return values.reduce((sum, value) => sum + value, 0) / values.length\n}\n' },
        },
      },
    },
    { text: 'Added average in src/average.ts; an empty list gives 0.' },
  ],
  // A recursive delete the request did not ask for, under Full access: the model's second look does not confirm it,
  // so the person decides (ADR 0097). Detected the same in bash and PowerShell; the smoke denies it.
  'second-look': [
    { text: 'Clearing out the old folder first.', call: { name: 'Bash', args: { command: 'Remove-Item -Recurse -Force src/legacy', description: 'Delete the old folder' } } },
    { text: 'Left src/legacy in place and tidied the README.' },
  ],
  // A standing rule in the request: after the answer, lines for ENCODE.md are offered (ADR 0097).
  conventions: [{ text: 'Understood: pnpm from now on.' }],
  // Best of N (ADR 0098): each attempt writes src/best.ts its own way, by the number in its instructions; the first
  // subtracts, the second adds, and the Reviewer picks the second.
  'best-of': [
    { text: 'Writing it.', attempt: (n) => ({ name: 'Write', args: { file_path: 'src/best.ts', content: `export function sum(a: number, b: number): number {\n  return a ${n === 2 ? '+' : '-'} b\n}\n` } }) },
    { text: 'Wrote sum in src/best.ts.' },
  ],
  // A smaller model's first change, with no word of what it changes: eNCode holds it until the model says (ADR 0100).
  'think-first': [
    { text: 'Adding it.', call: { name: 'Write', args: { file_path: 'src/planned.ts', content: 'export const planned = true\n' } } },
    {
      text: 'I will add one file, src/planned.ts, exporting planned; nothing else changes, and the typecheck covers it.',
      call: { name: 'Write', args: { file_path: 'src/planned.ts', content: 'export const planned = true\n' } },
    },
    { text: 'Added src/planned.ts.' },
  ],
  // Two setbacks: the same edit that matches nothing, twice, and another to the same file. eNCode asks whether the Plan
  // role's strong model may read the steps (ADR 0140); the smoke says yes, and it answers. Two more setbacks, and eNCode
  // asks whether that model may finish the request; the smoke says yes, and that model answers (ADR 0100).
  stronger: [
    { text: 'Reading it.', call: { name: 'Read', args: { file_path: 'src/utils.ts' } } },
    { text: 'Changing it.', call: { name: 'Edit', args: { file_path: 'src/utils.ts', old_string: 'return a + c', new_string: 'return a + b' } } },
    { text: 'Again.', call: { name: 'Edit', args: { file_path: 'src/utils.ts', old_string: 'return a + c', new_string: 'return a + b' } } },
    { text: 'Another way.', call: { name: 'Edit', args: { file_path: 'src/utils.ts', old_string: 'return a + d', new_string: 'return a + b' } } },
    { text: 'Trying what it said.', call: { name: 'Edit', args: { file_path: 'src/utils.ts', old_string: 'return a + e', new_string: 'return a + b' } } },
    { text: 'Again.', call: { name: 'Edit', args: { file_path: 'src/utils.ts', old_string: 'return a + e', new_string: 'return a + b' } } },
    { text: 'Once more.', call: { name: 'Edit', args: { file_path: 'src/utils.ts', old_string: 'return a + f', new_string: 'return a + b' } } },
    { text: 'Again.', call: { name: 'Edit', args: { file_path: 'src/utils.ts', old_string: 'return a + f', new_string: 'return a + b' } } },
    { text: 'src/utils.ts has no such line to change; it already reads as asked, so nothing was changed.' },
  ],
  // A long answer streamed slowly enough (about 25 pieces a second) to be stopped halfway, for Esc twice.
  'slow-reply': [{ text: longReply(), streamDelayMs: 40 }],
  // A long markdown answer streamed in small pieces at about 300 a second, for scripts/perf.mjs.
  'long-reply': [{ text: longReply(), streamDelayMs: 3 }],
  // A task list the agent finishes, then a long answer in many small pieces (ADR 0115): the finished list folds away
  // under the thread, and the thread follows the answer to its end.
  'follow-tasks': [
    { text: 'Three steps.', call: { name: 'TodoWrite', args: { todos: followTasks('pending') } } },
    { text: 'All three are done.', call: { name: 'TodoWrite', args: { todos: followTasks('completed') } } },
    { text: longReply(), streamDelayMs: 3 },
  ],
  // Lines far wider than the thread: the diff, the file read back, the command and its output scroll in their own boxes,
  // and the chat never scrolls sideways.
  'wide-lines': [
    { text: 'Writing the long line.', call: { name: 'Write', args: { file_path: 'wide.txt', content: `${WIDE}\n` } } },
    { text: 'Reading it back.', call: { name: 'Read', args: { file_path: 'wide.txt' } } },
    { text: 'Changing its first word.', call: { name: 'Edit', args: { file_path: 'wide.txt', old_string: WIDE, new_string: WIDE.replace('start', 'begin') } } },
    { text: 'Printing it.', call: { name: 'Bash', args: { command: `echo ${WIDE}` } } },
    { text: `Done. wide.txt now holds ${WIDE.replace('start', 'begin')}\n\n${WIDE_TABLE}` },
  ],
  // The fourth request is refused as too long: the first two steps wrote and read back a long survey, and the model's
  // window is only the instructions and tools plus a little more. The older steps are summarized and the survey's
  // output is shortened, so the compacted transcript fits.
  overflow: [
    { text: 'Writing down what is here.', call: { name: 'Write', args: { file_path: 'survey.txt', content: survey() } } },
    { text: 'Reading it back.', call: { name: 'Read', args: { file_path: 'survey.txt' } } },
    { text: 'Looking around once more.', call: { name: 'Glob', args: { pattern: '**/*' } } },
    { text: 'Compaction verified.', overflowUntilCompacted: true },
  ],
}

/** About 36 KB of notes, enough to outgrow the window of the overflow scenario. */
function survey() {
  return Array.from({ length: 400 }, (_, index) => `Note ${String(index + 1).padStart(3, '0')}: the workspace was surveyed before reading anything, and nothing here needed changing.`).join('\n') + '\n'
}

/** Tokens as this server counts them: about three and a half characters each. */
const tokensOf = (text) => Math.ceil(text.length / 3.5)

/**
 * The window of the model in the overflow scenario: what any request needs (the instructions, the tools and the first
 * message) and room for a summary and the latest steps. Instructions and tools are most of a small request, so a
 * window taken as a share of the whole request would leave no room for them once the conversation is compacted.
 */
function overflowWindow(body, messages) {
  const first = messages.find((message) => message.role === 'user')
  const base = { ...body, messages: [...messages.filter((message) => message.role === 'system'), ...(first ? [first] : [])] }
  return tokensOf(JSON.stringify(base)) + 6_000
}

/**
 * A long answer full of markdown (about 1,200 words: headings, lists, tables, code, quotes), for measuring how the
 * thread copes with a big streamed reply. Deterministic, so two runs are comparable.
 */
/** The three items of the follow-tasks list, the first under way unless all are `status`. */
function followTasks(status) {
  return [
    ['Read the notes', 'Reading the notes'],
    ['Write the review', 'Writing the review'],
    ['Check the review', 'Checking the review'],
  ].map(([content, activeForm], index) => ({ content, activeForm, status: status === 'pending' && index === 0 ? 'in_progress' : status }))
}

function longReply() {
  const topics = ['parser', 'scheduler', 'cache', 'router', 'renderer', 'store', 'watcher', 'planner']
  const out = ['# A long review']
  topics.forEach((topic, index) => {
    const n = index + 1
    out.push(
      `## ${n}. The ${topic}`,
      `The ${topic} keeps its state in a small \`Map\` and **never reads it twice**: a second read would see work that is *already half done*, and the ${topic} would have to decide again what the first read meant. See [the notes](https://example.com/${topic}) for the long version, which goes through every case one by one and says what each costs.`,
      `- It starts from the value the caller passed, never from a copy of it\n- It writes each result once, in the order the calls arrived\n- It gives the next call the answer of the last one when nothing changed\n- It drops anything older than \`${n * 30}\` seconds`,
      `1. Read the input once\n2. Check it against the last result\n3. Do the work only when it differs\n4. Hand back the result and the reason`,
      `| Case | Cost | Notes |\n| --- | --- | --- |\n| Cold | ${n * 12} ms | Everything is built from nothing |\n| Warm | ${n} ms | Only what changed is built |\n| Same | 0 ms | The last result is handed back |`,
      '```ts\n' +
        `export function ${topic}(input: Input, last?: Result): Result {\n` +
        `  if (last && same(input, last.input)) return last\n` +
        `  const next = build(input, last)\n` +
        `  cache.set(input.id, next)\n` +
        `  return next\n` +
        `}\n\n` +
        `function same(a: Input, b: Input): boolean {\n` +
        `  return a.id === b.id && a.revision === b.revision\n` +
        `}\n` +
        '```',
      `> The ${topic} is the part that is easiest to get wrong and hardest to notice: when it is wrong everything still works, only slower.`,
    )
  })
  out.push('## Summary', 'Eight parts, one idea: **do the work once, and say so when you did not.**')
  return out.join('\n\n')
}

let requestCount = 0
/** The Authorization header of the latest chat request, so the smoke can check keys reach the provider. */
let lastAuthorization = null
/** The tools offered and the messages sent in the latest request that offered tools, so the smoke can check the contract. */
let lastRequest = null
/** The latest request of the Reviewer: what it was given, so the smoke can check it sees little and has no tools. */
let lastReviewer = null
/** The latest request of Ask the Reviewer, for the smoke to check what it was sent. */
let lastCodeReview = null
let lastCompletionReview = null
let lastSecondLook = null
let lastStuckSteps = null
let lastConventions = null
let lastBestOf = null
/** The latest suggestion asked for as you type, for the smoke to check what was sent. */
let lastInline = null
const stats = { closingRequests: 0, summaryRequests: 0, titleRequests: 0, overflowRefusals: 0, invalidTranscripts: 0, reviewerRequests: 0, codeReviews: 0, completionReviews: 0, inlineRequests: 0, secondLooks: 0, stuckSteps: 0, conventionRequests: 0, bestOfRequests: 0 }
/**
 * How the retry-check script fails until the smoke says otherwise (POST /__fail/<mode>): 'auth' refuses the key with
 * a provider's usual JSON, a key-shaped string in it; 'empty' sends replies with nothing in them; 'off' answers.
 */
let failMode = 'off'
/** Shaped like a key, so eNCode must take it out of what it shows; not the format of any real provider's keys. */
const LEAKED_KEY = 'sk-smoke-not-a-real-key-0123456789'

// Deterministic usage so the smoke suite can assert totals and cache-hit %.
// The first request has no cache; later ones report a cached portion.
function fakeUsage() {
  requestCount += 1
  const promptTokens = 100 + requestCount * 10
  const completionTokens = 24 + requestCount
  const cachedTokens = requestCount > 1 ? Math.floor(promptTokens / 2) : 0
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cachedTokens },
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A plain text answer, streamed or not, with no tool calls. `delayMs` spaces the pieces of a streamed one. */
async function sendText(response, body, text, delayMs = 0) {
  if (!body.stream) {
    sendJson(response, 200, {
      id: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: fakeUsage(),
    })
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  // A client that stops reading (Stop in eNCode) closes the connection: nothing more is written to it.
  let gone = false
  response.on('close', () => (gone = true))
  for (const part of text.match(/\S+\s*/g) ?? []) {
    if (gone) return
    response.write(chunk({ content: part }))
    if (delayMs) await delay(delayMs)
  }
  if (gone) return
  response.write(chunk({}, 'stop'))
  response.write('data: [DONE]\n\n')
  response.end()
}

function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: 'mock',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

/** What eNCode puts before a message the person sent while the agent worked. */
const STEERED = 'sent the message below while you were working'
const isSteer = (message) => message.role === 'user' && textOf(message.content).includes(STEERED)

/**
 * What eNCode tells the model within a turn of what the language servers or the Reviewer found, that a stronger model
 * takes over, to carry on after a compaction, or that the step limit is reached: the turn goes on.
 */
const LANGUAGE_SERVER_NEWS = [
  'The language servers found errors after your changes',
  'The language servers checked your changes again',
  'Before you finish: your changes this turn left errors',
  'The Reviewer read your changes before the person sees them',
  'A stronger model does the rest of this request',
  'You ran into trouble more than once, so',
  'The conversation was just compacted to fit the context window',
  'That was the last step this request may take',
  'Your answer took the last step this request may take',
  'Steps left in this request:',
  'Before you finish: the task list the person sees',
  'Your answer leaves a check to the user',
  'Your answer leaves a result of the code as it is',
  'The task list the person sees has not changed',
]
const GATED = 'Before you finish: your changes this turn left errors'
const TODO_BACK = 'Before you finish: the task list the person sees'
const HAND_BACK = 'Your answer leaves a check to the user'
const REVIEWED = 'The Reviewer read your changes before the person sees them'
function isLanguageServerNews(message) {
  if (message.role !== 'user') return false
  const text = textOf(message.content)
  if (!text.includes('<system-reminder>')) return false
  const rest = text.replace(/<system-reminder>\n([\s\S]*?)\n<\/system-reminder>/g, (all, inner) => (LANGUAGE_SERVER_NEWS.some((start) => inner.startsWith(start)) ? '' : all))
  return !rest.trim()
}

/**
 * The latest request of the person's: a message sent while the agent worked is part of the request before it, and so
 * is what the language servers said of its changes.
 */
function lastUserIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === 'user' && !isSteer(message) && !isLanguageServerNews(message)) return index
  }
  return -1
}

/** The last thing the person said while the agent worked: the last paragraph of the latest such message. */
function lastSteer(messages) {
  const message = messages.findLast(isSteer)
  return message ? textOf(message.content).split('\n\n').at(-1).trim() : ''
}

/** What eNCode tells the model when background work it started reports in a turn of its own. */
const BACKGROUND_NEWS = 'Background work you started reports (the user did not write this)'

/** The benchmark's questions, by the start of their prompts, and the script that answers each. */
const BENCH_PROMPTS = [
  ['When an order:paid event fires, which function handles it', 'bench-trace'],
  ["How long is a user's session before it times out", 'bench-session'],
  ['In config/features.json, turn newCheckout on for 10% of users', 'bench-json'],
]

/** What a request asked with tools off says (ADR 0124): how far the work got, in the words of an agent at its step limit. */
const CLOSING = 'Stopped at the step limit: listed the project and its notes; listing everything is left.'

function scenarioOf(messages) {
  const index = lastUserIndex(messages)
  const content = messages[index]?.content
  // Continue, as the step limit's button sends it (ADR 0124), carries on the request before it.
  if (textOf(content).trim() === 'Continue.' && index > 0) return scenarioOf(messages.slice(0, index))
  // In parts when eNCode put a note before the person's words (the environment, on a session's first request).
  const match = /\[scenario:([a-z-]+)\]/.exec(textOf(content))
  if (match && SCENARIOS[match[1]]) return match[1]
  const bench = BENCH_PROMPTS.find(([prompt]) => textOf(content).includes(prompt))
  if (bench) return bench[1]
  // A turn of background news continues the request before it.
  return textOf(content).includes(BACKGROUND_NEWS) && textOf(content).includes('background-report-ok') ? 'background-wake' : 'default'
}

/** True once eNCode has put a summary in the conversation (the system prompt only mentions the tag). */
const compacted = (messages) =>
  messages.some(
    (message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('<conversation_summary>'),
  )

function stepOf(messages) {
  const script = SCENARIOS[scenarioOf(messages)]
  // Compacting drops the tool results the step count is made of, so a conversation that was compacted is at the end.
  if (script.at(-1)?.overflowUntilCompacted && compacted(messages)) return script.at(-1)
  const done = messages.slice(lastUserIndex(messages) + 1).filter((message) => message.role === 'tool').length
  const step = script[Math.min(done, script.length - 1)]
  if (step.attempt) return { text: step.text, call: step.attempt(attemptOf(messages)) }
  // Sent back by the error gate: the step it has for that.
  const last = messages.at(-1)
  if (step.gated && last?.role === 'user' && textOf(last.content).includes(GATED)) return step.gated
  // Sent back to bring the task list up to date before it ends (ADR 0125).
  if (step.todoBack && last?.role === 'user' && textOf(last.content).includes(TODO_BACK)) return step.todoBack
  // Sent back to make the check its answer left to the person (ADR 0126).
  if (step.handBack && last?.role === 'user' && textOf(last.content).includes(HAND_BACK)) return step.handBack
  // Sent back by the Reviewer before the person sees the reply (ADR 0096).
  return step.reviewed && last?.role === 'user' && textOf(last.content).includes(REVIEWED) ? step.reviewed : step
}

/** What OpenAI would refuse in a transcript, or null. */
function pairingProblem(messages) {
  let index = 0
  while (index < messages.length && messages[index].role === 'system') index++
  if (index < messages.length && messages[index].role !== 'user') return 'the first message after the system prompt must be the user\'s'
  for (; index < messages.length; index++) {
    const message = messages[index]
    if (message.role === 'system') return `a system message at position ${index}`
    if (message.role === 'tool') {
      return `messages with role 'tool' must be a response to a preceeding message with 'tool_calls' (position ${index})`
    }
    if (message.role !== 'assistant') continue
    if (Array.isArray(message.tool_calls) && !message.tool_calls.length) return `empty tool_calls at position ${index}`
    const ids = (message.tool_calls ?? []).map((call) => call.id)
    const answered = new Set()
    while (messages[index + 1]?.role === 'tool') {
      const id = messages[++index].tool_call_id
      if (!ids.includes(id) || answered.has(id)) return `an unexpected tool result for ${id}`
      answered.add(id)
    }
    const missing = ids.filter((id) => !answered.has(id))
    if (missing.length) {
      return `An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. The following tool_call_ids did not have response messages: ${missing.join(', ')}`
    }
  }
  return null
}

/** The call of the Reviewer: Auto review asks a model whether a command is low risk and part of what the user asked. */
const REVIEWER_SYSTEM = 'You are the Reviewer for a coding agent.'
const isReviewer = (messages) => messages.some((message) => message.role === 'system' && JSON.stringify(message.content ?? '').includes(REVIEWER_SYSTEM))

const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((part) => part?.text ?? '').join('') : '')

/** The verdict by the command in the action block: the scenario names its files after the answer it wants. */
function reviewerAnswer(user) {
  const action = /<action-[0-9a-f]+>\n([\s\S]*?)\n<\/action-[0-9a-f]+>/.exec(user)
  let command = ''
  try {
    command = String(JSON.parse(action?.[1] ?? '{}').command ?? '')
  } catch {
    /* an action block the Reviewer cannot read gets the cautious answer */
  }
  if (command.includes('review-approved')) return JSON.stringify({ verdict: 'approve', risk: 'low', reason: 'It writes a note in the project, as you asked.' })
  if (command.includes('review-declined')) return JSON.stringify({ verdict: 'decline', risk: 'medium', reason: 'Nothing you asked for needs this file.' })
  return JSON.stringify({ verdict: 'ask', risk: 'medium', reason: 'It writes a file you did not mention.' })
}

/** Ask the Reviewer: one call with the change, each line numbered as in its file, and no tools. */
const CODE_REVIEWER = 'You are the Reviewer. A developer asks you to review a code change'
const isCodeReview = (messages) => messages.some((message) => message.role === 'system' && textOf(message.content).includes(CODE_REVIEWER))

/** A finding on the first added line of the first file the change shows, the way a model answers. */
function codeReviewAnswer(user) {
  const file = /<file path=("(?:[^"\\]|\\.)*")[^>]*>\n([\s\S]*?)\n<\/file>/.exec(user)
  const added = file ? /^\+(\d+) \| (.*)$/m.exec(file[2]) : null
  if (!file || !added) return JSON.stringify({ summary: 'There are no changed lines to judge.', findings: [] })
  const path = JSON.parse(file[1])
  return `Here is my review.\n\`\`\`json\n${JSON.stringify({
    summary: 'The change adds a counter; one line of it can divide by zero.',
    findings: [
      { file: path, line: Number(added[1]), priority: 'P1', title: 'Divides by zero when the list is empty', body: `Line ${added[1]} divides by the length of a list that can be empty. Return early when it is.` },
      { file: `b/${path}`, line: Number(added[1]), priority: 'P3', title: 'The counter is never reset', body: 'Reset it where the list is cleared.' },
      { file: 'not/in/the/change.ts', line: 3, priority: 'P0', title: 'A file the change does not touch', body: 'eNCode drops a finding on a file it did not send.' },
    ],
  })}\n\`\`\``
}

/** The Reviewer before the agent finishes (ADR 0096): the request, the reply and the change, and no tools. */
const COMPLETION_REVIEWER = 'You are the Reviewer. A coding agent has just finished'
const isCompletionReview = (messages) => messages.some((message) => message.role === 'system' && textOf(message.content).includes(COMPLETION_REVIEWER))

/** A P1 where the change divides by a list's length, and a P3 that stays with the Reviewer; nothing on a guarded one. */
function completionReviewAnswer(user) {
  const file = /<file path=("(?:[^"\\]|\\.)*")[^>]*>\n([\s\S]*?)\n<\/file>/.exec(user)
  const divides = file ? /^\+(\d+) \| .*\/ values\.length/m.exec(file[2]) : null
  if (!file || !divides || /^\+\d+ \| .*values\.length === 0/m.test(file[2])) return JSON.stringify({ summary: 'The change does what the request asks.', findings: [], untested: [] })
  return `\`\`\`json\n${JSON.stringify({
    summary: 'average divides by the length of a list that can be empty.',
    findings: [
      { file: JSON.parse(file[1]), line: Number(divides[1]), priority: 'P1', title: 'An empty list gives NaN', body: 'values.length is 0 for an empty list, so the result is NaN. Return 0 first.' },
      { file: JSON.parse(file[1]), line: 1, priority: 'P3', title: 'No doc comment', body: 'Say what an empty list gives.' },
    ],
    untested: [],
  })}\n\`\`\``
}

/** A stronger model's look at the steps of a stuck agent (ADR 0140): the requests, what went wrong, the steps, no tools. */
const STUCK_STEPS = 'You are a senior engineer helping a coding agent that is stuck.'
const isStuckSteps = (messages) => messages.some((message) => message.role === 'system' && textOf(message.content).includes(STUCK_STEPS))
const STUCK_ADVICE = 'src/utils.ts has no `return a + c`: the Edit copies a line the file does not have.\n\n1. Read src/utils.ts again.\n2. Copy the line it has into old_string.'

/** The second look before a hard-to-undo command (ADR 0097): the requests, the command and why, no tools. */
const SECOND_LOOK = 'A coding agent is about to run a shell command that cannot easily be undone.'
const isSecondLook = (messages) => messages.some((message) => message.role === 'system' && textOf(message.content).includes(SECOND_LOOK))

/** No to the smoke's recursive delete, which the request does not ask for; yes to anything else. */
function secondLookAnswer(user) {
  if (/<command-[0-9a-f]+>\n[^\n]*src\/legacy/.test(user)) return JSON.stringify({ run: false, reason: 'The request is to tidy the README; deleting src/legacy goes further than that.' })
  return JSON.stringify({ run: true, reason: 'The request asks for it.' })
}

/** What a request taught, for the instructions file (ADR 0097): the messages, failed commands and the file now. */
const CONVENTIONS = "You keep a project's instructions file"
const isConventions = (messages) => messages.some((message) => message.role === 'system' && textOf(message.content).includes(CONVENTIONS))

/** Best of N's verdict (ADR 0098): every attempt's reply, checks and change, no tools. */
const BEST_OF = 'A coding agent made several attempts at one request'
const isBestOf = (messages) => messages.some((message) => message.role === 'system' && textOf(message.content).includes(BEST_OF))
/** The attempt a request comes from, by the note in its instructions; 0 for the main agent. */
const attemptOf = (messages) => Number(/and this is attempt (\d+)\./.exec(messages.filter((message) => message.role === 'system').map((message) => textOf(message.content)).join('\n'))?.[1] ?? 0)

/** The editor's call for a suggestion as you type (ADR 0087): no tools, the file with <cursor/> in it. */
const INLINE_SYSTEM = 'You are the autocomplete of a code editor.'
const isInline = (messages) => messages.some((message) => message.role === 'system' && textOf(message.content).includes(INLINE_SYSTEM))

/**
 * What goes at the cursor. Only the smoke's own file gets a suggestion, so typing in every other check sees none and
 * Tab there keeps its meaning: after `return ` the sum, and a whole line in an empty line, as a model writes them.
 */
function inlineAnswer(user) {
  const file = /<file path="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/file>/.exec(user)
  if (!file || !file[1].endsWith('ghost-check.ts')) return ''
  const before = file[2].split('<cursor/>')[0]
  const line = before.slice(before.lastIndexOf('\n') + 1)
  if (/return $/.test(line)) return 'a + b'
  if (!line.trim()) return `${line}// ghost check\n${line}return a + b`
  return ''
}

/** The small call that names a session once its first turn is over. */
const namesSession = (messages) =>
  messages.some((message) => JSON.stringify(message.content ?? '').includes('You name a coding conversation'))

/**
 * A tester build's release (ADR 0127) for the smoke's updates part: the app goes by build ENCODE_UPDATE_AS_BUILD,
 * and the release is that same build until the smoke publishes the next one. Its installer is a stand-in, sent in a
 * few pieces so the download has a moment to show.
 */
const UPDATE_INSTALLER = Buffer.from(`MZ${'eNCode smoke installer '.repeat(20_000)}`)
const UPDATE_SHA256 = createHash('sha256').update(UPDATE_INSTALLER).digest('hex')
let updateBuild = Number(process.env.ENCODE_UPDATE_AS_BUILD || 41)
const updateManifest = () => ({
  schema: 1,
  channel: 'tester',
  version: '0.1.0',
  build: updateBuild,
  commit: 'c0ffee'.padEnd(40, '0'),
  publishedAt: '2026-10-25T14:00:00Z',
  notes: ['The agent tells its work and checks the outcome itself (#90)', 'Tester builds update themselves (#91)'],
  installer: { name: 'eNCode-0.1.0-setup.exe', size: UPDATE_INSTALLER.length, sha256: UPDATE_SHA256 },
})

async function sendUpdateInstaller(response) {
  response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': UPDATE_INSTALLER.length })
  const piece = Math.ceil(UPDATE_INSTALLER.length / 8)
  for (let at = 0; at < UPDATE_INSTALLER.length; at += piece) {
    response.write(UPDATE_INSTALLER.subarray(at, at + piece))
    await delay(150)
  }
  response.end()
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/encode-update.json') {
      sendJson(response, 200, updateManifest())
      return
    }
    if (request.url === '/__update/publish' && request.method === 'POST') {
      updateBuild += 1
      sendJson(response, 200, { build: updateBuild, sha256: UPDATE_SHA256 })
      return
    }
    if (request.url === `/download/build-${updateBuild}/eNCode-0.1.0-setup.exe`) {
      await sendUpdateInstaller(response)
      return
    }
    if (request.url === '/health') {
      sendJson(response, 200, { ok: true })
      return
    }
    if (request.url === '/__last-authorization') {
      sendJson(response, 200, { authorization: lastAuthorization })
      return
    }
    if (request.url === '/__last-request') {
      sendJson(response, 200, lastRequest)
      return
    }
    if (request.url === '/__last-reviewer') {
      sendJson(response, 200, lastReviewer)
      return
    }
    if (request.url === '/__last-inline') {
      sendJson(response, 200, lastInline)
      return
    }
    if (request.url === '/__last-code-review') {
      sendJson(response, 200, lastCodeReview)
      return
    }
    if (request.url === '/__last-completion-review') {
      sendJson(response, 200, lastCompletionReview)
      return
    }
    if (request.url === '/__last-second-look') {
      sendJson(response, 200, lastSecondLook)
      return
    }
    if (request.url === '/__last-stuck-steps') {
      sendJson(response, 200, lastStuckSteps)
      return
    }
    if (request.url === '/__last-conventions') {
      sendJson(response, 200, lastConventions)
      return
    }
    if (request.url === '/__last-best-of') {
      sendJson(response, 200, lastBestOf)
      return
    }
    if (request.url?.startsWith('/__fail/') && request.method === 'POST') {
      failMode = request.url.slice('/__fail/'.length)
      sendJson(response, 200, { failMode })
      return
    }
    if (request.url === '/__stats') {
      sendJson(response, 200, stats)
      return
    }
    // A page that forbids being framed, twice over, for the Browser tab. Its CSP also blocks scripts: the
    // tab may drop frame-ancestors, and nothing else, from the policy.
    if (request.url === '/__frame/denied') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      })
      response.end(
        '<!doctype html><title>Framed page</title><body style="margin:0;padding:24px;background:#0b3d5c;color:#fff;font:28px sans-serif">Framed page<script>document.title = "Script ran"</script></body>',
      )
      return
    }
    // The app the Browser check drives: its outline lists the name field (e1), the size list (e2), Greet (e3), the next
    // page (e4), the link elsewhere (e5) and the secret field (e6), in that order.
    if (request.url === '/__browser/app') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><title>Greeter</title>
<body style="font:15px sans-serif;padding:16px">
<h1>Greeter</h1>
<label>Name <input id="name"></label>
<select id="size" aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>
<button id="greet">Greet</button>
<p id="out"></p>
<p><a href="/__browser/next">Next page</a> <a href="https://example.com/elsewhere">Elsewhere</a></p>
<label>Secret <input type="password" id="secret"></label>
<script>
console.error('smoke: a console error')
document.getElementById('greet').addEventListener('click', () => {
  const sure = confirm('Greet them?')
  document.getElementById('out').textContent = (sure ? 'Hello, ' : 'Not greeted, ') + document.getElementById('name').value + ' (' + document.getElementById('size').value + ')'
})
</script>
</body>`)
      return
    }
    if (request.url === '/__browser/next') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>Second page</title><body style="font:15px sans-serif;padding:16px"><h1>Second page</h1><p>Reached by a link.</p></body>')
      return
    }
    if (request.url?.endsWith('/models')) {
      sendJson(response, 200, { data: [{ id: 'mock-model', name: 'Mock model' }] })
      return
    }
    if (!request.url?.endsWith('/chat/completions') || request.method !== 'POST') {
      sendJson(response, 404, { error: { message: 'not found' } })
      return
    }

    lastAuthorization = request.headers.authorization ?? null
    let raw = ''
    for await (const part of request) raw += part
    const body = JSON.parse(raw || '{}')
    const messages = Array.isArray(body.messages) ? body.messages : []

    const problem = pairingProblem(messages)
    if (problem) {
      stats.invalidTranscripts += 1
      console.log(`[fake-provider] refused an invalid transcript: ${problem}`)
      sendJson(response, 400, { error: { message: `Invalid parameter: ${problem}`, type: 'invalid_request_error' } })
      return
    }

    if (namesSession(messages)) {
      stats.titleRequests += 1
      // Quoted and closed with a full stop, as models do: eNCode must take both off.
      await sendText(response, body, '"Provider path check."')
      return
    }

    if (isInline(messages)) {
      stats.inlineRequests += 1
      const user = messages.filter((message) => message.role === 'user').map((message) => textOf(message.content)).join('\n')
      lastInline = { model: body.model ?? null, tools: body.tools ?? [], maxTokens: body.max_tokens ?? body.max_completion_tokens ?? null, user }
      await sendText(response, body, inlineAnswer(user))
      return
    }

    if (isCodeReview(messages)) {
      stats.codeReviews += 1
      const user = messages.filter((message) => message.role === 'user').map((message) => textOf(message.content)).join('\n')
      lastCodeReview = { model: body.model ?? null, tools: body.tools ?? [], user }
      await sendText(response, body, codeReviewAnswer(user))
      return
    }

    if (isSecondLook(messages)) {
      stats.secondLooks += 1
      const user = messages.filter((message) => message.role === 'user').map((message) => textOf(message.content)).join('\n')
      lastSecondLook = { model: body.model ?? null, tools: body.tools ?? [], user }
      await sendText(response, body, secondLookAnswer(user))
      return
    }

    if (isStuckSteps(messages)) {
      stats.stuckSteps += 1
      const user = messages.filter((message) => message.role === 'user').map((message) => textOf(message.content)).join('\n')
      lastStuckSteps = { model: body.model ?? null, tools: body.tools ?? [], user }
      await sendText(response, body, STUCK_ADVICE)
      return
    }

    if (isConventions(messages)) {
      stats.conventionRequests += 1
      const user = messages.filter((message) => message.role === 'user').map((message) => textOf(message.content)).join('\n')
      lastConventions = { model: body.model ?? null, tools: body.tools ?? [], user }
      await sendText(response, body, `\`\`\`json\n${JSON.stringify({ lines: ['Use `pnpm` for installs and scripts, never `npm`.'] })}\n\`\`\``)
      return
    }

    if (isBestOf(messages)) {
      stats.bestOfRequests += 1
      const user = messages.filter((message) => message.role === 'user').map((message) => textOf(message.content)).join('\n')
      lastBestOf = { model: body.model ?? null, tools: body.tools ?? [], user }
      await sendText(response, body, `\`\`\`json\n${JSON.stringify({ best: 2, reason: 'Attempt 2 adds the numbers; attempt 1 subtracts them.', notes: { 1: 'Subtracts instead of adding.', 2: 'Adds, as asked.' } })}\n\`\`\``)
      return
    }

    if (isCompletionReview(messages)) {
      stats.completionReviews += 1
      const user = messages.filter((message) => message.role === 'user').map((message) => textOf(message.content)).join('\n')
      lastCompletionReview = { model: body.model ?? null, tools: body.tools ?? [], system: messages.filter((message) => message.role === 'system').map((message) => textOf(message.content)).join('\n'), user }
      await sendText(response, body, completionReviewAnswer(user))
      return
    }

    if (isReviewer(messages)) {
      stats.reviewerRequests += 1
      const user = messages.filter((message) => message.role === 'user').map((message) => textOf(message.content)).join('\n')
      lastReviewer = { model: body.model ?? null, tools: body.tools ?? [], messages: messages.length, system: messages.filter((message) => message.role === 'system').map((message) => textOf(message.content)).join('\n'), user }
      await sendText(response, body, reviewerAnswer(user))
      return
    }

    if (!Array.isArray(body.tools) || !body.tools.length) {
      stats.summaryRequests += 1
      await sendText(response, body, 'SUMMARY: the agent listed the workspace while working on the overflow scenario.')
      return
    }

    // The connection check asks for one call to a tool named echo, the way a person's first message would ask for work.
    const check = body.tools.some((tool) => (tool.function?.name ?? tool.name) === 'echo')
    if (!check) lastRequest = { tools: body.tools.map((tool) => tool.function?.name ?? tool.name), messages, model: body.model ?? null, effort: body.reasoning_effort ?? null }
    if (!check && failMode !== 'off' && scenarioOf(messages) === 'retry-check') {
      console.log(`[fake-provider] retry-check fails on purpose: ${failMode}`)
      if (failMode === 'auth') {
        sendJson(response, 401, {
          error: { message: `Incorrect API key provided: ${LEAKED_KEY}. You can find your API key at https://platform.example.test/api-keys.`, type: 'invalid_request_error', code: 'invalid_api_key' },
        })
        return
      }
      await sendText(response, body, '')
      return
    }
    const step = check ? { text: '', call: { name: 'echo', args: { text: 'eNCode' } } } : stepOf(messages)
    const used = tokensOf(raw)
    const window = !check && step.overflowUntilCompacted ? overflowWindow(body, messages) : Infinity
    if (used > window) {
      stats.overflowRefusals += 1
      console.log(`[fake-provider] refused a prompt of ${used} tokens, window ${window}; messages: ${messages.map((message) => `${message.role}:${JSON.stringify(message).length}`).join(' ')}`)
      sendJson(response, 400, {
        error: {
          message: `This model's maximum context length is ${window} tokens. However, your messages resulted in ${used} tokens. Please reduce the length of the messages.`,
          type: 'invalid_request_error',
          param: 'messages',
          code: 'context_length_exceeded',
        },
      })
      return
    }
    console.log(`[fake-provider] ${body.model ?? '?'} scenario=${check ? 'check' : scenarioOf(messages)} call=${step.call?.name ?? 'none'} stream=${Boolean(body.stream)}`)
    // Like OpenAI, a request that forbids calls is answered in words.
    if (body.tool_choice === 'none') {
      stats.closingRequests += 1
      await sendText(response, body, scenarioOf(messages) === 'step-limit' ? CLOSING : step.text)
      return
    }
    if (!step.call) {
      const told = step.answersSteer ? lastSteer(messages) : ''
      await sendText(response, body, told ? `Steered by: ${told} ${step.text}` : step.text, step.streamDelayMs)
      return
    }
    const callId = `call_${requestCount}_${step.call.name}`
    const args = JSON.stringify(step.call.args)

    if (!body.stream) {
      sendJson(response, 200, {
        id: 'mock',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: step.text,
              tool_calls: [{ id: callId, type: 'function', function: { name: step.call.name, arguments: args } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: fakeUsage(),
      })
      return
    }

    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (delta, finish = null) => response.write(chunk(delta, finish))

    // Thinking first, as a model that reasons streams it (reasoning_content), slowly enough to be seen.
    for (const part of step.thinking?.match(/\S+\s*/g) ?? []) {
      send({ reasoning_content: part })
      await delay(step.thinkingDelayMs ?? 20)
    }
    for (const part of step.text.match(/\S+\s*/g) ?? []) {
      send({ content: part })
      await delay(20)
    }
    // Arguments arrive split across chunks, like a real SSE stream.
    const middle = Math.ceil(args.length / 2)
    send({
      tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: step.call.name, arguments: args.slice(0, middle) } }],
    })
    await delay(25)
    send({ tool_calls: [{ index: 0, function: { arguments: args.slice(middle) } }] })
    send({}, 'tool_calls')

    // Final usage frame, like OpenAI's include_usage tail chunk.
    response.write(`data: ${JSON.stringify({
      id: 'mock',
      object: 'chat.completion.chunk',
      choices: [],
      usage: fakeUsage(),
    })}\n\n`)
    response.write('data: [DONE]\n\n')
    response.end()
  } catch (error) {
    console.error('[fake-provider] error', error)
    try {
      sendJson(response, 500, { error: { message: String(error) } })
    } catch {
      /* response already gone */
    }
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-provider] listening on http://127.0.0.1:${port}`)
})
