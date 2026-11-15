import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { api, type GrowthStats } from '../../api.ts';
import { formatDateTime, getTimezone, useT, type PlainKey } from '../../i18n/index.ts';
import { growthBucket, growthMonths, monthKey, monthLabel, percentText, perTaskText } from '../growth.ts';
import type { LiveDraft } from '../live-state.ts';
import { Notice } from '../parts.tsx';
import { useHomeLoad } from './home-parts.tsx';
import '../styles/growth.css';

const NO_DRAFTS: LiveDraft[] = [];
const CATEGORY_KEY: Record<string, PlainKey> = {
  scope: 'ui.growth.cat.scope', ui: 'ui.growth.cat.ui', data: 'ui.growth.cat.data', naming: 'ui.growth.cat.naming',
  tech: 'ui.growth.cat.tech', security: 'ui.growth.cat.security', other: 'ui.growth.cat.other',
};

function Figure({ id, label, n, meta }: { id: string; label: string; n: string; meta: string }) {
  return (
    <div className="bt-stat ui-growth__stat" data-growth={id}>
      <span className="bt-stat__head"><span className="bt-label">{label}</span></span>
      <span className="bt-stat__n"><span>{n}</span></span>
      <span className="bt-meta">{meta}</span>
    </div>
  );
}

export function GrowthSection({ id, createdAt, revision, index }: { id: string; createdAt: number; revision: number; index: number }) {
  const t = useT();
  const zone = getTimezone();
  const months = useMemo(() => growthMonths(createdAt, Date.now(), zone), [createdAt, zone]);
  const [picked, setPicked] = useState<string | null>(null);
  const month = picked !== null && months.includes(picked) ? picked : (months[0] ?? monthKey(Date.now(), zone));
  const read = useCallback((): Promise<GrowthStats> => api.growthStats(id, month), [id, month]);
  const { data, failed, load } = useHomeLoad(read, revision, NO_DRAFTS);
  const shown = data && data.month === month ? growthBucket(data, month, id) : null;
  const q = shown?.questions;

  return (
    <section className="bt-section bt-rise ui-growth" style={{ '--bt-i': index } as CSSProperties} aria-label={t('ui.growth.title')} data-home="growth">
      <div className="bt-section__head">
        <span className="bt-label">{t('ui.growth.title')}</span>
        <select className="bt-select" value={month} aria-label={t('ui.growth.month')} onChange={e => setPicked(e.target.value)}>
          {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
      </div>

      {failed && <Notice tone="warn" icon="alert" title={t('ui.growth.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}

      {shown && q && data && (
        <>
          <div className="bt-stats">
            <Figure id="perTask" label={t('ui.growth.perTask')} n={perTaskText(q.perTask)} meta={t('ui.growth.perTask.meta', q.asked, shown.tasks)} />
            <Figure id="kept" label={t('ui.growth.kept')} n={percentText(q.keptRate)} meta={t('ui.growth.kept.meta', q.kept, q.answered, q.noAssumption)} />
            <Figure id="notEnough" label={t('ui.growth.notEnough')} n={percentText(shown.checks.notEnoughShare)} meta={t('ui.growth.notEnough.meta', shown.checks.notEnough, shown.checks.decisions)} />
          </div>
          <p className="bt-meta" data-growth="line">{t('ui.growth.line', shown.judgeAsked, shown.pending)}</p>

          <div className="bt-section ui-growth__part" data-growth="categories">
            <div className="bt-section__head"><span className="bt-label">{t('ui.growth.categories')}</span></div>
            {q.byCategory.length === 0 ? <p className="bt-meta ui-col__empty">{t('ui.growth.categories.none')}</p> : (
              <>
                <div className="bt-table-wrap">
                  <table className="bt-table">
                    <thead>
                      <tr>
                        <th>{t('ui.growth.col.category')}</th><th className="bt-table__num">{t('ui.growth.col.asked')}</th><th className="bt-table__num">{t('ui.growth.col.answered')}</th>
                        <th className="bt-table__num">{t('ui.growth.col.kept')}</th><th className="bt-table__num">{t('ui.growth.col.keptRate')}</th><th className="bt-table__num">{t('ui.growth.col.none')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {q.byCategory.map(c => (
                        <tr key={c.category} data-category={c.category}>
                          <td>{CATEGORY_KEY[c.category] ? t(CATEGORY_KEY[c.category]!) : c.category}</td><td className="bt-table__num">{c.asked}</td><td className="bt-table__num">{c.answered}</td>
                          <td className="bt-table__num">{c.kept}</td><td className="bt-table__num">{percentText(c.keptRate)}</td><td className="bt-table__num">{c.noAssumption}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="bt-meta">{t('ui.growth.categories.note')}</p>
              </>
            )}
          </div>

          <div className="bt-section ui-growth__part" data-growth="skills">
            <div className="bt-section__head"><span className="bt-label">{t('ui.growth.skills')}</span></div>
            {shown.skills.length === 0 ? <p className="bt-meta ui-col__empty">{t('ui.growth.skills.none')}</p> : (
              <div className="bt-table-wrap">
                <table className="bt-table">
                  <thead>
                    <tr>
                      <th>{t('ui.growth.col.skill')}</th><th className="bt-table__num">{t('ui.growth.col.uses')}</th><th className="bt-table__num">{t('ui.growth.col.chatUses')}</th>
                      <th className="bt-table__num">{t('ui.growth.col.tasks')}</th><th className="bt-table__num">{t('ui.growth.col.done')}</th><th className="bt-table__num">{t('ui.growth.col.failed')}</th>
                      <th className="bt-table__num">{t('ui.growth.col.cancelled')}</th><th className="bt-table__num">{t('ui.growth.col.unfinished')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.skills.map(s => (
                      <tr key={s.name} data-skill={s.name}>
                        <td className="bt-table__what">{s.name}</td><td className="bt-table__num">{s.uses}</td><td className="bt-table__num">{s.chatUses}</td>
                        <td className="bt-table__num">{s.tasks}</td><td className="bt-table__num">{s.done}</td><td className="bt-table__num">{s.failed}</td>
                        <td className="bt-table__num">{s.cancelled}</td><td className="bt-table__num">{s.unfinished}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="bt-meta" data-growth="since">{data.skillsCountedSince === null ? t('ui.growth.skills.sinceNone') : t('ui.growth.skills.since', formatDateTime(data.skillsCountedSince, 'full'))}</p>
          </div>
        </>
      )}
    </section>
  );
}
