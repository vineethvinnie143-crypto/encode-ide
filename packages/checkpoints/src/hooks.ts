import type { CheckpointService } from './service'

/**
 * The service's two hooks, shaped like @encode/core's `AgentHooks` (which
 * this object is passed as). `userPromptSubmit` marks where a turn begins;
 * `postToolUse` records what the call's files hold, whether it succeeded or
 * not. Put them first in `combineHooks`: a later hook that blocks a result
 * stops the ones after it, and the record of what is on disk must not depend
 * on that.
 *
 * Neither returns anything, so neither can block a prompt or a result; a
 * failure is reported as a notice by the hook runner, and the next write
 * (`ToolContext.beforeWrite`, which does reject) is where a broken store is
 * noticed.
 */
export interface CheckpointHooks {
  userPromptSubmit(event: { messageId: string }): Promise<void>
  postToolUse(event: { toolUseId: string }): Promise<void>
}

export function checkpointHooks(service: CheckpointService): CheckpointHooks {
  return {
    userPromptSubmit: (event) => service.beginTurn(event.messageId),
    postToolUse: (event) => service.afterTool(event.toolUseId),
  }
}
