import path from 'node:path'
import { checkpointHooks, type ApplyOutcome, type CheckpointService, type RewindPlan as StoredPlan } from '@encode/checkpoints'
import type { AgentHooks, CheckpointInfo, RewindOutcome, RewindPlan, SessionCheckpoints } from '@encode/core'
import { isInside } from '@encode/permissions'

/**
 * The service's hooks for the agent, made unable to stop a prompt or a result: when the store fails the person hears of it
 * once, and the next write (which is refused, see `Workspaces.scope`) is where it matters. Without this a failing store
 * would make a prompt hook that guards something be skipped as well.
 */
export function recordingHooks(service: CheckpointService, notice: (text: string) => void): AgentHooks {
  const hooks = checkpointHooks(service)
  let told = ''
  const keep = async (record: () => Promise<void>) => {
    try {
      await record()
      told = ''
    } catch (error) {
      const text = `eNCode could not update the record of what the agent changes (${error instanceof Error ? error.message : String(error)}), so a rewind may not be able to put everything back.`
      if (text !== told) notice(text)
      told = text
    }
  }
  return {
    userPromptSubmit: async (event) => void (await keep(() => hooks.userPromptSubmit(event))),
    postToolUse: async (event) => void (await keep(() => hooks.postToolUse(event))),
  }
}

export interface RewindOptions {
  /** The workspace root: paths inside it are shown relative to it. */
  root: string
  platform?: NodeJS.Platform
}

/** Turns the checkpoint service into what a session offers: paths a person can read, and outcomes without file lists of their own. */
export function sessionCheckpoints(service: CheckpointService, options: RewindOptions): SessionCheckpoints {
  const api = (options.platform ?? process.platform) === 'win32' ? path.win32 : path.posix
  const shown = (file: string): string => {
    if (!isInside(options.root, file, api)) return file
    const relative = api.relative(options.root, file)
    return relative ? relative.split(api.sep).join('/') : file
  }
  const present = (plan: StoredPlan): RewindPlan => ({
    kind: plan.kind,
    turn: plan.turn,
    known: plan.known,
    files: plan.files.map((file) => ({
      path: shown(file.path),
      action: file.action,
      ...(file.reason ? { reason: file.reason } : {}),
      conflict: file.conflict,
    })),
    fingerprint: plan.fingerprint,
  })
  const outcome = (result: ApplyOutcome): RewindOutcome =>
    result.ok
      ? {
          ok: true,
          restored: result.restored.length,
          deleted: result.deleted.length,
          skipped: result.skipped.map((item) => ({ path: shown(item.path), reason: item.reason })),
          failed: result.failed.map((item) => ({ path: shown(item.path), error: item.error })),
        }
      : { ok: false, reason: result.reason, message: result.message }

  return {
    async info(): Promise<CheckpointInfo> {
      const [turns, canUndo] = await Promise.all([service.turns(), service.canRedo()])
      return {
        available: true,
        // A request that changed no file has nothing to put back; its rewind is the conversation's alone.
        turns: turns.filter((turn) => turn.files.length || turn.outside.length).map((turn) => ({ turn: turn.turn, at: turn.at, files: turn.files.length, outside: turn.outside.length })),
        canUndo,
      }
    },
    async plan(turn) {
      return present(await service.planRewind(turn))
    },
    async planRedo() {
      const plan = await service.planRedo()
      return plan ? present(plan) : null
    },
    async apply(request) {
      // The service works out the plan again from the history and the disk; the fingerprint is all it takes from the caller.
      const plan: StoredPlan = { kind: request.kind, turn: request.turn, known: true, files: [], fingerprint: request.fingerprint }
      return outcome(await service.apply(plan, { force: request.force === true }))
    },
  }
}
