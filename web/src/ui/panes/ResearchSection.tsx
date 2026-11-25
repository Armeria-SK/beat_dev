import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ResearchItem, type ResearchRecord, type ResearchView } from '../../api.ts';
import { useT } from '../../i18n/index.ts';
import { latestOnly } from '../latest.ts';
import { Button, Icon, Notice, Pill } from '../parts.tsx';
import { apiDetail } from '../plan.ts';
import {
  answeredChoices, baseOf, canConfirm, canStart, choiceTag, confirmedLines, confirmFailure, confirmPicks, defaultTag, featureGroups, initialPicks, itemsOf, pickedCount, statusPill,
  type ConfirmFailure, type FeatureDecision, type ResearchPicks,
} from '../research.ts';
import '../styles/research.css';

function Facts({ item }: { item: ResearchItem }) {
  const t = useT();
  const unknown = t('ui.rs.unknown');
  return (
    <dl className="ui-rs__facts">
      <div><dt className="bt-label">{t('ui.rs.license')}</dt><dd>{item.license ?? unknown}</dd></div>
      <div><dt className="bt-label">{t('ui.rs.updated')}</dt><dd>{item.updated ?? unknown}</dd></div>
      <div><dt className="bt-label">{t('ui.rs.language')}</dt><dd>{item.language ?? unknown}</dd></div>
    </dl>
  );
}

function Link({ url }: { url: string | null }) {
  if (!url) return null;
  return <a className="bt-meta ui-rs__url" href={url} target="_blank" rel="noopener noreferrer nofollow">{url}</a>;
}

function SimilarList({ record, picks, setPicks, locked }: { record: ResearchRecord; picks: ResearchPicks; setPicks: (next: ResearchPicks) => void; locked: boolean }) {
  const t = useT();
  const similar = itemsOf(record, 'similar');
  const name = `rs-similar-${record.id}`;
  const is = (id: number, decision: 'use' | 'base') => picks.similar !== null && picks.similar !== 'build' && picks.similar.id === id && picks.similar.decision === decision;
  return (
    <section className="bt-section ui-rs__group" aria-label={t('ui.rs.similar')}>
      <div className="bt-section__head"><span className="bt-label">{t('ui.rs.similar')}</span><span className="bt-meta">{similar.length}</span></div>
      {similar.length === 0 ? <p className="bt-meta">{t('ui.rs.similarNone')}</p> : (
        <ul className="ui-rs__cards">
          {similar.map(item => (
            <li key={item.id} className="bt-card ui-rs__card" data-similar={item.id}>
              <div className="bt-card__head"><h3 className="bt-card__title">{item.name}</h3></div>
              {item.detail && <p className="bt-card__body">{item.detail}</p>}
              <Link url={item.url} />
              <Facts item={item} />
              <fieldset className="bt-choices ui-rs__similar-pick" disabled={locked} aria-label={item.name}>
                <label className="bt-choice"><input type="radio" name={name} checked={is(item.id, 'use')} onChange={() => setPicks({ ...picks, similar: { id: item.id, decision: 'use' } })} /><span>{t('ui.rs.use')}</span></label>
                <label className="bt-choice"><input type="radio" name={name} checked={is(item.id, 'base')} onChange={() => setPicks({ ...picks, similar: { id: item.id, decision: 'base' }, setup: false })} /><span>{t('ui.rs.base')}</span></label>
              </fieldset>
              {is(item.id, 'use') && (
                <div className="ui-rs__use">
                  <label className="ui-rs__line"><input type="checkbox" checked={picks.setup} disabled={locked} onChange={e => setPicks({ ...picks, setup: e.target.checked })} /><span>{t('ui.rs.setup')}</span></label>
                  <input className="bt-field" type="text" maxLength={200} value={picks.memo} disabled={locked} aria-label={t('ui.rs.memo')} placeholder={t('ui.rs.memo')} onChange={e => setPicks({ ...picks, memo: e.target.value })} />
                </div>
              )}
              {is(item.id, 'base') && <p className="bt-meta" data-base-license>{t('ui.rs.baseLicense', item.license ?? t('ui.rs.unknown'))}</p>}
            </li>
          ))}
        </ul>
      )}
      {similar.length > 0 && (
        <label className="bt-choice ui-rs__build"><input type="radio" name={name} disabled={locked} checked={picks.similar === 'build'} onChange={() => setPicks({ ...picks, similar: 'build', setup: false })} /><span>{t('ui.rs.build')}</span></label>
      )}
    </section>
  );
}

function FeatureRow({ item, decision, reason, locked, onDecide, onReason }: { item: ResearchItem; decision: FeatureDecision; reason: string; locked: boolean; onDecide: (d: FeatureDecision) => void; onReason: (text: string) => void }) {
  const t = useT();
  const tag = defaultTag(item);
  return (
    <li className="ui-rs__feature" data-feature={item.id}>
      <label className="bt-choice">
        <input type="checkbox" checked={decision === 'picked'} disabled={locked} onChange={e => onDecide(e.target.checked ? 'picked' : 'later')} />
        <span className="ui-rs__name">{item.name}</span>
        {tag && <span className="bt-label bt-choice__tag" data-tag={item.defaultReason}>{t(tag)}</span>}
      </label>
      {decision !== 'picked' && (
        <button type="button" className="ui-rowbtn bt-meta ui-rs__notneeded" aria-pressed={decision === 'not_needed'} disabled={locked} onClick={() => onDecide(decision === 'not_needed' ? 'later' : 'not_needed')}>
          {t(decision === 'not_needed' ? 'ui.rs.notNeededOn' : 'ui.rs.notNeeded')}
        </button>
      )}
      {decision === 'not_needed' && <input className="bt-field ui-rs__reason" type="text" maxLength={200} value={reason} disabled={locked} aria-label={t('ui.rs.reason')} placeholder={t('ui.rs.reason')} onChange={e => onReason(e.target.value)} />}
    </li>
  );
}

function FeatureList({ record, picks, setPicks, locked }: { record: ResearchRecord; picks: ResearchPicks; setPicks: (next: ResearchPicks) => void; locked: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { missing, onBase } = featureGroups(record, picks);
  const base = baseOf(picks);
  if (missing.length + onBase.length === 0) return null;
  const decide = (id: number, d: FeatureDecision) => setPicks({ ...picks, features: { ...picks.features, [id]: d } });
  return (
    <section className="bt-section ui-rs__group" aria-label={t('ui.rs.features')}>
      <div className="bt-section__head">
        <span className="bt-label">{t(base === null ? 'ui.rs.features' : 'ui.rs.missing')}</span>
        <span className="bt-meta" data-picked>{t('ui.rs.picked', pickedCount(record, picks))}</span>
      </div>
      <ul className="bt-choices ui-rs__features">
        {missing.map(item => <FeatureRow key={item.id} item={item} decision={picks.features[item.id] ?? 'later'} reason={picks.reasons[item.id] ?? ''} locked={locked}
          onDecide={d => decide(item.id, d)} onReason={text => setPicks({ ...picks, reasons: { ...picks.reasons, [item.id]: text } })} />)}
      </ul>
      {onBase.length > 0 && (
        <div className="ui-rs__onbase">
          <button type="button" className="ui-rowbtn bt-meta" aria-expanded={open} onClick={() => setOpen(o => !o)}><Icon name={open ? 'chevD' : 'chevR'} />{t('ui.rs.onBase', onBase.length)}</button>
          {open && <ul className="bt-list">{onBase.map(item => <li key={item.id} className="bt-row bt-meta" data-onbase={item.id}>{item.name}</li>)}</ul>}
        </div>
      )}
    </section>
  );
}

function ChoiceCard({ item, picked, locked, onPick }: { item: ResearchItem; picked: number | undefined; locked: boolean; onPick: (index: number) => void }) {
  const t = useT();
  const name = `rs-choice-${item.id}`;
  return (
    <div className="bt-question ui-rs__choice" data-choice={item.id}>
      <h3 className="bt-question__q">{item.name}</h3>
      {item.detail && <p className="bt-question__why">{item.detail}</p>}
      <fieldset className="bt-choices" disabled={locked} aria-label={item.name}>
        {(item.options ?? []).map((option, index) => {
          const tag = choiceTag(item, index);
          return (
            <label key={index} className="bt-choice">
              <input type="radio" name={name} checked={picked === index} onChange={() => onPick(index)} />
              <span>{option}</span>
              {tag && <span className="bt-label bt-choice__tag" data-tag={tag === 'ui.rs.tag.ai' ? 'ai' : 'measures'}>{t(tag)}</span>}
            </label>
          );
        })}
      </fieldset>
      {picked === undefined && <p className="bt-meta" data-unanswered>{t('ui.rs.unanswered')}</p>}
    </div>
  );
}

function LibraryList({ record }: { record: ResearchRecord }) {
  const t = useT();
  const libraries = itemsOf(record, 'library');
  if (libraries.length === 0) return null;
  return (
    <section className="bt-section ui-rs__group" aria-label={t('ui.rs.libraries')}>
      <div className="bt-section__head"><span className="bt-label">{t('ui.rs.libraries')}</span><span className="bt-meta">{libraries.length}</span></div>
      <ul className="bt-list">
        {libraries.map(item => (
          <li key={item.id} className="bt-row ui-rs__lib">
            <div className="bt-row__main"><span className="bt-row__title">{item.name}</span><Link url={item.url} /><Facts item={item} /></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

const LINE = { use: 'ui.rs.done.use', base: 'ui.rs.done.base', build: 'ui.rs.done.build', feature: 'ui.rs.done.feature', choice: 'ui.rs.done.choice' } as const;

function Confirmed({ record }: { record: ResearchRecord }) {
  const t = useT();
  const lines = confirmedLines(record);
  if (lines.length === 0) return <p className="bt-meta">{t('ui.rs.done.nothing')}</p>;
  return (
    <ul className="bt-list ui-rs__confirmed">
      {lines.map((line, i) => <li key={i} className="bt-row"><span className="bt-chip">{t(LINE[line.kind])}</span><span className="bt-row__main">{line.kind === 'choice' ? `${line.name} · ${line.option}` : line.name}</span></li>)}
    </ul>
  );
}

function Record({ record, onChanged, onStart }: { record: ResearchRecord; onChanged: () => void; onStart: (() => void) | null }) {
  const t = useT();
  const [picks, setPicks] = useState<ResearchPicks>(() => initialPicks(record));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ConfirmFailure | null>(null);
  const shown = useRef(record.shownHash);
  useEffect(() => {
    if (shown.current === record.shownHash) return;
    shown.current = record.shownHash;
    setPicks(initialPicks(record));
  }, [record]);
  const pill = statusPill(record);
  const running = record.status === 'running';
  const locked = !canConfirm(record) || busy;
  const confirm = async () => {
    if (locked) return;
    setBusy(true);
    setFailure(null);
    try {
      await api.confirmResearch(record.id, record.shownHash, confirmPicks(record, picks));
      onChanged();
    } catch (error) {
      const next = confirmFailure(error);
      setFailure(next);
      if (next.kind === 'changed') onChanged();
    } finally { setBusy(false); }
  };
  const skip = async () => {
    setBusy(true);
    try { await api.skipResearch(record.id); } catch (error) { setFailure({ kind: 'failed', detail: apiDetail(error) }); }
    onChanged();
    setBusy(false);
  };
  const choices = itemsOf(record, 'choice');
  const empty = record.items.length === 0;
  // 似ている製品の調べが失敗して 0 件のとき、このボタンは「選びで計画する」ではなく、次の段（ライブラリの調べ）へ進む唯一の道
  const goesOn = record.phase === 'products' && record.status === 'failed' && empty;
  return (
    <div className="ui-rs__record" data-phase={record.phase} data-status={record.status}>
      <div className="ui-rs__bar">
        <span className="bt-label">{t(record.phase === 'products' ? 'ui.rs.phase.products' : 'ui.rs.phase.libraries')}</span>
        <Pill {...(pill.tone ? { tone: pill.tone } : {})}>{t(pill.label)}</Pill>
        {running && <Button small variant="ghost" disabled={busy} onClick={() => void skip()}>{t('ui.rs.skip')}</Button>}
        {onStart && (record.status === 'failed' || record.status === 'cancelled' || record.status === 'skipped') && <Button small variant="ghost" disabled={busy} onClick={onStart}>{t('ui.rs.again')}</Button>}
      </div>
      {running && <p className="bt-meta" role="status">{t(record.phase === 'products' ? 'ui.rs.runningText' : 'ui.rs.runningLibraries')}</p>}
      {record.partial && <p className="bt-meta" data-partial>{t(record.stopReason === 'time' ? 'ui.rs.partialTime' : record.stopReason === 'stopped' ? 'ui.rs.partialStopped' : record.stopReason === 'part_failed' ? 'ui.rs.partFailed' : 'ui.rs.partial')}</p>}
      {record.status === 'skipped' && <p className="bt-meta">{t('ui.rs.skippedText')}</p>}
      {record.status === 'failed' && <p className="bt-meta ui-danger" data-failed={record.stopReason ?? ''}>{t(record.stopReason === 'search_blocked' ? 'ui.rs.searchBlocked' : 'ui.rs.failedText')}</p>}
      {record.status === 'cancelled' && <p className="bt-meta">{t('ui.rs.cancelledText')}</p>}
      {record.status === 'confirmed' ? <Confirmed record={record} /> : (
        <>
          {empty && !running && record.status !== 'skipped' && record.stopReason !== 'search_blocked' && <p className="bt-meta" data-empty>{t('ui.rs.none')}</p>}
          {record.phase === 'products' && !empty && <SimilarList record={record} picks={picks} setPicks={setPicks} locked={locked} />}
          {record.phase === 'products' && <FeatureList record={record} picks={picks} setPicks={setPicks} locked={locked} />}
          {choices.length > 0 && (
            <section className="bt-section ui-rs__group" aria-label={t('ui.rs.choices')}>
              <div className="bt-section__head"><span className="bt-label">{t('ui.rs.choices')}</span><span className="bt-meta">{t('ui.rs.answered', answeredChoices(record, picks), choices.length)}</span></div>
              {choices.map(item => <ChoiceCard key={item.id} item={item} picked={picks.choices[item.id]} locked={locked} onPick={index => setPicks({ ...picks, choices: { ...picks.choices, [item.id]: index } })} />)}
            </section>
          )}
          <LibraryList record={record} />
          {canConfirm(record) && (
            <div className="bt-card__actions ui-rs__actions">
              <Button variant="primary" small disabled={locked} onClick={() => void confirm()}>{t(goesOn ? 'ui.rs.confirmGoOn' : 'ui.rs.confirm')}</Button>
              <span className="bt-meta">{t(record.phase === 'products' ? 'ui.rs.confirmWhat' : 'ui.rs.confirmWhatLibraries')}</span>
            </div>
          )}
          {failure?.kind === 'busy' && <p className="bt-meta" role="status" data-busy>{t('ui.rs.busy')}</p>}
          {failure?.kind === 'changed' && <p className="bt-meta" role="status" data-changed>{t('ui.rs.changed')}</p>}
          {failure?.kind === 'failed' && <Notice tone="fail" title={t('ui.rs.confirmFailed')} text={failure.detail ?? undefined} />}
        </>
      )}
    </div>
  );
}

export function ResearchSection({ productId, conversationId, revision }: { productId: string; conversationId: string | undefined; revision: string }) {
  const t = useT();
  const [view, setView] = useState<ResearchView | null>(null);
  const [failed, setFailed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startFailed, setStartFailed] = useState<string | null>(null);
  const loads = useRef(latestOnly());
  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const next = await api.research(productId);
      if (!loads.current.isCurrent(ticket)) return;
      setView(next);
      setFailed(false);
    } catch (error) {
      if (!loads.current.isCurrent(ticket)) return;
      if ((error as { status?: unknown } | null)?.status === 404) { setView(null); setFailed(false); } else setFailed(true);
    }
  }, [productId]);
  useEffect(() => { void load(); }, [load, revision]);
  const start = async () => {
    if (!conversationId || starting) return;
    setStarting(true);
    setStartFailed(null);
    try { await api.startResearch(productId, conversationId); } catch (error) { setStartFailed(apiDetail(error) ?? t('ui.rs.startFailed')); }
    await load();
    setStarting(false);
  };
  if (failed) return <Notice tone="fail" alert={false} title={t('ui.rs.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />;
  if (!view) return null;
  const products = view.products;
  const startable = conversationId !== undefined && canStart(products) && !starting ? () => void start() : null;
  return (
    <section className="bt-section ui-rs" aria-label={t('ui.rs.title')}>
      <div className="bt-section__head"><span className="bt-label">{t('ui.rs.title')}</span></div>
      {products === null ? (
        <div className="ui-rs__start">
          <p className="bt-meta">{t(view.settings.when === 'new' ? 'ui.rs.startAuto' : 'ui.rs.startButton')}</p>
          {startable && <Button small onClick={startable}>{t('ui.rs.start')}</Button>}
        </div>
      ) : <Record key={products.id} record={products} onChanged={() => void load()} onStart={startable} />}
      {view.libraries && <Record key={view.libraries.id} record={view.libraries} onChanged={() => void load()} onStart={null} />}
      {startFailed && <p className="bt-meta ui-danger" role="alert">{startFailed}</p>}
    </section>
  );
}
