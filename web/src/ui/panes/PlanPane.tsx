import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { api, type Acceptance, type AcceptanceItem, type Coverage, type NotDoingItem, type PlanDoc, type Task } from '../../api.ts';
import { formatRelative } from '../../i18n/format.ts';
import { useT } from '../../i18n/index.ts';
import { Markdown } from '../../Markdown.tsx';
import {
  acceptanceMeta, addPage, beforeBuildShown, buildAction, buildFailure, buildRequest, changedAfterBuild, checkLabel, conversationLink, coverageCounts, coverageGroups, itemDetails, noticeAfterReload, outsideContent, pagingCursor,
  revealStep, showAcceptance, shownItems, shownNotDoing, sourceLabel, startPaging, stateLabel, type BuildFailure, type Paging,
} from '../acceptance.ts';
import { useNow } from '../hooks.ts';
import { latestOnly } from '../latest.ts';
import { Button, Icon, Notice, Pill } from '../parts.tsx';
import {
  apiDetail, canEdit, canSave, editedBy, followDoc, keptDraft, PLAN_EDITS, planDirty, planDrafts, planState, rebase, saveOutcome, startDraft, typed, type PlanDraft, type SaveOutcome,
} from '../plan.ts';
import { hasUnsavedEdits, setUnsaved } from '../unsaved.ts';

function Meta({ doc, writing }: { doc: PlanDoc | null; writing: boolean }) {
  const t = useT();
  const now = useNow(60_000);
  const file = t('ui.plan.file');
  if (writing) return <span className="bt-meta">{file} · {t('ui.plan.beingWritten')}</span>;
  if (!doc?.content || doc.updated_at === null) return <span className="bt-meta">{file}</span>;
  const when = formatRelative(doc.updated_at, now);
  const by = editedBy(doc);
  return <span className="bt-meta">{file} · {by ? t('ui.plan.editedBy', when, t(by)) : t('ui.plan.edited', when)}</span>;
}

function Row({ entry }: { entry: AcceptanceItem | NotDoingItem }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const item = 'result' in entry ? entry : null;
  const state = item ? stateLabel(item.state) : null;
  const details = itemDetails(entry);
  const opens = details.length > 0;
  const text = 'result' in entry ? entry.result : entry.text;
  const link = conversationLink(entry.source);
  return (
    <li className={`bt-row ui-acc__row${opens ? ' bt-row--link' : ''}`} onClick={opens ? () => setOpen(o => !o) : undefined}>
      <span className="bt-tag ui-acc__id">{entry.id}</span>
      <div className="bt-row__main">
        {opens
          ? <button type="button" className="ui-rowbtn ui-acc__text" aria-expanded={open}>{text}</button>
          : <span className="ui-acc__text">{text}</span>}
        <span className="ui-acc__tags">
          <span className="bt-chip">{t(sourceLabel(entry.source))}</span>
          {item && <span className="bt-chip">{t(checkLabel(item.check))}</span>}
        </span>
        {open && (
          <dl className="ui-acc__detail" onClick={e => e.stopPropagation()}>
            {details.map(d => (
              <div key={d.label} className="ui-acc__pair">
                <dt className="bt-label">{t(d.label)}</dt>
                <dd className={'text' in d && d.mono ? 'ui-acc__mono' : undefined}>{'text' in d ? d.text : t(d.note)}</dd>
              </div>
            ))}
            {link && <a className="bt-meta ui-acc__link" href={link}>{t('ui.acc.showInConversation')}</a>}
          </dl>
        )}
      </div>
      {state && <span className="bt-row__end"><Pill>{t(state)}</Pill></span>}
      {opens && <Icon name={open ? 'chevD' : 'chevR'} className="ui-acc__chev" />}
    </li>
  );
}

function AcceptanceList({ acc }: { acc: Acceptance }) {
  const t = useT();
  const items = shownItems(acc);
  const notDoing = shownNotDoing(acc);
  return (
    <>
      <section className="bt-section ui-acc" aria-label={t('ui.acc.title')}>
        <div className="bt-section__head">
          <span className="bt-label">{t('ui.acc.title')}</span>
          <span className="bt-meta">{acceptanceMeta(acc)}</span>
        </div>
        {items.length > 0 && <ul className="bt-list">{items.map(i => <Row key={i.id} entry={i} />)}</ul>}
      </section>
      {notDoing.length > 0 && (
        <section className="bt-section ui-acc" aria-label={t('ui.acc.notDoing')}>
          <div className="bt-section__head"><span className="bt-label">{t('ui.acc.notDoing')}</span></div>
          <ul className="bt-list">{notDoing.map(i => <Row key={i.id} entry={i} />)}</ul>
        </section>
      )}
    </>
  );
}

function ItemRef({ item }: { item: AcceptanceItem }) {
  return <span className="ui-cov__item"><span className="bt-tag">{item.id}</span><span className="ui-cov__result">{item.result}</span></span>;
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-cov__group">
      <span className="bt-label">{label}</span>
      <ul className="bt-list">{children}</ul>
    </div>
  );
}

function Unreferenced({ productId, coverage }: { productId: string; coverage: Coverage }) {
  const t = useT();
  const now = useNow(60_000);
  const [open, setOpen] = useState(false);
  const generation = useRef(0);
  const [paging, setPaging] = useState<Paging>(() => startPaging(coverage.unreferenced, 0));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    generation.current += 1;
    setPaging(startPaging(coverage.unreferenced, generation.current));
    setFailed(false);
    setBusy(false);
  }, [coverage]);
  const list = paging.list;
  const cursor = pagingCursor(paging, coverage.unreferenced_total);
  const more = async () => {
    if (cursor === null || busy) return;
    const asked = generation.current;
    setBusy(true);
    try {
      const r = await api.acceptance(productId, cursor);
      setPaging(current => addPage(current, asked, r.coverage?.unreferenced ?? []));
      if (asked === generation.current) setFailed(false);
    } catch {
      if (asked === generation.current) setFailed(true);
    } finally {
      if (asked === generation.current) setBusy(false);
    }
  };
  return (
    <div className="ui-cov__group">
      <button type="button" className="ui-rowbtn ui-cov__toggle bt-meta" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Icon name={open ? 'chevD' : 'chevR'} />{t('ui.cov.unreferenced', coverage.unreferenced_total)}
      </button>
      {open && (
        <>
          <ul className="bt-list">
            {list.map(m => (
              <li key={m.message_id} className="bt-row ui-cov__row">
                <span className="bt-row__main ui-cov__said">{m.text}</span>
                <span className="bt-row__end bt-meta">{formatRelative(m.created_at, now)}</span>
              </li>
            ))}
          </ul>
          {failed && <p className="bt-meta ui-danger">{t('ui.cov.moreFailed')}</p>}
          {cursor !== null && <Button variant="ghost" small disabled={busy} onClick={() => void more()}>{t('ui.cov.more')}</Button>}
        </>
      )}
    </div>
  );
}

function BeforeBuild({ productId, acc, coverage, sectionRef }: { productId: string; acc: Acceptance; coverage: Coverage; sectionRef: Ref<HTMLElement> }) {
  const t = useT();
  const g = coverageGroups(acc);
  const empty = shownItems(acc).length === 0;
  return (
    <section ref={sectionRef} tabIndex={-1} className="bt-section ui-cov" aria-label={t('ui.cov.title')}>
      <div className="bt-section__head"><span className="bt-label">{t('ui.cov.title')}</span></div>
      {empty ? <p className="bt-meta ui-cov__empty">{t('ui.cov.empty')}</p> : (
        <p className="ui-cov__counts">{coverageCounts(coverage).map(([key, n]) => <span key={key}>{t(key, n)}</span>)}</p>
      )}
      {g.words.length > 0 && (
        <Group label={t('ui.acc.source.words')}>
          {g.words.map(w => {
            const link = conversationLink(w.item.source);
            return (
              <li key={w.item.id} className="bt-row ui-cov__row">
                <span className="ui-cov__said">{w.quote}</span><span className="ui-cov__arrow" aria-hidden="true">→</span><ItemRef item={w.item} />
                {link && <a className="bt-meta" href={link}>{t('ui.acc.showInConversation')}</a>}
              </li>
            );
          })}
        </Group>
      )}
      {g.answers.length > 0 && (
        <Group label={t('ui.cov.answersLabel')}>
          {g.answers.map(a => <li key={a.item.id} className="bt-row ui-cov__row"><span className="ui-cov__said">{a.question} · {a.answer}</span><span className="ui-cov__arrow" aria-hidden="true">→</span><ItemRef item={a.item} /></li>)}
        </Group>
      )}
      {g.ai.length > 0 && <Group label={t('ui.acc.source.ai')}>{g.ai.map(i => <li key={i.id} className="bt-row ui-cov__row"><ItemRef item={i} /></li>)}</Group>}
      {g.edited.length > 0 && <Group label={t('ui.acc.source.edit')}>{g.edited.map(i => <li key={i.id} className="bt-row ui-cov__row"><ItemRef item={i} /></li>)}</Group>}
      {coverage.unreferenced_total > 0 && <Unreferenced productId={productId} coverage={coverage} />}
    </section>
  );
}

export interface PlanPaneProps { productId: string; revision: string; taskRevision?: string; isGit: boolean; reveal?: boolean; onRevealed?: () => void }

export function PlanPane({ productId, revision, taskRevision = '', isGit, reveal = false, onRevealed }: PlanPaneProps) {
  const t = useT();
  const key = PLAN_EDITS + productId;
  const [doc, setDoc] = useState<PlanDoc | null>(null);
  const [failure, setFailure] = useState<{ detail: string | null } | null>(null);
  const [draft, setDraft] = useState<PlanDraft | null>(() => keptDraft(planDrafts.get(productId), hasUnsavedEdits(key)));
  const [mode, setMode] = useState<'read' | 'edit'>(draft ? 'edit' : 'read');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<SaveOutcome | null>(null);
  const loads = useRef(latestOnly());
  const [acc, setAcc] = useState<Acceptance | null>(null);
  const [accFailed, setAccFailed] = useState(false);
  const accLoads = useRef(latestOnly());
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildNotice, setBuildNotice] = useState<BuildFailure | null>(null);
  const coverageRef = useRef<HTMLElement>(null);
  const runningRef = useRef<HTMLSpanElement>(null);
  const focusRunning = useRef(false);

  const loadAcceptance = useCallback(async () => {
    const ticket = accLoads.current.begin();
    try {
      const r = await api.acceptance(productId);
      if (!accLoads.current.isCurrent(ticket)) return;
      setAcc(r.acceptance);
      setCoverage(r.coverage ?? null);
      setAccFailed(false);
      setBuildNotice(current => noticeAfterReload(current, r.acceptance));
    } catch {
      if (accLoads.current.isCurrent(ticket)) setAccFailed(true);
    }
  }, [productId]);
  useEffect(() => { void loadAcceptance(); }, [loadAcceptance, revision]);

  const buildTask = acc?.frozen?.build_task_id ?? null;
  useEffect(() => {
    if (!buildTask) { if (!building) setTask(null); return undefined; }
    let live = true;
    void api.task(buildTask).then(r => { if (live) setTask(r.task); }, () => { if (live) setTask(null); });
    return () => { live = false; };
  }, [buildTask, taskRevision, building]);

  const load = useCallback(async (): Promise<PlanDoc | null> => {
    const ticket = loads.current.begin();
    try {
      const r = await api.plan(productId);
      if (!loads.current.isCurrent(ticket)) return null;
      setDoc(r.plan);
      setFailure(null);
      return r.plan;
    } catch (error) {
      if (loads.current.isCurrent(ticket)) setFailure({ detail: apiDetail(error) });
      return null;
    }
  }, [productId]);
  useEffect(() => { void load(); }, [load, revision]);

  useEffect(() => { setDraft(current => followDoc(current, doc)); }, [doc]);

  const dirty = planDirty(draft);
  useEffect(() => {
    setUnsaved(key, dirty);
    if (dirty && draft) planDrafts.set(productId, draft); else planDrafts.delete(productId);
  }, [key, dirty, draft, productId]);

  const state = planState(doc, failure !== null);
  const writing = state === 'writing';
  const action = buildAction({ state, mode, acc, task, isGit, pending: building });
  const shown = beforeBuildShown({ mode, acc, coverage, action });
  const step = revealStep({ reveal, accLoaded: acc !== null, accFailed, state, shown });

  useEffect(() => {
    if (step === 'none' || step === 'wait') return;
    const section = coverageRef.current;
    if (step === 'scroll' && section) { section.scrollIntoView({ block: 'start' }); section.focus({ preventScroll: true }); }
    onRevealed?.();
  }, [step, onRevealed]);

  useEffect(() => {
    if (action?.kind !== 'building' || !focusRunning.current) return;
    focusRunning.current = false;
    runningRef.current?.focus();
  }, [action?.kind]);

  const build = async () => {
    const hashes = acc ? buildRequest(doc, acc) : null;
    if (!hashes || building) return;
    setBuilding(true);
    setBuildNotice(null);
    let outcome: BuildFailure | null = null;
    try {
      const r = await api.build(productId, hashes);
      focusRunning.current = true;
      setTask(r.task);
    } catch (error) {
      const failure = buildFailure(error);
      if (failure.kind !== 'running') outcome = failure;
      if (failure.kind === 'changed') void load();
    }
    await loadAcceptance();
    if (outcome) setBuildNotice(outcome);
    setBuilding(false);
  };

  const save = async () => {
    if (!draft || !canSave(state, dirty, saving)) return;
    setSaving(true);
    try {
      const r = await api.savePlan(productId, draft.text, draft.base);
      setDoc(r.plan);
      setDraft(null);
      setMode('read');
      setNotice(null);
    } catch (error) {
      setNotice(saveOutcome(error));
    } finally { setSaving(false); }
  };

  const reload = async () => {
    setNotice(null);
    setMode('read');
    const fresh = await load();
    if (fresh) setDraft(current => (current ? rebase(current, fresh) : current));
  };

  const discard = () => {
    setDraft(null);
    setNotice(null);
    setMode('read');
    void load();
  };

  const edit = () => {
    if (draft === null) setDraft(startDraft(doc));
    setMode('edit');
  };

  return (
    <div className="ui-plan">
      <div className="bt-pane__bar">
        <Meta doc={doc} writing={writing} />
        <span className="bt-seg" role="group" aria-label={t('ui.plan.view')}>
          <button type="button" className="bt-seg__opt" aria-pressed={mode === 'read'} onClick={() => { if (!dirty) setDraft(null); setMode('read'); }}>{t('ui.plan.read')}</button>
          <button type="button" className="bt-seg__opt" aria-pressed={mode === 'edit'} disabled={!canEdit(state) && mode !== 'edit'} onClick={edit}>{t('ui.plan.edit')}</button>
        </span>
        {mode === 'edit' && <Button variant="primary" small disabled={!canSave(state, dirty, saving)} onClick={() => void save()}>{t('ui.plan.save')}</Button>}
        {action?.kind === 'build' && <Button variant="primary" small disabled={action.disabled} onClick={() => void build()}>{t(action.label)}</Button>}
        {action?.kind === 'building' && <span ref={runningRef} role="status" tabIndex={-1}><Pill tone="running">{t('ui.plan.building')}</Pill></span>}
      </div>
      {buildNotice?.kind === 'changed' && <div role="status"><Notice tone="warn" icon="alert" title={t('ui.plan.buildChanged')} /></div>}
      {buildNotice?.kind === 'frozen' && <div role="status"><Notice tone="warn" icon="alert" title={t('ui.plan.buildFrozen')} text={buildNotice.detail ?? undefined} /></div>}
      {buildNotice?.kind === 'failed' && <Notice tone="fail" title={t('ui.plan.buildFailed')} text={buildNotice.detail ?? undefined} />}
      {shown && acc && coverage && <BeforeBuild productId={productId} acc={acc} coverage={coverage} sectionRef={coverageRef} />}
      {changedAfterBuild(doc, acc) && <p className="bt-meta ui-plan__after">{t('ui.plan.changedAfterBuild')}</p>}
      {outsideContent(doc, acc) && <p className="bt-meta ui-acc__outside"><Icon name="alert" />{t('ui.acc.outside')}</p>}
      {notice?.kind === 'changed' && <Notice tone="warn" icon="alert" title={t('ui.plan.changed')} action={{ label: t('ui.plan.reload'), run: () => void reload() }} also={{ label: t('ui.plan.discard'), run: discard }} />}
      {draft?.replaces && dirty && notice?.kind !== 'changed' && <Notice tone="warn" icon="alert" title={t('ui.plan.rebased')} action={{ label: t('ui.plan.discard'), run: discard }} />}
      {notice?.kind === 'failed' && <Notice tone="fail" title={t('ui.plan.saveFailed')} text={notice.detail ?? undefined} />}
      {mode === 'edit' ? (
        <textarea className="bt-doc bt-doc--edit ui-plan__editor" aria-label={t('ui.plan.editor')} spellCheck={false} value={draft?.text ?? ''}
          onChange={e => setDraft(typed(draft, doc, e.target.value))}
          onKeyDown={e => { if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }} />
      ) : state === 'failed' ? (
        <Notice tone="fail" title={t('ui.plan.loadFailed')} text={failure?.detail ?? undefined} action={{ label: t('ui.fail.retry'), run: () => void load() }} />
      ) : state === 'empty' ? (
        <div className="bt-empty ui-plan__empty">
          <h2 className="bt-empty__title">{t('ui.plan.emptyTitle')}</h2>
          <p className="bt-meta">{t('ui.plan.emptyText')}</p>
        </div>
      ) : doc && (state === 'ready' || writing) ? (
        <div className="bt-doc ui-plan__doc">
          {doc.content && <Markdown text={doc.content} />}
          {writing && <span className="bt-caret" />}
        </div>
      ) : null}
      {mode === 'read' && (accFailed
        ? <Notice tone="fail" title={t('ui.acc.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void loadAcceptance() }} />
        : acc && showAcceptance(acc) && <AcceptanceList acc={acc} />)}
    </div>
  );
}
