# Forge — Handover Notes

**Date:** 2026-02-14 · **Repo:** `C:\Users\hi\Documents\deepseek-harness\default-workspace\forge`
**Goal:** IDE/agent app ("eNCode") with feature parity to the DeepSeek Harness (DSH) the user runs at `http://127.0.0.1:38479`. Reference checkout (read-only): `C:\Users\hi\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\`.

## Environment (critical)
- Windows. Node v24.14.0, git 2.54 available.
- pnpm is **not** on PATH. Use bundled runtime:
  `C:\Users\hi\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs` with node at `...\dependencies\node\bin\node.exe`
  → `& "...\node.exe" "...\pnpm.mjs" install`
- **Known issue at handover:** `node_modules\electron\dist\electron.exe` is MISSING (postinstall didn't run / 247 dirs present but electron binary absent). Fix = run `pnpm install` via the bundled pnpm above, then verify `node_modules\electron\dist\electron.exe` exists.
- Smoke suite does NOT launch Electron itself. Start it first:
  `.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9222` (cwd = repo root), then `node scripts/smoke.mjs <workspace>`. It polls `http://127.0.0.1:9222/json/list` for a `page` target with url `app://…` or `localhost:…` (120 × 500ms).
- User's approval policy for the agent driving this work is "never": never request sandbox escalation; such actions are auto-rejected.

## Architecture
- Electron main: `electron/` (services + agent loop), IPC bridge + preload.
- React renderer: `src/` (chat, editor, terminal, modals, stores).
- Shared types: `shared/types.ts` — single source for `ForgeApi`, `AgentEventBody`, `AgentMode`, `TodoItem`, `BackgroundJob`, `Schedule`, `SkillInfo`, `PlanRequest`, etc.
- Persistence: `app.getPath('userData')` JSON files, atomic tmp+rename. Skills as markdown w/ front-matter in `userData/skills` and `<workspace>/.forge/skills`.
- Agent deps: `AgentDeps` (settings, workspace, shell, goals, todos, plan, jobs, skills, emit). Tools get `ToolContext` incl. `todos`, `jobs`, `skills`, `proposePlan`, `mode`.
- Subagents: `task` tool is intercepted in `Agent.runLoop` (NOT tools.ts — avoids circular import). Child = `new Agent({...deps, emit:()=>{}, plan:()=>{}, todos:{get:()=>[],set:()=>{}}})`, `depth+1`, task blocked at depth ≥ 2.
- Jobs: `JobService` wraps `ShellService.capture(command, cwd, timeoutMs, signal, onChunk?)` — the 5th `onChunk` param streams live output (added in commit 0f50a73).
- Provider usage: `requestChat` sets `stream_options:{include_usage:true}` when streaming; `readUsage()` normalizes `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens`; `ChatResult.usage` → agent emits `{type:'usage', …}` per turn.

## What's DONE (committed; git log latest → oldest)
- 436960f fake provider emits deterministic usage incl. cached tokens (smoke can assert cache %).
- 0f50a73 shell streaming (`onChunk`) + provider usage accounting.
- 61b9e9f live job output, schedule retries/error reporting, goal fork, configurable goal rounds.
- 450efa9 harness-aligned tool surface: read/write/edit/glob/grep/pwsh/ask_user_question/get_goal.
- 5b12910 command palette (File, Goal, Plan, Feedback, Compact, Permission, Model, Export) + zip export + history compaction.
- 7740941 approval-policy model (read-only / workspace-write / full-access / auto-review) w/ enforcement + policy menu.
- 121fda4 / 1de1d7c app icon; meta text typography w/ tabular numerals.
- Earlier: goals UI + auto-continuation, governance/ask-never + auto confirmation, tool lifecycle (120s timeout), Forge Shell terminal, sessions, subagent/workflow listing, models + approval/git provision, harness-matching type scale (14/13/12/11px, editor 12.5, terminal 12/19; system + mono stacks).

## UNTRACKED at handover
`pnpm-lock.yaml`, `pnpm-workspace.yaml` — review and commit these (they pin the dep tree; workspace yaml may be accidental — check whether repo should be its own workspace root).

## REMAINING WORK (batches 3–5 of 5)
1. **Batch 3 — agent/manager/IPC**
   - tools.ts: schemas + cases for `todo_write({todos:[{text,status}]})` (full replace), `job_list`, `job_output({id})`, `job_kill({id})`, `skill({name})`, `exit_plan_mode({plan})`, `web_search({query})` (DuckDuckGo html endpoint, parse `result__a` + `result__snippet`, best-effort), `web_fetch({url})` (fetch, strip tags/scripts, truncate ~20k). `task` = schema only (executed by agent).
   - agent.ts: `usage` event emission after each chat result; `task` interception (see above); `exit_plan_mode` → `deps.proposePlan(plan)` + emit `{type:'plan', plan:{id, plan}}` + finish turn; mode 'plan' blocks writes/commands like 'ask'.
   - manager.ts: todos persisted in sessions file (mirror the existing `goal` pattern), emit `{type:'todos'}` events; schedules fire → `manager.start(schedule.sessionId, {text: schedule.prompt, mode:'code'})`; jobs onChange → webContents send.
   - main.ts: instantiate `JobService`, `ScheduleService`, `SkillService`; wire into manager + ipc; dispose ScheduleService on quit.
   - ipc/preload: expose `agent.todos/setTodos`, `agent.plan/setPlan`, `jobs.{list,output,kill,onChange}`, `schedules.{list,create,remove,toggle}`, `skills.{list,read,create,openFolder}` matching `ForgeApi`.
2. **Batch 4 — renderer + fake provider + smoke**
   - chat store: todos, plan, running-jobs count, usage totals `{turns, steps, prompt, completion, total, cached}`.
   - UI: TodoCard (near goal card), PlanCard w/ Approve/Cancel (Approve → set mode 'code' + run "Execute the approved plan:\n<plan>"), jobs header chip w/ popover (list/preview/kill), AutomationModal (schedules CRUD) on "Automation tasks" nav, PluginsModal (Model plugins → Settings link; Skills list/open folder/new skill) on "Plugins" nav.
   - Composer stats line (DSH style, 11px): `${turns} turns ${steps} steps · ${tokPerSec} tok/s · ${totalTokens} tok · cache ${pct}% · ${ctx}% ctx` (cache % only when cached>0).
   - Smoke: new assertions — todos via manager API, schedules create/list/delete, skills list/read, background job run→output, web_fetch example.com, fake-provider usage/cache-hit % in stats.
3. **Batch 5 — verify + ship**
   - Ritual per batch: `tsc -p tsconfig.json --noEmit && tsc -p tsconfig.node.json --noEmit` → `node scripts/build.mjs` → start Electron w/ debug port → `node scripts/smoke.mjs ..\demo-project` (zero renderer exceptions) → commit → refresh `docs/harness.png` + `docs/typescript.png` screenshots.
   - Mode chips must include Plan; chips 12px (`xxs-12`), secondary text 13px (`xs-13`), body 14px.

## Gotchas
- Don't break the `AgentEventBody` union — extend, and update every renderer switch on `event.type`.
- `ShellService.capture` now takes 5 args; all existing callers are compatible (5th optional).
- Fake provider is the smoke backbone: keep its usage payload deterministic.
- Keep implementations compact-but-real; the bar is working end-to-end + smoke green, not exhaustive breadth.
