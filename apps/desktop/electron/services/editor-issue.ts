/**
 * The file a report of an editor issue is written as (ADR 0088). The page's draft is checked again here: a file whose
 * name says it holds secrets, or whose text holds something shaped like a credential, goes only with its words
 * replaced; what the person wrote is redacted like a log; the file's path is left out but for its extension.
 */
import path from 'node:path'
import type { AboutInfo } from '../../shared/types'
import { buildLine } from '../../shared/about'
import { EDITOR_ISSUE_KIND, traceTexts, type EditorIssue, type EditorIssueDraft } from '../../shared/editor-issue'
import { isSecretFile, redactForSuggestion } from '../secret-text'

export type EditorIssueFile = { ok: true; text: string } | { ok: false; reason: string }

export interface EditorIssueContext {
  about: AboutInfo
  now: number
  /** What the logs go through: keys the settings hold, the home folder, credential shapes. */
  redact: (text: string) => string
}

export const SECRET_FILE_REASON = 'This file holds secrets by its name, so a report of it carries its words replaced. Turn on "Replace the words of the file" and save again.'
export const CREDENTIAL_REASON = 'Something in this file looks like a key or a password, so a report of it carries its words replaced. Turn on "Replace the words of the file" and save again.'

export function editorIssueFile(draft: EditorIssueDraft, context: EditorIssueContext): EditorIssueFile {
  const { trace } = draft
  if (!draft.scrambled) {
    if (isSecretFile(draft.path)) return { ok: false, reason: SECRET_FILE_REASON }
    for (const text of traceTexts(trace)) if (redactForSuggestion(text, draft.path) !== text) return { ok: false, reason: CREDENTIAL_REASON }
  }
  const clean = (text: string) => redactForSuggestion(context.redact(text), draft.path)
  const extension = path.posix.extname(draft.path.replace(/\\/g, '/')).toLowerCase().slice(0, 16)
  let lines = 1
  for (let index = trace.doc.indexOf('\n'); index >= 0; index = trace.doc.indexOf('\n', index + 1)) lines++
  const issue: EditorIssue = {
    kind: EDITOR_ISSUE_KIND,
    version: 1,
    createdAt: new Date(context.now).toISOString(),
    build: buildLine(context.about),
    system: `${context.about.os} ${context.about.arch}`,
    description: clean(draft.description.trim()),
    extension,
    language: draft.language,
    lines,
    scrambled: draft.scrambled,
    editor: draft.editor,
    recorded: draft.recorded,
    problems: draft.problems.map((problem) => ({ step: problem.step, problem: clean(problem.problem) })),
    trace,
  }
  // The facts first, easy to read; the trace last, on one line, as it can be long.
  const { trace: _trace, ...facts } = issue
  const head = JSON.stringify(facts, null, 2)
  return { ok: true, text: `${head.slice(0, -2)},\n  "trace": ${JSON.stringify(trace)}\n}\n` }
}
