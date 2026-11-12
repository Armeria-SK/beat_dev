import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, type Conversation, type ReviewJob, type RunRow, type ToolCallRow } from '../../api.ts';
import { formatDateTime, formatNumber, startOfDay, useT } from '../../i18n/index.ts';
import { changeLabel, decidedByLabel, decisionLabel, runDetail, runKindLabel } from '../../runlog-meta.ts';
import { latestOnly } from '../latest.ts';
import {
  durationText, filterLog, LOG_FILTERS, logFooter, logRows, tokensText, type LogFilter, type LogResult, type LogRow, type LogTotals,
} from '../library.ts';
import { EmptyState, Notice, Pill, type PillTone } from '../parts.tsx';
import { routeHash, type RunsTab } from '../routes.ts';
import { maskTarget } from '../tool-row.ts';

type T = ReturnType<typeof useT>;
interface Loaded { runs: RunRow[]; calls: ToolCallRow[]; jobs: ReviewJob[]; totals: LogTotals }

const FILTER_KEY = { all: 'ui.runs.all', run: 'ui.runs.run', tool: 'ui.runs.tool', review: 'ui.runs.review' } as const satisfies Record<LogFilter, string>;
const KIND_KEY = { run: 'ui.runs.run', tool: 'ui.runs.tool', review: 'ui.runs.review' } as const;
const RESULT_KEY = {
  running: 'ui.runs.result.running', queued: 'ui.runs.result.queued', ok: 'ui.runs.result.ok', failed: 'ui.runs.result.failed',
  stopped: 'ui.runs.result.stopped', fallback: 'ui.runs.result.fallback',
} as const satisfies Record<LogResult, string>;
const RESULT_TONE: Record<LogResult, PillTone | undefined> = { running: 'running', queued: undefined, ok: 'ok', failed: 'danger', stopped: undefined, fallback: 'warn' };
const TAB_OF: Record<LogFilter, RunsTab | undefined> = { all: undefined, run: 'run', tool: 'tools', review: 'reviews' };
const FILTER_OF = (tab: RunsTab | undefined): LogFilter => (tab === 'run' ? 'run' : tab === 'tools' ? 'tool' : tab === 'reviews' ? 'review' : 'all');

function timeText(at: number, today: number): string {
  const precise = formatDateTime(at, 'precise');
  return at >= today ? precise.slice(precise.indexOf(' ') + 1) : precise;
}

function Detail({ row, t }: { row: LogRow; t: T }) {
  if (row.run) {
    const run = row.run;
    return (
      <div className="ui-lib__more">
        <span>{runDetail(run) || '—'}</span>
        {run.conversation_id && <a className="bt-tool__link" href={routeHash({ view: 'chat', id: run.conversation_id })}>{t('ui.runs.openSession')}</a>}
      </div>
    );
  }
  if (row.call) {
    const call = row.call;
    return (
      <div className="ui-lib__more">
        <span>{t('ui.runs.decision', decisionLabel(call.decision), decidedByLabel(call.decided_by))}{call.autoReason ? ` · ${call.autoReason}` : ''}{call.grantFolder ? ` · ${call.grantFolder}` : ''}</span>
        <span className="bt-label">{t('ui.runs.input')}</span>
        <pre className="ui-lib__pre">{maskTarget(call.input)}</pre>
        {call.output_preview && <><span className="bt-label">{t('ui.runs.output')}</span><pre className="ui-lib__pre">{maskTarget(call.output_preview)}</pre></>}
        {call.conversation_id && <a className="bt-tool__link" href={routeHash({ view: 'chat', id: call.conversation_id })}>{t('ui.runs.openSession')}</a>}
      </div>
    );
  }
  const job = row.job!;
  return (
    <div className="ui-lib__more">
      {job.note && <span>{job.note}</span>}
      {job.changes.length === 0 ? <span>{t('ui.runs.noChanges')}</span> : (
        <ul className="ui-lib__changes">
          {job.changes.map(change => <li key={change.id}>{changeLabel(change.action)} · {change.after ?? change.before}{change.undone_at ? ` · ${t('ui.memory.undone')}` : ''}</li>)}
        </ul>
      )}
      <a className="bt-tool__link" href={routeHash({ view: 'memory' })}>{t('ui.runs.openMemory')}</a>
    </div>
  );
}

export function Runs({ tab, revision, conversations }: { tab?: RunsTab | undefined; revision: number; conversations: readonly Conversation[] }) {
  const t = useT();
  const filter = FILTER_OF(tab);
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const loads = useRef(latestOnly());

  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const [runs, calls, jobs] = await Promise.all([api.runs(), api.toolCalls(), api.reviews()]);
      if (!loads.current.isCurrent(ticket)) return;
      setData({ runs: runs.runs, calls: calls.toolCalls, jobs: jobs.jobs, totals: { run: runs.total, tool: calls.total, review: jobs.total } });
      setFailed(false);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, []);
  useEffect(() => { const timer = setTimeout(() => void load(), 300); return () => clearTimeout(timer); }, [load, revision]);

  const titles = useMemo(() => new Map(conversations.map(c => [c.id, c.title])), [conversations]);
  const rows = useMemo(() => (data ? logRows({ runs: data.runs, calls: data.calls, jobs: data.jobs, runLabel: runKindLabel, titleOf: id => titles.get(id) ?? null }) : []), [data, titles]);
  const shown = useMemo(() => filterLog(rows, filter), [rows, filter]);
  const today = startOfDay(Date.now());
  const footer = data ? logFooter(rows, filter, data.totals, today) : null;
  const pick = (next: LogFilter) => { setOpen(null); location.hash = routeHash({ view: 'runs', ...(TAB_OF[next] ? { tab: TAB_OF[next] } : {}) }); };

  return (
    <div className="bt-screen__inner">
      <header className="bt-screen__head bt-rise">
        <h1 className="bt-screen__title">{t('ui.nav.runs')}</h1>
        <div className="bt-screen__tools">
          <div className="bt-seg" role="group" aria-label={t('ui.runs.kind')}>
            {LOG_FILTERS.map(id => <button key={id} type="button" className="bt-seg__opt" aria-pressed={filter === id} onClick={() => pick(id)}>{t(FILTER_KEY[id])}</button>)}
          </div>
        </div>
      </header>
      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}
      {data && shown.length === 0 && <EmptyState title={t('ui.runs.empty')} />}
      {shown.length > 0 && (
        <div className="bt-table-wrap bt-rise" style={{ '--bt-i': 1 } as CSSProperties}>
          <table className="bt-table ui-lib__table">
            <thead>
              <tr>
                <th>{t('ui.runs.col.time')}</th><th>{t('ui.runs.col.kind')}</th><th>{t('ui.runs.col.what')}</th><th>{t('ui.runs.col.model')}</th>
                <th className="bt-table__num">{t('ui.runs.col.duration')}</th><th className="bt-table__num">{t('ui.runs.col.tokens')}</th><th>{t('ui.runs.col.result')}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(row => {
                const isOpen = open === row.key;
                const toggle = () => setOpen(isOpen ? null : row.key);
                return (
                  <Fragment key={row.key}>
                    <tr className={`ui-lib__logrow${isOpen ? ' is-open' : ''}`} tabIndex={0} aria-expanded={isOpen} onClick={toggle}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
                      <td title={formatDateTime(row.at, 'full')}>{timeText(row.at, today)}</td>
                      <td>{t(KIND_KEY[row.kind])}</td>
                      <td className="bt-table__what" title={row.what}>{row.what}</td>
                      <td>{row.model ?? '—'}</td>
                      <td className="bt-table__num">{durationText(row.durationMs)}</td>
                      <td className="bt-table__num">{tokensText(row.tokens)}</td>
                      <td><Pill tone={RESULT_TONE[row.result]}>{t(RESULT_KEY[row.result])}</Pill></td>
                    </tr>
                    {isOpen && <tr className="ui-lib__detailrow"><td colSpan={7}><Detail row={row} t={t} /></td></tr>}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {footer && <p className="bt-meta bt-rise ui-lib__footer" style={{ '--bt-i': 2 } as CSSProperties}>{t('ui.runs.footer', formatNumber(footer.shown), formatNumber(footer.total))}</p>}
    </div>
  );
}
