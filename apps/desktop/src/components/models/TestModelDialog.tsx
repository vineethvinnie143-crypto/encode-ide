import { useEffect, useState } from 'react'
import { ROLE_INFO } from '@shared/models'
import { MODEL_SKILLS, ROLE_SKILL, SKILL_INFO, dollars, planCost, resultCost, scoreGrade, scoreLine, type ModelSkill, type ModelTestItem, type ModelTestOutcome, type ModelTestPlan, type ModelTestResult } from '@shared/model-tests'
import type { ModelRole } from '@shared/types'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { useModelTests } from '../../stores/model-tests'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { AlertTriangle, Check, Circle, Minus, X } from '../../ui/icons'
import { Dialog } from '../../ui/Dialog'
import { Spinner } from '../../ui/Spinner'

export interface TestTarget {
  /** "<profile id>:<model id>". */
  ref: string
  profileId: string
  model: string
  /** The model with its connection, as Roles shows it. */
  label: string
}

type Plan = ModelTestPlan | { unavailable: string }

/** The roles whose score a skill sets, in words: "Main and Plan". */
function rolesOf(skill: ModelSkill): string {
  const roles = (Object.keys(ROLE_SKILL) as ModelRole[]).filter((role) => ROLE_SKILL[role] === skill).map((role) => ROLE_INFO[role].label)
  return roles.length > 1 ? `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}` : (roles[0] ?? '')
}

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

/** "eight", "14". */
const count = (value: number): string => WORDS[value] ?? String(value)

/** "245k", "1.2M". */
function tokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (count >= 1000) return `${Math.round(count / 1000)}k`
  return String(count)
}

/** "40 s", "3 min 5 s", "1 h 2 min". */
function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

const OUTCOME_LABEL: Record<ModelTestOutcome, string> = { passed: 'Passed', failed: 'Failed', error: 'Did not finish', skipped: 'Not run' }

function OutcomeIcon({ outcome }: { outcome: ModelTestOutcome | 'running' | 'waiting' }) {
  if (outcome === 'running') return <Spinner size={12} />
  if (outcome === 'passed') return <Check size={13} />
  if (outcome === 'failed') return <X size={13} />
  if (outcome === 'error') return <AlertTriangle size={12} />
  if (outcome === 'skipped') return <Minus size={13} />
  return <Circle size={10} />
}

/** Each task in order: how it ended, what runs now, what is still to come. */
function Items({ plan, done, current }: { plan: ModelTestPlan['items']; done: readonly ModelTestItem[]; current?: string | null }) {
  const ended = new Map(done.map((item) => [item.id, item]))
  return (
    <ol className="model-test-items">
      {plan.map((item) => {
        const result = ended.get(item.id)
        const state = result ? result.outcome : item.id === current ? 'running' : 'waiting'
        return (
          <li key={item.id} className={cx('model-test-item', `is-${state}`)} data-item={item.id} data-outcome={state}>
            <span className="model-test-item-icon" aria-label={result ? OUTCOME_LABEL[result.outcome] : state === 'running' ? 'Running' : 'To come'}>
              <OutcomeIcon outcome={state} />
            </span>
            <span className="model-test-item-text">
              <span className="model-test-item-title">{item.title}</span>
              {result?.reason && result.outcome !== 'passed' && <span className="model-test-item-reason">{result.reason}</span>}
            </span>
            <span className="model-test-item-skill">{SKILL_INFO[item.skill].label}</span>
          </li>
        )
      })}
    </ol>
  )
}

function Scores({ result }: { result: ModelTestResult }) {
  return (
    <div className="model-test-scores">
      {MODEL_SKILLS.map((skill) => {
        const score = result.skills[skill]
        if (!score || !score.total) return null
        return (
          <div key={skill} className={cx('model-test-score', `is-${scoreGrade(score)}`)} data-skill={skill}>
            <span className="model-test-score-value">
              {score.passed}/{score.total}
            </span>
            <span className="model-test-score-label">{SKILL_INFO[skill].label}</span>
            <span className="model-test-score-roles">{rolesOf(skill)}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Test this model (ADR 0101): what the short benchmark will run and may cost, read before it starts; then each task as
 * it ends, with Stop; then the scores Roles shows. Closing the dialog leaves a test running, and opening it again on the
 * same model picks it up.
 */
export function TestModelDialog({ target, onClose }: { target: TestTarget | null; onClose: () => void }) {
  const running = useModelTests((state) => state.running)
  const last = useModelTests((state) => state.last)
  const results = useModelTests((state) => state.results)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [round, setRound] = useState(0)
  // Set once this dialog has seen the model's test run, so its ending shows here rather than a fresh plan.
  const [watched, setWatched] = useState(false)
  const ref = target?.ref ?? null
  const mine = running !== null && running.ref === ref

  useEffect(() => {
    setPlan(null)
    setWatched(false)
    if (!target) return
    let live = true
    void api.models
      .testPlan(target.profileId, target.model)
      .then((answer) => live && setPlan(answer))
      .catch((error: unknown) => live && setPlan({ unavailable: errorText(error) }))
    return () => {
      live = false
    }
  }, [ref, round])

  useEffect(() => {
    if (mine) setWatched(true)
  }, [mine])

  const start = () => {
    if (!target) return
    setWatched(true)
    void useModelTests.getState().run(target)
  }
  const again = () => {
    setRound((value) => value + 1)
  }

  const phase = mine ? 'running' : watched && last?.ref === ref ? 'done' : 'plan'
  const ready = plan && !('unavailable' in plan) ? plan : null
  const previous = ref ? results[ref] : undefined
  const ended = phase === 'done' ? last : null

  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      title={`Test ${target?.model ?? 'this model'}`}
      description={target?.label}
      width={540}
      className="model-test-dialog"
      footer={
        phase === 'running' ? (
          <>
            <Button busy={running?.stopping} onClick={() => void useModelTests.getState().stop()}>
              Stop
            </Button>
            <Button variant="primary" data-autofocus onClick={onClose}>
              Keep going in the background
            </Button>
          </>
        ) : phase === 'done' ? (
          <>
            <Button onClick={again}>{ended?.error ? 'Try again' : 'Run again'}</Button>
            <Button variant="primary" data-autofocus onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            {ready && !ready.refused && (
              <Button variant="primary" data-autofocus onClick={start}>
                Run the test
              </Button>
            )}
          </>
        )
      }
    >
      {phase === 'running' && running ? (
        <div className="model-test-body" role="status" aria-live="polite">
          <div className="model-test-progress">
            <div className="install-server-bar" role="progressbar" aria-label="Tasks done" aria-valuemin={0} aria-valuemax={running.total || ready?.items.length || 1} aria-valuenow={running.done.length}>
              <span style={{ width: `${Math.round((running.done.length / Math.max(1, running.total || ready?.items.length || 1)) * 100)}%` }} />
            </div>
            <span className="model-test-progress-text">
              {running.stopping ? 'Stopping…' : `${running.done.length} of ${running.total || ready?.items.length || '…'} done`} · {dollars(running.cost)} so far
            </span>
          </div>
          {ready ? <Items plan={ready.items} done={running.done} current={running.current?.id ?? null} /> : <Spinner size={14} />}
          <p className="model-test-note">Each task runs in a temporary folder of its own; nothing of yours is read or changed.</p>
        </div>
      ) : phase === 'done' && ended ? (
        <div className="model-test-body">
          {ended.error || !ended.result ? (
            <p className="install-server-failed" role="alert">
              {ended.error ?? 'The test did not run.'}
            </p>
          ) : (
            <>
              <Scores result={ended.result} />
              {ended.result.stopped && (
                <p className="model-test-stopped">
                  {ended.result.stopped === 'limit'
                    ? `It stopped at the spending limit of ${dollars(ready?.limit ?? ended.result.cost)}; the scores count the tasks that ran.`
                    : 'Stopped before the end; the scores count the tasks that ran.'}
                </p>
              )}
              <dl className="install-server-facts">
                <div>
                  <dt>Cost</dt>
                  <dd>{resultCost(ended.result)}</dd>
                </div>
                <div>
                  <dt>Took</dt>
                  <dd>
                    {duration(ended.result.durationMs)}, {ended.result.requests} {ended.result.requests === 1 ? 'request' : 'requests'}
                  </dd>
                </div>
                <div>
                  <dt>Tokens</dt>
                  <dd>
                    {tokens(ended.result.inputTokens)} read, {tokens(ended.result.outputTokens)} written
                  </dd>
                </div>
              </dl>
              <Items plan={ended.result.items} done={ended.result.items} />
              <p className="model-test-note">Settings &gt; Roles shows each model’s score next to it, and the model lists show it as you choose.</p>
            </>
          )}
        </div>
      ) : !plan ? (
        <div className="install-server-loading">
          <Spinner size={14} />
          <span>Working out what it takes…</span>
        </div>
      ) : 'unavailable' in plan ? (
        <p className="install-server-unavailable">{plan.unavailable}</p>
      ) : (
        <div className="model-test-body">
          <p className="install-server-lead">
            eNCode gives the model {count(plan.items.length)} short jobs on projects of its own, with your checks and Reviewer settings, and scores the skills its roles need:
          </p>
          <ul className="model-test-skills">
            {MODEL_SKILLS.filter((skill) => plan.items.some((item) => item.skill === skill)).map((skill) => (
              <li key={skill}>
                <span className="model-test-skill-name">{SKILL_INFO[skill].label}</span>
                <span className="model-test-skill-what">
                  {SKILL_INFO[skill].what}, for {rolesOf(skill)}
                </span>
              </li>
            ))}
          </ul>
          <dl className="install-server-facts">
            <div>
              <dt>Requests</dt>
              <dd>
                {plan.requests[0]} to {plan.requests[1]}
              </dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd>
                {tokens(plan.inputTokens[0])} to {tokens(plan.inputTokens[1])} read
              </dd>
            </div>
            {plan.limit !== undefined && (
              <div>
                <dt>Limit</dt>
                <dd>stops if it spends more than {dollars(plan.limit)}</dd>
              </div>
            )}
          </dl>
          <p className="model-test-cost">{planCost(plan)} None of your code or files are sent; each task runs in a temporary folder.</p>
          {previous && (
            <p className="model-test-previous">
              Last tested {new Date(previous.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}: {scoreLine(previous)}.
            </p>
          )}
          {plan.refused && (
            <p className="install-server-failed" role="alert">
              {plan.refused}
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}
