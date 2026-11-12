import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Acceptance, type AcceptanceItem, type NotDoingItem, type PlanDoc } from '../../api.ts';
import { formatRelative } from '../../i18n/format.ts';
import { useT } from '../../i18n/index.ts';
import { Markdown } from '../../Markdown.tsx';
import { acceptanceMeta, checkLabel, conversationLink, itemDetails, outsideContent, showAcceptance, shownItems, shownNotDoing, sourceLabel, stateLabel } from '../acceptance.ts';
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

export function PlanPane({ productId, revision }: { productId: string; revision: string }) {
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

  const loadAcceptance = useCallback(async () => {
    const ticket = accLoads.current.begin();
    try {
      const r = await api.acceptance(productId);
      if (!accLoads.current.isCurrent(ticket)) return;
      setAcc(r.acceptance);
      setAccFailed(false);
    } catch {
      if (accLoads.current.isCurrent(ticket)) setAccFailed(true);
    }
  }, [productId]);
  useEffect(() => { void loadAcceptance(); }, [loadAcceptance, revision]);

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
      </div>
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
