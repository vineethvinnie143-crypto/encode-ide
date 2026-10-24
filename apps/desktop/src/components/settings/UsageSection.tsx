import { useEffect, useMemo, useState } from 'react'
import type { SessionUsage, Settings } from '@shared/types'
import { api } from '../../api'
import { errorText } from '../../ipc-error'
import { Button } from '../../ui/Button'
import { cx } from '../../ui/cx'
import { AlertTriangle, BarChart, RefreshCw } from '../../ui/icons'
import { Segmented, type SegmentedOption } from '../../ui/Segmented'
import { Skeleton } from '../../ui/Skeleton'
import { SettingsGroup } from './Section'
import { dayLabel, formatCost, formatMetric, formatTokens, metricOf, usageView, type Tally, type UsageGroup, type UsageMetric, type UsageRange } from './usage-model'

const RANGES: SegmentedOption<`${UsageRange}`>[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
]

const METRICS: SegmentedOption<UsageMetric>[] = [
  { value: 'cost', label: 'Cost' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'requests', label: 'Requests' },
]

/** Rows a table shows before "Show all". */
const TABLE_ROWS = 8

/** "3 calls unpriced", for the costs that are a lower bound. */
const unpricedNote = (tally: Tally): string | null => (tally.unpriced ? `${tally.unpriced.toLocaleString()} ${tally.unpriced === 1 ? 'call' : 'calls'} unpriced` : null)

/** Settings > Usage: what the requests of every session used, by day, by model and by project, counted from their records. */
export function UsageSection({ settings }: { settings: Settings }) {
  const [sessions, setSessions] = useState<SessionUsage[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [range, setRange] = useState<UsageRange>(30)
  const [metric, setMetric] = useState<UsageMetric | null>(null)
  const [loads, setLoads] = useState(0)

  useEffect(() => {
    let live = true
    setFailed(null)
    api.agent.usage().then(
      (next) => live && setSessions(next),
      (error) => live && setFailed(errorText(error)),
    )
    return () => {
      live = false
    }
  }, [loads])

  // Today is read when the numbers come in, so a page left open past midnight moves on with the next refresh.
  const view = useMemo(() => (sessions ? usageView(sessions, { today: new Date(), range, chatsFolder: settings.chatsFolder }) : null), [sessions, range, settings.chatsFolder])
  const shown: UsageMetric = metric ?? (view && view.total.cost > 0 ? 'cost' : 'tokens')

  if (failed) {
    return (
      <div className="settings-empty" role="alert">
        <AlertTriangle size={18} aria-hidden="true" />
        <span>Could not read what your sessions used: {failed}</span>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => setLoads((count) => count + 1)}>
          Try again
        </Button>
      </div>
    )
  }

  return (
    <>
      <div className="usage-bar">
        <Segmented label="Days shown" size="sm" value={`${range}`} options={RANGES} onChange={(next) => setRange(Number(next) as UsageRange)} />
        <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => setLoads((count) => count + 1)}>
          Refresh
        </Button>
      </div>

      <section className="usage-tiles" data-setting="usage.summary" aria-label="Totals">
        {view ? (
          <>
            <Tile label="Cost" value={formatCost(view.total.cost)} note={unpricedNote(view.total) ?? 'As the providers reported it'} />
            <Tile label="Requests" value={view.total.requests.toLocaleString()} note={`${view.total.calls.toLocaleString()} model calls`} />
            <Tile
              label="Tokens read"
              value={formatTokens(view.total.inputTokens)}
              note={view.total.inputTokens ? `${Math.round((view.total.cachedTokens / view.total.inputTokens) * 100)}% from the cache` : 'None yet'}
            />
            <Tile label="Tokens written" value={formatTokens(view.total.outputTokens)} note="The models’ answers" />
          </>
        ) : (
          Array.from({ length: 4 }, (_, index) => <Skeleton key={index} height={88} radius="var(--r-10)" />)
        )}
      </section>

      {view && !view.total.requests ? (
        <div className="settings-empty usage-empty">
          <BarChart size={18} aria-hidden="true" />
          <span>No requests in the last {range} days. What each request uses is counted here as it ends.</span>
        </div>
      ) : (
        view && (
          <>
            <SettingsGroup title="By day">
              <div className="usage-chart-card">
                <div className="usage-chart-head">
                  <Segmented label="What the bars show" size="sm" value={shown} options={METRICS} onChange={setMetric} />
                </div>
                <DayBars days={view.days} metric={shown} />
              </div>
            </SettingsGroup>
            <UsageTable id="usage.models" title="By model" groups={view.models} unit="calls" />
            <UsageTable id="usage.projects" title="By project" groups={view.projects} unit="requests" />
          </>
        )
      )}

      <p className="settings-aside usage-note">
        Counted on this computer from your sessions’ records, archived ones included and deleted ones not. A provider’s bill can differ: local models and some free ones report no cost, and only what was reported is added up.
      </p>
    </>
  )
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="usage-tile">
      <span className="usage-tile-label">{label}</span>
      <span className="usage-tile-value">{value}</span>
      <span className="usage-tile-note">{note}</span>
    </div>
  )
}

/** One bar a day, scaled to the busiest day; a day without requests keeps its place with an empty bar. */
function DayBars({ days, metric }: { days: { day: string; tally: Tally }[]; metric: UsageMetric }) {
  const values = days.map(({ tally }) => metricOf(tally, metric))
  const top = Math.max(...values, 0)
  const total = values.reduce((sum, value) => sum + value, 0)
  const ticks = [0, Math.floor((days.length - 1) / 2), days.length - 1]
  return (
    <figure className="usage-chart" aria-label={`${formatMetric(total, metric)} over ${days.length} days, the most on one day ${formatMetric(top, metric)}`}>
      <div className="usage-chart-scale" aria-hidden="true">
        <span>{formatMetric(top, metric)}</span>
      </div>
      <div className={cx('usage-bars', days.length > 40 && 'is-dense')} role="list">
        {days.map(({ day, tally }, index) => {
          const value = values[index]
          const height = top > 0 ? Math.max(value > 0 ? 3 : 0, (value / top) * 100) : 0
          const title = `${dayLabel(day, 'long')}: ${formatMetric(value, metric)}${tally.requests ? ` · ${tally.requests} ${tally.requests === 1 ? 'request' : 'requests'}` : ''}${metric === 'cost' && tally.unpriced ? ` · ${tally.unpriced} unpriced` : ''}`
          return (
            <span key={day} className="usage-bar-slot" role="listitem" title={title} aria-label={title}>
              <span className={cx('usage-bar-fill', value === 0 && 'is-zero')} style={{ height: `${height}%` }} />
            </span>
          )
        })}
      </div>
      <div className="usage-chart-axis" aria-hidden="true">
        {ticks.map((index) => (
          <span key={index}>{dayLabel(days[index]!.day)}</span>
        ))}
      </div>
    </figure>
  )
}

function UsageTable({ id, title, groups, unit }: { id: string; title: string; groups: UsageGroup[]; unit: 'calls' | 'requests' }) {
  const [all, setAll] = useState(false)
  const rows = all ? groups : groups.slice(0, TABLE_ROWS)
  const top = Math.max(...groups.map((group) => group.tally.cost), 0)
  return (
    <SettingsGroup title={title}>
      <div className="usage-table" data-setting={id} role="table" aria-label={title}>
        <div className="usage-row usage-head" role="row">
          <span role="columnheader">{unit === 'calls' ? 'Model' : 'Project'}</span>
          <span role="columnheader">{unit === 'calls' ? 'Calls' : 'Requests'}</span>
          <span role="columnheader">Read</span>
          <span role="columnheader">Written</span>
          <span role="columnheader">Cost</span>
        </div>
        {rows.map((group) => (
          <div key={group.key} className="usage-row" role="row" data-usage={group.key}>
            <span role="cell" className={cx('usage-name', unit === 'calls' && group.key && 'is-mono')} title={group.key || group.label}>
              {top > 0 && <span className="usage-share" style={{ width: `${(group.tally.cost / top) * 100}%` }} aria-hidden="true" />}
              <span className="usage-name-text">{group.label}</span>
            </span>
            <span role="cell">{(unit === 'calls' ? group.tally.calls : group.tally.requests).toLocaleString()}</span>
            <span role="cell" title={group.tally.inputTokens ? `${Math.round((group.tally.cachedTokens / group.tally.inputTokens) * 100)}% from the cache` : undefined}>
              {formatTokens(group.tally.inputTokens)}
            </span>
            <span role="cell">{formatTokens(group.tally.outputTokens)}</span>
            <span role="cell" title={unpricedNote(group.tally) ?? undefined}>
              {group.tally.unpriced && !group.tally.cost ? '—' : formatCost(group.tally.cost)}
              {group.tally.unpriced > 0 && group.tally.cost > 0 && <span className="usage-plus">+</span>}
            </span>
          </div>
        ))}
        {groups.length > TABLE_ROWS && (
          <button type="button" className="usage-more" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${groups.length}`}
          </button>
        )}
      </div>
    </SettingsGroup>
  )
}
