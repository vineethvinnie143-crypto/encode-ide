/**
 * Compile-time checks that what the agent host says is what the renderer's API
 * (shared/types.ts) says it receives, and that what the renderer sends is what
 * the host accepts. There is nothing to run here: a change to either side that
 * breaks the other stops the build at this file.
 */
import type * as Core from '@encode/core'
import type * as Tools from '@encode/tools'
import type * as Workspace from '@encode/workspace'
import type * as Ui from '../../shared/types'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Expect<T extends true> = T

/** The host to the renderer: everything the app shows. */
export type HostToRenderer = [
  Expect<Same<Core.AgentEvent, Ui.AgentEvent>>,
  Expect<Same<Core.AgentHistory, Ui.AgentHistory>>,
  Expect<Same<Core.ConversationEntry, Ui.ConversationEntry>>,
  Expect<Same<Core.ApprovalRequest, Ui.ApprovalRequest>>,
  Expect<Same<Core.SessionSummary, Ui.SessionSummary>>,
  Expect<Same<Core.BackgroundJob, Ui.BackgroundJob>>,
  Expect<Same<Core.AgentStatus, Ui.AgentStatus>>,
  Expect<Same<Core.SessionGoal, Ui.SessionGoal>>,
  Expect<Same<Core.TodoItem, Ui.TodoItem>>,
  Expect<Same<Core.PlanRequest, Ui.PlanRequest>>,
  Expect<Same<Workspace.WorkspaceReport, Ui.PermissionsReport>>,
  Expect<Same<Workspace.PermissionsOutcome, Ui.PermissionsOutcome>>,
  Expect<Same<Workspace.HookView, Ui.PermissionHookView>>,
  Expect<Same<Workspace.McpReport, Ui.McpReport>>,
  Expect<Same<Workspace.McpServerView, Ui.McpServerView>>,
  Expect<Same<Workspace.McpOutcome, Ui.McpOutcome>>,
  Expect<Same<Workspace.SandboxReport, Ui.SandboxReport>>,
  Expect<Same<Workspace.SandboxOutcome, Ui.SandboxOutcome>>,
  Expect<Same<Core.CheckpointInfo, Ui.CheckpointInfo>>,
  Expect<Same<Core.RewindPlan, Ui.RewindPlan>>,
  Expect<Same<Core.RewindOutcome, Ui.RewindOutcome>>,
  Expect<Same<Workspace.LanguageServersReport, Ui.LanguageServersReport>>,
  Expect<Same<Workspace.LanguageServerInfo, Ui.LanguageServerInfo>>,
  Expect<Same<Tools.CodeDiagnostic, Ui.CodeDiagnostic>>,
  Expect<Same<Workspace.EditorAsks, Ui.EditorAsks>>,
  Expect<Same<Workspace.EditorAnswer, Ui.EditorAnswer>>,
  Expect<Same<Workspace.EditorChangeResult, Ui.EditorChangeResult>>,
]

/** The renderer to the host: what the app asks for. */
export type RendererToHost = [
  Expect<Same<Core.AgentStartInput, Ui.AgentStartInput>>,
  Expect<Same<Core.SessionPatch, Ui.SessionPatch>>,
  Expect<Same<Exclude<Core.ApprovalAnswer, boolean>, Ui.ApprovalAnswer>>,
  Expect<Same<Core.ApprovalPolicy, Ui.ApprovalPolicy>>,
  Expect<Same<Core.AgentMode, Ui.AgentMode>>,
  Expect<Same<Workspace.PermissionsAction, Ui.PermissionsAction>>,
  Expect<Same<Workspace.McpAction, Ui.McpAction>>,
  Expect<Same<Workspace.SandboxAction, Ui.SandboxAction>>,
  Expect<Same<Core.RewindRequest, Ui.RewindRequest>>,
  Expect<Same<Core.ErrorGate, Ui.ErrorGate>>,
  Expect<Same<Workspace.EditorAsk, Ui.EditorAsk>>,
  Expect<Same<Workspace.EditorChangeRequest, Ui.EditorChangeRequest>>,
]
