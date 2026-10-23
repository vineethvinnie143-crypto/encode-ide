import { TraceReplayer, editorProblems, scrambleTrace, type EditorTrace, type TraceProblem } from '@encode/editor'
import type { Text } from '@encode/text'
import { ISSUE_LIMITS, type EditorIssueDraft } from '@shared/editor-issue'
import { isSecretFile } from '@shared/secret-files'
import { recordingOf, type Recording } from './recording'

/** About this much checking per report: every step of a small file, a sample of a large one's. */
const CHECK_BUDGET = 60_000_000

export interface IssueCheck {
  recording: Recording
  /** What replaying the trace found wrong, first ones first. */
  problems: TraceProblem[]
  /** How many of its steps were checked. */
  checked: number
}

/** Why a report cannot be made of a file now, in words. */
export function unavailableReason(reason: 'not open' | 'too large' | 'nothing yet'): string {
  switch (reason) {
    case 'not open':
      return 'Open the file the issue happened in, then report it from there.'
    case 'too large':
      return 'This file is too large to record (over 2 million characters), so there is nothing to replay. Describe the issue in a diagnostics report instead.'
    case 'nothing yet':
      return 'Nothing has happened in this file since it was opened. Do what went wrong once more, then report it.'
  }
}

/**
 * Replays what was recorded of `path` with the editor's invariants checked after the steps (every step while that
 * is cheap, an even sample otherwise, and the last one always), and compares the end with the text shown now.
 */
export function checkRecording(path: string, shown: Text | undefined): IssueCheck | string {
  const recording = recordingOf(path)
  if (typeof recording === 'string') return unavailableReason(recording)
  const { trace } = recording
  const problems: TraceProblem[] = []
  const total = trace.steps.length
  const size = Math.max(1, trace.doc.length)
  const every = Math.max(1, Math.ceil((size * total) / CHECK_BUDGET))
  let checked = 0
  const replayer = new TraceReplayer(trace, {
    check: false,
    onStep: (index, state, tr) => {
      if (problems.length >= ISSUE_LIMITS.problems || (index % every !== 0 && index !== total)) return
      checked++
      for (const problem of editorProblems(state, tr ?? undefined)) if (problems.length < ISSUE_LIMITS.problems) problems.push({ step: index, problem })
    },
  })
  for (const step of trace.steps) replayer.step(step)
  // The trace ends with what the document was; the replay's own `expect` step says when it does not get there.
  if (shown && !replayer.state.doc.eq(shown) && problems.length < ISSUE_LIMITS.problems) {
    problems.push({ step: total, problem: 'replaying the steps does not give the text the editor shows' })
  }
  // An `expect` step the replay missed is a problem of its own: the replay went elsewhere than the editor did.
  return { recording, problems: [...replayer.problems, ...problems].slice(0, ISSUE_LIMITS.problems), checked }
}

/** Whether a file's words must be replaced in a report: a file that holds secrets by its name. */
export const mustScramble = (path: string): boolean => isSecretFile(path)

export interface DraftInput {
  path: string
  description: string
  scramble: boolean
  editor: Record<string, string | number | boolean>
  check: IssueCheck
  /** The seed words are replaced with; random, so the replacement cannot be undone by knowing it. */
  seed?: number
}

/** The report's draft for the main process: the trace with its words replaced unless the person keeps them. */
export function issueDraft(input: DraftInput): EditorIssueDraft {
  const { recording, problems } = input.check
  const scrambled = input.scramble || mustScramble(input.path)
  const seed = input.seed ?? (crypto.getRandomValues(new Uint32Array(1))[0] || 1)
  const trace: EditorTrace = scrambled ? scrambleTrace(recording.trace, seed) : recording.trace
  return {
    description: input.description.slice(0, ISSUE_LIMITS.description),
    path: input.path,
    language: trace.language ?? 'plaintext',
    scrambled,
    editor: input.editor,
    recorded: { steps: recording.steps, minutes: recording.minutes, trimmed: recording.trimmed },
    // A problem names positions and lengths; the odd character it quotes is left out when the words are replaced.
    problems: scrambled ? problems.map((found) => ({ ...found, problem: found.problem.replace(/"(?:[^"\\]|\\.)*"/g, '"…"') })) : problems,
    trace,
  }
}
