import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  api, type Acceptance, type AcceptanceChange, type AcceptanceItem, type AcceptanceVersion, type OwnerOp, type Coverage, type Deviations, type NotDoingItem, type PlanDoc, type Task, type WaitReason,
} from '../../api.ts';
import { waitText } from '../wait.ts';
import { newConversationId } from '../../chat-logic.ts';
import { formatRelative } from '../../i18n/format.ts';
import { useT } from '../../i18n/index.ts';
import { isComposing } from '../../keys.ts';
import { Markdown } from '../../Markdown.tsx';
import {
  acceptanceMeta, addPage, approveDisabled, askAfterSave, askSend, beforeBuildShown, buildAction, buildFailure, buildPill, buildRequest, changedAfterBuild, checkLabel, conversationLink, coverageCounts, coverageGroups,
  decisionFailure, diffLabel, editAccess, editBase, editHint, editOp, editRequest, formProblem, itemDetails, itemForm, loadedAcceptance, noticeAfterReload, outsideContent, pagingCursor, previousVersion, problemField, proposalRows, proposalStale, removeOp, revealSection, revealStep,
  showAcceptance, shownItems, shownNotDoing, sourceLabel, startPaging, stateLabel, stateTone, versionDiff, versionItems, versionSourceLabel, versionsShown, watchedBuild, type BuildFailure, type DecisionFailure, type DiffRow, type EditBase, type ItemForm, type Paging,
} from '../acceptance.ts';
import { useNow } from '../hooks.ts';
import { latestOnly } from '../latest.ts';
import { Button, Icon, Notice, Pill } from '../parts.tsx';
import {
  apiDetail, canEdit, canSave, editedBy, followDoc, keptDraft, PLAN_EDITS, planDirty, planDrafts, planState, rebase, reviewButton, reviewClick, reviewSeen, saveOutcome, startDraft, typed, type PlanDraft, type ReviewSeen, type SaveOutcome,
} from '../plan.ts';
import { RowConfirm } from '../RowConfirm.tsx';
import { ResearchSection } from './ResearchSection.tsx';
import { routeHash } from '../routes.ts';
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

interface Editing {
  hint: string | null; busy: boolean; locked: boolean; base: EditBase; onEdit: (op: OwnerOp, base: EditBase) => Promise<'saved' | 'stale' | 'failed'>;
  typing?: ((id: string, form: ItemForm | null) => void) | undefined;
}

const CHECK_KINDS: ReadonlyArray<ItemForm['check']> = ['command', 'look', 'read'];

function ItemEditor({ item, base, editing, onDone }: { item: AcceptanceItem | null; base: EditBase; editing: Editing; onDone: () => void }) {
  const t = useT();
  const id = useId();
  const [form, setForm] = useState<ItemForm>(() => itemForm(item));
  const problem = formProblem(form);
  const start = itemForm(item);
  const differs = (f: ItemForm) => f.result !== start.result || f.check !== start.check || f.command !== start.command;
  const touched = differs(form);
  const type = (next: ItemForm) => { setForm(next); if (item) editing.typing?.(item.id, differs(next) ? next : null); };
  const finish = () => { if (item) editing.typing?.(item.id, null); onDone(); };
  const shown = touched ? problem : null;
  const field = shown ? problemField(shown) : null;
  const op = problem ? null : editOp(form, item);
  const blocked = editing.busy || editing.locked;
  const save = async () => {
    if (!op || blocked) return;
    if (await editing.onEdit(op, base) !== 'failed') finish();
  };
  const invalid = (which: 'result' | 'command') => (field === which ? { 'aria-invalid': true, 'aria-describedby': `${id}-problem` } : {});
  return (
    <div className="ui-acc__form" onClick={e => e.stopPropagation()}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(); } }}>
      <label className="ui-acc__pair">
        <span className="bt-label">{t('ui.acc.edit.result')}</span>
        <textarea className="bt-field ui-acc__input" rows={2} autoFocus value={form.result} onChange={e => type({ ...form, result: e.target.value })} {...invalid('result')} />
      </label>
      <div className="ui-acc__pair">
        <span className="bt-label">{t('ui.acc.edit.check')}</span>
        <span className="bt-seg" role="group" aria-label={t('ui.acc.edit.check')}>
          {CHECK_KINDS.map(kind => (
            <button key={kind} type="button" className="bt-seg__opt" aria-pressed={form.check === kind} onClick={() => type({ ...form, check: kind })}>{t(checkLabel({ kind } as AcceptanceItem['check']))}</button>
          ))}
        </span>
      </div>
      {form.check === 'command' && (
        <label className="ui-acc__pair">
          <span className="bt-label">{t('ui.acc.edit.command')}</span>
          <input className="bt-field bt-field--mono" spellCheck={false} autoComplete="off" value={form.command} onChange={e => type({ ...form, command: e.target.value })} {...invalid('command')}
            onKeyDown={e => { if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); void save(); } }} />
        </label>
      )}
      {shown && <p id={`${id}-problem`} role="alert" className="bt-meta ui-danger ui-acc__problem">{t(shown)}</p>}
      {editing.hint && <p className="bt-meta ui-acc__problem">{editing.hint}</p>}
      <span className="ui-acc__buttons">
        <Button small disabled={op === null || blocked} onClick={() => void save()}>{t('ui.acc.edit.save')}</Button>
        <Button variant="ghost" small onClick={finish}>{t('ui.acc.edit.cancel')}</Button>
      </span>
    </div>
  );
}

type RowMode = { kind: 'view' } | { kind: 'edit' | 'remove'; base: EditBase };

function Row({ entry, editing, differs = false }: { entry: AcceptanceItem | NotDoingItem; editing?: Editing | undefined; differs?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<RowMode>({ kind: 'view' });
  const editButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef<'edit' | 'remove' | null>(null);
  useEffect(() => {
    if (mode.kind !== 'view' || refocus.current === null) return;
    (refocus.current === 'edit' ? editButton : removeButton).current?.focus();
    refocus.current = null;
  }, [mode]);
  const back = (to: 'edit' | 'remove' | null) => { refocus.current = to; setMode({ kind: 'view' }); };
  const item = 'result' in entry ? entry : null;
  const state = item ? stateLabel(item.state) : null;
  const details = itemDetails(entry);
  const editable = item !== null && editing !== undefined;
  const opens = details.length > 0 || editable;
  const text = 'result' in entry ? entry.result : entry.text;
  const link = conversationLink(entry.source);
  return (
    <li className={`bt-row ui-acc__row${opens ? ' bt-row--link' : ''}`} onClick={opens && mode.kind === 'view' ? () => setOpen(o => !o) : undefined}>
      <span className="bt-tag ui-acc__id">{entry.id}</span>
      <div className="bt-row__main">
        {opens
          ? <button type="button" className="ui-rowbtn ui-acc__text" aria-expanded={open}>{text}</button>
          : <span className="ui-acc__text">{text}</span>}
        <span className="ui-acc__tags">
          <span className="bt-chip">{t(sourceLabel(entry.source))}</span>
          {item && <span className="bt-chip">{t(checkLabel(item.check))}</span>}
          {differs && <span className="bt-chip" data-differs>{t('ui.dev.chip')}</span>}
        </span>
        {open && mode.kind === 'edit' && item && editing && <ItemEditor item={item} base={mode.base} editing={editing} onDone={() => back('edit')} />}
        {open && mode.kind !== 'edit' && (
          <dl className="ui-acc__detail" onClick={e => e.stopPropagation()}>
            {details.map((d, i) => (
              <div key={`${d.label}:${i}`} className="ui-acc__pair">
                <dt className="bt-label">{t(d.label)}</dt>
                <dd className={'text' in d && d.mono ? 'ui-acc__mono' : undefined}>{'text' in d ? d.text : t(d.note)}</dd>
              </div>
            ))}
            {link && <a className="bt-meta ui-acc__link" href={link}>{t('ui.acc.showInConversation')}</a>}
            {editable && item && editing && (mode.kind === 'remove' ? (
              <RowConfirm warn={t('ui.acc.edit.removeWhat')} note={editing.hint ?? undefined} action={t('ui.acc.edit.remove')} busy={editing.busy || editing.locked}
                onConfirm={() => void editing.onEdit(removeOp(item), mode.base).then(out => { if (out !== 'failed') back(null); })} onKeep={again => back(again ? 'remove' : null)} />
            ) : (
              <span className="ui-acc__buttons">
                <Button ref={editButton} variant="ghost" small disabled={editing.busy || editing.locked} onClick={() => setMode({ kind: 'edit', base: editing.base })}>{t('ui.acc.edit.edit')}</Button>
                <Button ref={removeButton} variant="ghost" small disabled={editing.busy || editing.locked} onClick={() => setMode({ kind: 'remove', base: editing.base })}>{t('ui.acc.edit.remove')}</Button>
              </span>
            ))}
          </dl>
        )}
      </div>
      {state && <span className="bt-row__end"><Pill {...(item && stateTone(item.state) ? { tone: stateTone(item.state)! } : {})}>{t(state)}</Pill></span>}
      {opens && <Icon name={open ? 'chevD' : 'chevR'} className="ui-acc__chev" />}
    </li>
  );
}

function DiffList({ rows, removedBy }: { rows: DiffRow[]; removedBy?: string }) {
  const t = useT();
  if (rows.length === 0) return <p className="bt-meta ui-acc__problem">{t('ui.acc.diff.none')}</p>;
  return (
    <ul className="bt-list">
      {rows.map((r, i) => (
        <li key={`${r.kind}:${r.id ?? i}`} className="bt-row ui-acc__row">
          <span className="bt-tag ui-acc__id">{r.id ?? ''}</span>
          <div className="bt-row__main">
            <span className="ui-acc__text">{r.result}</span>
            {r.before !== null && <span className="bt-meta ui-acc__was">{t('ui.acc.diff.was')} · {r.before}</span>}
            <span className="ui-acc__tags">
              <span className="bt-chip">{t(diffLabel(r.kind))}</span>
              {r.source && <span className="bt-chip">{t(sourceLabel(r.source))}</span>}
              {!r.source && r.kind === 'removed' && removedBy && <span className="bt-chip">{removedBy}</span>}
              {r.check && r.kind !== 'removed' && <span className="bt-chip">{t(checkLabel(r.check))}</span>}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ProposedChange({ acc, change, busy, onDecide }: { acc: Acceptance; change: AcceptanceChange; busy: boolean; onDecide: (decision: 'approve' | 'reject') => void }) {
  const t = useT();
  const stale = proposalStale(acc, change);
  return (
    <section className="bt-section ui-acc" aria-label={t('ui.acc.change.title')}>
      <div className="bt-section__head">
        <span className="bt-label">{t('ui.acc.change.title')}</span>
        <span className="bt-meta">{stale ? t('ui.acc.change.stale', change.base_version) : t('ui.acc.change.versions', change.base_version, change.base_version + 1)}</span>
      </div>
      <DiffList rows={proposalRows(acc, change)} />
      <span className="ui-acc__buttons">
        <Button small disabled={approveDisabled(acc, change, busy)} onClick={() => onDecide('approve')}>{t('ui.acc.change.approve')}</Button>
        <Button variant="ghost" small disabled={busy} onClick={() => onDecide('reject')}>{t('ui.acc.change.reject')}</Button>
      </span>
    </section>
  );
}

function VersionRow({ productId, version, previous }: { productId: string; version: AcceptanceVersion; previous: number | null }) {
  const t = useT();
  const now = useNow(60_000);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<DiffRow[] | 'failed' | null>(null);
  useEffect(() => {
    if (!open || rows !== null) return undefined;
    let live = true;
    void Promise.all([api.acceptanceVersion(productId, version.version), previous === null ? null : api.acceptanceVersion(productId, previous)]).then(
      ([after, before]) => { if (live) setRows(versionDiff(before ? versionItems(before.version) : null, versionItems(after.version))); },
      () => { if (live) setRows('failed'); },
    );
    return () => { live = false; };
  }, [open, rows, productId, version.version, previous]);
  const source = versionSourceLabel(version.source);
  const toggle = () => { setOpen(o => !o); if (rows === 'failed') setRows(null); };
  return (
    <li className="bt-row ui-acc__row bt-row--link" onClick={toggle}>
      <span className="bt-tag ui-acc__id">{t('ui.acc.version', version.version)}</span>
      <div className="bt-row__main">
        <button type="button" className="ui-rowbtn ui-acc__text" aria-expanded={open} aria-label={`${t('ui.acc.version', version.version)} · ${source ? t(source) : version.source}`}>{source ? t(source) : version.source}</button>
        {open && (
          <div className="ui-acc__detail" onClick={e => e.stopPropagation()}>
            {rows === 'failed' ? <p className="bt-meta ui-danger ui-acc__problem">{t('ui.acc.versions.loadFailed')}</p> : rows && <DiffList rows={rows} removedBy={source ? t(source) : version.source} />}
          </div>
        )}
      </div>
      <span className="bt-row__end bt-meta">{formatRelative(version.created_at, now)}</span>
      <Icon name={open ? 'chevD' : 'chevR'} className="ui-acc__chev" />
    </li>
  );
}

function Versions({ productId, latest }: { productId: string; latest: number }) {
  const t = useT();
  const [list, setList] = useState<AcceptanceVersion[] | null>(null);
  useEffect(() => {
    let live = true;
    void api.acceptanceVersions(productId).then(r => { if (live) setList(r.versions); }, () => { if (live) setList(null); });
    return () => { live = false; };
  }, [productId, latest]);
  if (!list || list.length === 0) return null;
  return (
    <section className="bt-section ui-acc" aria-label={t('ui.acc.versions.title')}>
      <div className="bt-section__head"><span className="bt-label">{t('ui.acc.versions.title')}</span></div>
      <ul className="bt-list">{versionsShown(list).map(v => <VersionRow key={`${latest}:${v.version}`} productId={productId} version={v} previous={previousVersion(list, v.version)} />)}</ul>
    </section>
  );
}

function AcceptanceList({ acc, editing, differs, building }: { acc: Acceptance; editing: Editing | undefined; differs: ReadonlySet<string>; building: boolean }) {
  const t = useT();
  const [adding, setAdding] = useState<EditBase | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (adding !== null || !refocus.current) return;
    refocus.current = false;
    addButton.current?.focus();
  }, [adding]);
  const [typed, setTyped] = useState<ReadonlyMap<string, ItemForm>>(new Map());
  const track = useCallback((id: string, form: ItemForm | null) => setTyped(old => { const next = new Map(old); if (form) next.set(id, form); else next.delete(id); return next; }), []);
  const items = shownItems(acc);
  const notDoing = shownNotDoing(acc);
  const listed = new Set(items.map(i => i.id));
  const lost = [...typed].filter(([id]) => !listed.has(id));
  const tracked = editing && { ...editing, typing: track };
  return (
    <>
      <section className="bt-section ui-acc" aria-label={t('ui.acc.title')}>
        <div className="bt-section__head">
          <span className="bt-label">{t('ui.acc.title')}</span>
          <span className="bt-meta">{acceptanceMeta(acc, building)}</span>
        </div>
        {lost.length > 0 && (
          <div role="status">
            {lost.map(([id, form]) => (
              <Notice key={id} tone="warn" icon="alert" title={t('ui.acc.edit.lost', id)} text={form.result.trim() ? t('ui.acc.edit.lostText', form.check === 'command' && form.command.trim() ? `${form.result} · ${form.command}` : form.result) : undefined}
                action={{ label: t('ui.close'), run: () => track(id, null) }} />
            ))}
          </div>
        )}
        {items.length > 0 && <ul className="bt-list">{items.map(i => <Row key={i.id} entry={i} editing={tracked} differs={differs.has(i.id)} />)}</ul>}
        {editing && (adding
          ? <ItemEditor item={null} base={adding} editing={editing} onDone={() => { refocus.current = true; setAdding(null); }} />
          : <span className="ui-acc__buttons"><Button ref={addButton} variant="ghost" small icon="plus" disabled={editing.busy || editing.locked} onClick={() => setAdding(editing.base)}>{t('ui.acc.edit.add')}</Button></span>)}
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

const DEVIATIONS_GAP_MS = 10_000;

const NOT_COMPARED = {
  no_git: 'ui.dev.notChecked.no_git', git_unusable: 'ui.dev.notChecked.git_unusable', failed: 'ui.dev.notChecked.failed', folder_missing: 'ui.dev.notChecked.folder_missing',
} as const;
const CHANGE = { added: ['+', 'bt-add', 'ui.dev.change.added'], modified: ['~', '', 'ui.dev.change.modified'], deleted: ['−', 'bt-del', 'ui.dev.change.deleted'] } as const;

function FileRow({ path, change, scripts }: { path: string; change: keyof typeof CHANGE; scripts?: string[] | undefined }) {
  const t = useT();
  const [sign, tone, label] = CHANGE[change];
  return (
    <li className="bt-row ui-acc__row">
      <span className={`ui-acc__sign ${tone}`} title={t(label)}>{sign}</span>
      <div className="bt-row__main">
        <span className="ui-acc__text ui-acc__mono">{path}</span>
        {scripts && scripts.length > 0 && <span className="bt-meta">{t('ui.dev.scripts', scripts.join(', '))}</span>}
      </div>
    </li>
  );
}

function DiffFlagsView({ flags }: { flags: Deviations['flags'] }) {
  const t = useT();
  if (!flags.checked) return <p className="bt-meta ui-acc__problem">{t(NOT_COMPARED[flags.reason])}</p>;
  if (flags.testsDeleted.length === 0 && flags.checkChanged.length === 0) return flags.since === 'build' ? <p className="bt-meta ui-acc__problem">{t('ui.dev.noFlags')}</p> : null;
  return (
    <>
      {flags.testsDeleted.length > 0 && (
        <Group label={t('ui.dev.testsDeleted')}>
          {flags.testsDeleted.map(path => <FileRow key={path} path={path} change="deleted" />)}
          {flags.testsDeletedMore > 0 && <li className="bt-row bt-meta">{t('ui.kanban.more', flags.testsDeletedMore)}</li>}
        </Group>
      )}
      {flags.checkChanged.length > 0 && (
        <Group label={t('ui.dev.checkChanged')}>
          {flags.checkChanged.map(file => <FileRow key={file.path} path={file.path} change={file.change} scripts={file.scripts} />)}
          {flags.checkChangedMore > 0 && <li className="bt-row bt-meta">{t('ui.kanban.more', flags.checkChangedMore)}</li>}
        </Group>
      )}
    </>
  );
}

function Differs({ data }: { data: Deviations }) {
  const t = useT();
  const { rows, unreadable, unusable } = data.deviations;
  const { flags } = data;
  return (
    <section className="bt-section ui-acc" aria-label={t('ui.dev.title')}>
      <div className="bt-section__head">
        <span className="bt-label">{t('ui.dev.title')}</span>
        {flags.checked && <span className="bt-meta">{t(flags.since === 'build' ? 'ui.dev.since.build' : 'ui.dev.since.head')}</span>}
      </div>
      {rows.length > 0 && (
        <ul className="bt-list">
          {rows.map((row, i) => (
            <li key={i} className="bt-row ui-acc__row">
              <span className="bt-tag ui-acc__id">{row.item ?? t('ui.dev.general')}</span>
              <div className="bt-row__main">
                <span className="ui-acc__text">{row.what}</span>
                <span className="bt-meta ui-acc__was">{t('ui.dev.why', row.why)}</span>
                <span className="ui-acc__tags">
                  {row.by === 'task' && row.task ? <a className="bt-chip" href={routeHash({ view: 'task', id: row.task })}>{t('ui.dev.byTask')}</a> : <span className="bt-chip">{t(row.by === 'owner' ? 'ui.dev.byOwner' : 'ui.dev.byTask')}</span>}
                  {row.date && <span className="bt-meta">{row.date}</span>}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {rows.length === 0 && !unusable && <p className="bt-meta ui-acc__problem">{t('ui.dev.none')}</p>}
      {unusable && <p className="bt-meta ui-danger ui-acc__problem">{t('ui.dev.unusable')}</p>}
      {unreadable > 0 && <p className="bt-meta ui-acc__problem">{t('ui.dev.unreadable', unreadable)}</p>}
      <DiffFlagsView flags={flags} />
    </section>
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

function Unreferenced({ productId, conversationId, coverage }: { productId: string; conversationId: string | undefined; coverage: Coverage }) {
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
      const r = await api.acceptance(productId, conversationId, cursor);
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

function BeforeBuild({ productId, conversationId, acc, coverage, sectionRef }: { productId: string; conversationId: string | undefined; acc: Acceptance; coverage: Coverage; sectionRef: Ref<HTMLElement> }) {
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
      {g.picks.length > 0 && <Group label={t('ui.acc.source.pick')}>{g.picks.map(p => <li key={p.item.id} className="bt-row ui-cov__row" data-pick><span className="ui-cov__said">{p.label}</span><span className="ui-cov__arrow" aria-hidden="true">→</span><ItemRef item={p.item} /></li>)}</Group>}
      {g.ai.length > 0 && <Group label={t('ui.acc.source.ai')}>{g.ai.map(i => <li key={i.id} className="bt-row ui-cov__row"><ItemRef item={i} /></li>)}</Group>}
      {g.edited.length > 0 && <Group label={t('ui.acc.source.edit')}>{g.edited.map(i => <li key={i.id} className="bt-row ui-cov__row"><ItemRef item={i} /></li>)}</Group>}
      {coverage.unreferenced_total > 0 && <Unreferenced productId={productId} conversationId={conversationId} coverage={coverage} />}
    </section>
  );
}

export interface PlanPaneProps { productId: string; conversationId?: string | undefined; revision: string; taskRevision?: string; isGit: boolean; reveal?: boolean; onRevealed?: () => void; waits?: Record<string, WaitReason> | undefined }

export function PlanPane({ productId, conversationId, revision, taskRevision = '', isGit, reveal = false, onRevealed, waits }: PlanPaneProps) {
  const t = useT();
  const key = conversationId === undefined ? null : PLAN_EDITS + conversationId;
  const [doc, setDoc] = useState<PlanDoc | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewFailed, setReviewFailed] = useState<{ detail: string | null } | null>(null);
  const [seen, setSeen] = useState<ReviewSeen>({ hash: null, changed: false });
  const [failure, setFailure] = useState<{ detail: string | null } | null>(null);
  const [draft, setDraft] = useState<PlanDraft | null>(() => (key && conversationId ? keptDraft(planDrafts.get(conversationId), hasUnsavedEdits(key)) : null));
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
  const rootRef = useRef<HTMLDivElement>(null);
  const runningRef = useRef<HTMLSpanElement>(null);
  const focusRunning = useRef(false);
  const [change, setChange] = useState<AcceptanceChange | null>(null);
  const [sentBuild, setSentBuild] = useState<string | null>(null);
  const [accBusy, setAccBusy] = useState(false);
  const [accNotice, setAccNotice] = useState<{ what: 'edit' | 'change'; failure: DecisionFailure } | null>(null);
  const [asking, setAsking] = useState(false);
  const [askBusy, setAskBusy] = useState(false);
  const [askFailed, setAskFailed] = useState<{ detail: string | null } | null>(null);

  const loadAcceptance = useCallback(async () => {
    const ticket = accLoads.current.begin();
    try {
      const r = await api.acceptance(productId, conversationId);
      if (!accLoads.current.isCurrent(ticket)) return;
      const next = loadedAcceptance(r);
      setAcc(next.acc);
      setChange(next.change);
      setSentBuild(null);
      setCoverage(next.coverage);
      setAccFailed(false);
      setBuildNotice(current => noticeAfterReload(current, r.acceptance));
    } catch {
      if (accLoads.current.isCurrent(ticket)) setAccFailed(true);
    }
  }, [productId, conversationId]);
  useEffect(() => { void loadAcceptance(); }, [loadAcceptance, revision]);

  const [deviations, setDeviations] = useState<Deviations | null>(null);
  const built = acc?.frozen != null;
  const devAt = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!built) { setDeviations(null); return undefined; }
    const read = () => { devAt.current = Date.now(); void api.deviations(productId).then(r => { if (mounted.current) setDeviations(r); }, () => { if (mounted.current) setDeviations(null); }); };
    const wait = devAt.current + DEVIATIONS_GAP_MS - Date.now();
    if (wait <= 0) { read(); return undefined; }
    const timer = setTimeout(read, wait);
    return () => { clearTimeout(timer); };
  }, [productId, built, revision, taskRevision]);
  const differs = useMemo(() => new Set((deviations?.deviations.rows ?? []).flatMap(row => (row.item ? [row.item] : []))), [deviations]);

  const buildTask = watchedBuild(sentBuild, acc);
  useEffect(() => {
    if (!buildTask) { if (!building) setTask(null); return undefined; }
    let live = true;
    void api.task(buildTask).then(r => { if (live) setTask(r.task); }, () => { if (live) setTask(null); });
    return () => { live = false; };
  }, [buildTask, taskRevision, building]);

  const load = useCallback(async (): Promise<PlanDoc | null> => {
    const ticket = loads.current.begin();
    if (conversationId === undefined) return null;
    try {
      const r = await api.plan(productId, conversationId);
      if (!loads.current.isCurrent(ticket)) return null;
      setDoc(r.plan);
      setFailure(null);
      return r.plan;
    } catch (error) {
      if (loads.current.isCurrent(ticket)) setFailure({ detail: apiDetail(error) });
      return null;
    }
  }, [productId, conversationId]);
  useEffect(() => { void load(); }, [load, revision]);

  useEffect(() => { setDraft(current => followDoc(current, doc)); }, [doc]);
  useEffect(() => { setSeen(prev => reviewSeen(prev, doc?.hash ?? null)); }, [doc?.hash]);

  const dirty = planDirty(draft);
  useEffect(() => {
    if (!key || !conversationId) return;
    setUnsaved(key, dirty);
    if (dirty && draft) planDrafts.set(conversationId, draft); else planDrafts.delete(conversationId);
  }, [key, dirty, draft, conversationId]);

  const planless = conversationId === undefined;
  const state = planState(doc, failure !== null);
  const writing = state === 'writing';
  const action = buildAction({ state, mode, acc, task, isGit, pending: building });
  const pill = buildPill(task?.status);
  const wait = task?.status === 'ready' ? waits?.[task.id] : undefined;
  const shown = beforeBuildShown({ mode, acc, coverage, action });
  const step = revealStep({ reveal, accLoaded: acc !== null, accFailed, state, shown });

  useEffect(() => {
    if (step === 'none' || step === 'wait') return;
    const section = coverageRef.current;
    if (step === 'scroll' && section) revealSection(rootRef.current, section);
    onRevealed?.();
  }, [step, onRevealed]);

  useEffect(() => {
    if (action?.kind !== 'building' || !focusRunning.current) return;
    focusRunning.current = false;
    runningRef.current?.focus();
  }, [action?.kind]);

  const build = async () => {
    const hashes = acc ? buildRequest(doc, acc) : null;
    if (!hashes || building || !conversationId) return;
    setBuilding(true);
    setBuildNotice(null);
    let outcome: BuildFailure | null = null;
    try {
      const r = await api.build(productId, hashes, conversationId);
      focusRunning.current = true;
      setSentBuild(r.task.id);
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
    if (!draft || !canSave(state, dirty, saving) || !conversationId) return;
    setSaving(true);
    try {
      const r = await api.savePlan(productId, conversationId, draft.text, draft.base);
      setDoc(r.plan);
      setDraft(null);
      setMode('read');
      setNotice(null);
      if (askAfterSave(acc)) { setAsking(true); setAskFailed(null); }
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

  const changeItems = async (op: OwnerOp, base: EditBase): Promise<'saved' | 'stale' | 'failed'> => {
    if (!acc || accBusy) return 'failed';
    setAccBusy(true);
    setAccNotice(null);
    let out: 'saved' | 'stale' | 'failed' = 'saved';
    try {
      await api.editAcceptance(productId, editRequest(base, op), conversationId);
    } catch (error) {
      const failure = decisionFailure(error);
      out = failure.kind;
      setAccNotice({ what: 'edit', failure });
    }
    await loadAcceptance();
    setAccBusy(false);
    return out;
  };

  const decide = async (decision: 'approve' | 'reject') => {
    if (!change || accBusy) return;
    setAccBusy(true);
    setAccNotice(null);
    try {
      await api.decideChange(productId, change.id, decision);
    } catch (error) {
      setAccNotice({ what: 'change', failure: decisionFailure(error) });
    }
    await loadAcceptance();
    setAccBusy(false);
  };

  const review = reviewButton(doc, mode, reviewing, seen.changed);
  const markReviewed = async () => {
    if (reviewing || !conversationId) return;
    const click = reviewClick(seen, doc?.hash ?? null);
    if (click.send === null) { setSeen(click.seen); return; }
    setReviewing(true);
    setReviewFailed(null);
    try {
      const r = await api.planReviewed(productId, conversationId, click.send);
      setSeen({ hash: r.plan.hash, changed: false });
      setDoc(r.plan);
    } catch (error) {
      setReviewFailed({ detail: apiDetail(error) });
      await load();
    } finally { setReviewing(false); }
  };

  const ask = async () => {
    if (askBusy) return;
    setAskBusy(true);
    setAskFailed(null);
    try {
      const out = askSend(conversationId ?? null, productId, newConversationId);
      await api.send(out.id, out.text, [], out.choice, out.options);
      setAsking(false);
      location.hash = routeHash({ view: 'chat', id: out.id });
    } catch (error) {
      setAskFailed({ detail: apiDetail(error) });
    } finally { setAskBusy(false); }
  };

  const access = planless && !acc?.frozen ? 'off' : editAccess({ acc, state, mode, pending: building });
  const editing: Editing | undefined = access !== 'off' && acc
    ? { hint: editHint(acc, change), busy: accBusy, locked: access === 'locked', base: editBase(acc), onEdit: changeItems }
    : undefined;

  return (
    <div ref={rootRef} className="ui-plan">
      <div className="bt-pane__bar">
        <Meta doc={doc} writing={writing} />
        {!planless && <span className="bt-seg" role="group" aria-label={t('ui.plan.view')}>
          <button type="button" className="bt-seg__opt" aria-pressed={mode === 'read'} onClick={() => { if (!dirty) setDraft(null); setMode('read'); }}>{t('ui.plan.read')}</button>
          <button type="button" className="bt-seg__opt" aria-pressed={mode === 'edit'} disabled={!canEdit(state) && mode !== 'edit'} onClick={edit}>{t('ui.plan.edit')}</button>
        </span>}
        {mode === 'edit' && <Button variant="primary" small disabled={!canSave(state, dirty, saving)} onClick={() => void save()}>{t('ui.plan.save')}</Button>}
        {!planless && action?.kind === 'build' && <Button variant="primary" small disabled={action.disabled} onClick={() => void build()}>{t(action.label)}</Button>}
        {action?.kind === 'building' && <span ref={runningRef} role="status" tabIndex={-1}><Pill {...(pill.tone ? { tone: pill.tone } : {})}>{t(pill.label)}</Pill></span>}
      </div>
      {acc !== null && !acc.frozen && <ResearchSection productId={productId} conversationId={conversationId} revision={revision} />}
      <div role="status" className="ui-plan__live">
        {action?.kind === 'building' && wait && <p className="bt-meta" data-wait>{waitText(wait)}</p>}
        {buildNotice?.kind === 'changed' && <Notice tone="warn" icon="alert" title={t('ui.plan.buildChanged')} />}
        {buildNotice?.kind === 'frozen' && <Notice tone="warn" icon="alert" title={t('ui.plan.buildFrozen')} text={buildNotice.detail ?? undefined} />}
      </div>
      {buildNotice?.kind === 'failed' && <Notice tone="fail" title={t('ui.plan.buildFailed')} text={buildNotice.detail ?? undefined} />}
      {asking && !askFailed && <div role="status"><Notice title={t('ui.acc.ask.title')} action={{ label: t('ui.acc.ask.ask'), run: () => void ask() }} also={{ label: t('ui.acc.ask.notNow'), run: () => setAsking(false) }} /></div>}
      {asking && askFailed && <Notice tone="fail" title={t('ui.acc.ask.failed')} text={askFailed.detail ?? undefined} action={{ label: t('ui.fail.retry'), run: () => void ask() }} />}
      {shown && acc && coverage && <BeforeBuild productId={productId} conversationId={conversationId} acc={acc} coverage={coverage} sectionRef={coverageRef} />}
      {changedAfterBuild(doc) && <p className="bt-meta ui-plan__after">{t('ui.plan.changedAfterBuild')}</p>}
      {outsideContent(doc, acc) && review !== 'hidden' && <p className="bt-meta ui-acc__outside"><Button small variant="ghost" disabled={review === 'off'} onClick={() => void markReviewed()}>{t(review === 'again' ? 'ui.plan.readNewVersion' : 'ui.plan.markReviewed')}</Button></p>}
      {review !== 'hidden' && seen.changed && <p className="bt-meta ui-acc__outside" role="status"><Icon name="alert" />{t('ui.plan.changedReadAgain')}</p>}
      {reviewFailed && <Notice tone="fail" title={t('ui.plan.reviewFailed')} text={reviewFailed.detail ?? undefined} />}
      {notice?.kind === 'changed' && <Notice tone="warn" icon="alert" title={t('ui.plan.changed')} action={{ label: t('ui.plan.reload'), run: () => void reload() }} also={{ label: t('ui.plan.discard'), run: discard }} />}
      {draft?.replaces && dirty && notice?.kind !== 'changed' && <Notice tone="warn" icon="alert" title={t('ui.plan.rebased')} action={{ label: t('ui.plan.discard'), run: discard }} />}
      {notice?.kind === 'failed' && <Notice tone="fail" title={t('ui.plan.saveFailed')} text={notice.detail ?? undefined} />}
      {planless ? (
        <div className="bt-empty ui-plan__empty">
          <h2 className="bt-empty__title">{t('ui.plan.noConversation')}</h2>
          <p className="bt-meta">{t('ui.plan.emptyText')}</p>
        </div>
      ) : mode === 'edit' ? (
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
        : acc && (
          <>
            {accNotice?.failure.kind === 'stale' && <div role="status"><Notice tone="warn" icon="alert" title={t(accNotice.what === 'edit' ? 'ui.acc.edit.stale' : 'ui.acc.change.staleNotice')} /></div>}
            {accNotice?.failure.kind === 'failed' && <Notice tone="fail" title={t(accNotice.what === 'edit' ? 'ui.acc.edit.failed' : 'ui.acc.change.failed')} text={accNotice.failure.detail ?? undefined} />}
            {change && <ProposedChange acc={acc} change={change} busy={accBusy} onDecide={decision => void decide(decision)} />}
            {showAcceptance(acc) && <AcceptanceList acc={acc} editing={editing} differs={differs} building={building || sentBuild !== null} />}
            {deviations && <Differs data={deviations} />}
            {acc.frozen && <Versions productId={productId} latest={acc.frozen.version} />}
          </>
        ))}
    </div>
  );
}
