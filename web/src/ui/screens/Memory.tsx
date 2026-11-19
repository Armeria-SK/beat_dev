import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError, type MemoryFileEvent, type MemoryNote, type Project } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatDateTime, formatRelative, useT } from '../../i18n/index.ts';
import { Markdown } from '../../Markdown.tsx';
import { DiscardConfirm, useDiscardAsk, useUnsaved } from '../Discard.tsx';
import { pickFocus } from '../focus.ts';
import { useNow } from '../hooks.ts';
import { latestOnly } from '../latest.ts';
import { eventWho, lineDelta, NOTE_CONTENT_MAX, NOTE_TITLE_MAX, notePath, noteStamp, noteVersions, splitNote, type NoteVersion } from '../memory-notes.ts';
import { Button, EmptyState, Icon, Notice } from '../parts.tsx';
import { routeHash } from '../routes.ts';
import { RowConfirm } from '../RowConfirm.tsx';
import type { UiIconName } from '../icons.ts';
import { hasUnsavedEdits, SCREEN_EDITS, setUnsaved } from '../unsaved.ts';
import '../styles/memory.css';

type T = ReturnType<typeof useT>;
interface Loaded { notes: MemoryNote[]; archived: boolean }

const ACTION_KEY = {
  create: 'ui.memory.action.create', update: 'ui.memory.action.update', forget: 'ui.memory.action.forget',
  restore: 'ui.memory.action.restore', outside: 'ui.memory.action.outside', reviewed: 'ui.memory.action.reviewed',
} as const satisfies Record<MemoryFileEvent['action'], string>;
const ACTION_ICON: Record<MemoryFileEvent['action'], UiIconName> = { create: 'plus', update: 'pencil', forget: 'x', restore: 'undo', outside: 'pencil', reviewed: 'check' };
const EDITS = `${SCREEN_EDITS}memory`;

const failText = (error: unknown, t: T): string => (error instanceof ApiError ? error.message : t('ui.memory.toast.failed'));
const whoText = (t: T, who: 'you' | 'beat'): string => t(who === 'you' ? 'ui.lib.you' : 'ui.lib.beat');

async function undoDelete(projectId: string, name: string): Promise<void> {
  const { events } = await api.memoryNoteHistory(projectId, name);
  const top = events[0];
  if (top?.action !== 'forget') throw new Error('changed');
  await api.restoreMemoryNote(projectId, name, top.id, null);
}

function History({ versions, failed, now, busy, onRun }: { versions: NoteVersion[] | null; failed: boolean; now: number; busy: boolean; onRun: (version: NoteVersion) => void }) {
  const t = useT();
  return (
    <div className="bt-section ui-lib__history">
      <div className="bt-section__head"><span className="bt-label">{t('ui.lib.history')}</span>{versions && <span className="bt-meta">{t('ui.lib.versions', versions.length)}</span>}</div>
      {failed && <p className="bt-meta ui-danger" role="alert">{t('ui.memory.historyFailed')}</p>}
      {versions && versions.length > 0 && (
        <ul className="bt-list" aria-label={t('ui.lib.history')}>
          {versions.map(version => {
            const { event } = version;
            const delta = lineDelta(event.before, event.after);
            const lines = event.action === 'reviewed' ? '' : t('ui.memory.lines', delta.added, delta.removed);
            return (
              <li key={event.id} className="bt-row ui-lib__version" data-event={event.id}>
                <Icon name={ACTION_ICON[event.action]} />
                <div className="bt-row__main">
                  <span className="bt-row__title">{event.summary ?? t(ACTION_KEY[event.action])}</span>
                  <span className="bt-row__sub bt-meta" title={formatDateTime(event.created_at, 'full')}>
                    {whoText(t, eventWho(event))} · {formatRelative(event.created_at, now)}{lines && <> · <span className="ui-mem__lines">{lines}</span></>}
                  </span>
                </div>
                {version.action && (
                  <div className="bt-row__end">
                    {version.action === 'undo'
                      ? <Button small icon="undo" disabled={busy} onClick={() => onRun(version)}>{t('ui.lib.undo')}</Button>
                      : <Button small variant="ghost" disabled={busy} onClick={() => onRun(version)}>{t('ui.lib.restore')}</Button>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Detail({ projectId, note, archived, revision, now, onChanged, onGone, leave }: {
  projectId: string; note: MemoryNote; archived: boolean; revision: number; now: number;
  onChanged: () => void; onGone: () => void; leave: (run: () => void) => void;
}) {
  const t = useT();
  const [file, setFile] = useState<{ text: string; hash: string } | null>(null);
  const [events, setEvents] = useState<MemoryFileEvent[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [base, setBase] = useState<{ hash: string; title: string; body: string } | null>(null);
  const rebaseFrom = useRef<object | null>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const confirmOpener = useRef<Element | null>(null);
  const loads = useRef(latestOnly());
  const path = notePath(note.name);

  useEffect(() => {
    const ticket = loads.current.begin();
    void api.memoryNote(projectId, note.name).then(r => { if (loads.current.isCurrent(ticket)) setFile({ text: r.text, hash: r.note.hash }); })
      .catch(failure => { if (loads.current.isCurrent(ticket)) setError(failText(failure, t)); });
    void api.memoryNoteHistory(projectId, note.name).then(r => { if (loads.current.isCurrent(ticket)) { setEvents(r.events); setHistoryFailed(false); } })
      .catch(() => { if (loads.current.isCurrent(ticket)) setHistoryFailed(true); });
  }, [projectId, note.name, note.hash, revision]);

  const parts = useMemo(() => (file ? splitNote(file.text, note.name) : null), [file, note.name]);
  useEffect(() => { if (mode === 'read' && parts) { setTitle(parts.title); setBody(parts.body); } }, [parts, mode]);
  // 書きかけは Edit を始めたときの版（base）と比べ、その版のハッシュで送る。あいだに版が変われば 409 で止まり、書きかけは残る
  useEffect(() => {
    if (!file || !rebaseFrom.current || file === rebaseFrom.current) return;
    rebaseFrom.current = null;
    setBase(b => (b ? { ...b, hash: file.hash } : b));
  }, [file]);
  const dirty = mode === 'edit' && base !== null && (title !== base.title || body !== base.body);
  const unsavedKey = `${EDITS}:${projectId}:${note.name}`;
  useUnsaved(unsavedKey, dirty);
  const versions = useMemo(() => (events && file ? noteVersions(events, file.text) : null), [events, file]);

  const askDelete = () => { confirmOpener.current = document.activeElement; setConfirming(true); };
  const toRead = () => leave(() => { setMode('read'); setBase(null); setError(''); });
  const startEdit = () => { if (file && parts) { setBase({ hash: file.hash, title: parts.title, body: parts.body }); setMode('edit'); } };
  // 409（見ていた版が古い）: 確かめの行を閉じて読み直す。Edit の版を進めるのは Save のときだけ（ほかの操作は、見ていない版を消したり印を外したりしない）
  const run = async (work: (hash: string) => Promise<void>, saving = false) => {
    const hash = mode === 'edit' ? base?.hash : file?.hash;
    if (busy || !hash) return;
    setBusy(true); setError('');
    try { await work(hash); } catch (failure) {
      const stale = failure instanceof ApiError && failure.status === 409;
      if (stale) { setConfirming(false); onChanged(); }
      if (stale && saving && mode === 'edit') { rebaseFrom.current = file; setError(t('ui.memory.saveConflict')); }
      else setError(failText(failure, t));
    } finally { setBusy(false); }
  };
  const save = () => void run(async hash => {
    if (!title.trim() || !body.trim() || !dirty) { setMode('read'); setBase(null); return; }
    await api.editMemoryNote(projectId, note.name, { title: title.trim(), content: body, baseHash: hash });
    setMode('read');
    setBase(null);
    onChanged();
    toast({ kind: 'memory', icon: 'check', title: t('ui.memory.toast.saved'), body: path });
  }, true);
  const remove = () => void run(async hash => {
    await api.forgetMemoryNote(projectId, note.name, hash);
    setConfirming(false);
    setUnsaved(unsavedKey, false);
    onGone();
    toast({
      kind: 'memory', icon: 'x', title: t('ui.memory.toast.deleted'), body: path,
      action: { label: t('ui.toast.undo'), run: () => void undoDelete(projectId, note.name).then(onChanged, failure => toast({ icon: 'alert', title: t('ui.task.toast.undoFailed'), body: failText(failure, t) })) },
    });
  });
  const restore = (version: NoteVersion) => {
    if (version.action === 'undo' && version.undo?.kind === 'delete') { askDelete(); return; }
    const target = version.action === 'undo' ? (version.undo?.kind === 'restore' ? version.undo.eventId : undefined) : version.event.id;
    if (target === undefined) return;
    void run(async hash => {
      await api.restoreMemoryNote(projectId, note.name, target, hash);
      onChanged();
      toast({ kind: 'memory', icon: 'undo', title: t(version.action === 'undo' ? 'ui.memory.toast.undone' : 'ui.memory.toast.restored'), body: path });
    });
  };
  const markRead = () => void run(async hash => {
    await api.reviewedMemoryNote(projectId, note.name, hash);
    onChanged();
    toast({ kind: 'memory', icon: 'check', title: t('ui.memory.toast.cleared'), body: path });
  });

  return (
    <section className="bt-pane bt-rise ui-lib__pane" style={{ '--bt-i': 2 } as CSSProperties} aria-label={path}>
      <div className="bt-pane__body">
        <div className="bt-pane__bar">
          <code className="bt-meta ui-mem__path">{path}</code>
          <div className="bt-seg" role="group" aria-label={t('ui.lib.mode')}>
            <button type="button" className="bt-seg__opt" aria-pressed={mode === 'read'} onClick={toRead}>{t('ui.lib.read')}</button>
            <button type="button" className="bt-seg__opt" aria-pressed={mode === 'edit'} disabled={archived || !file} onClick={startEdit}>{t('ui.lib.edit')}</button>
          </div>
          {mode === 'edit' && <Button small disabled={busy || !title.trim() || !body.trim()} onClick={save}>{t('ui.lib.save')}</Button>}
          {!archived && !confirming && <Button ref={deleteButton} small variant="ghost" disabled={busy || !file} onClick={askDelete}>{t('ui.lib.delete')}</Button>}
        </div>
        {confirming && (
          <RowConfirm warn={t('ui.memory.deleteWarn')} note={t('ui.memory.deleteNote')} action={t('ui.lib.delete')} busy={busy}
            onConfirm={remove} onKeep={refocus => {
              setConfirming(false);
              if (refocus) requestAnimationFrame(() => pickFocus([confirmOpener.current as HTMLElement | null, deleteButton.current], document.body, () => false)?.focus());
            }} />
        )}
        {note.tainted && (
          <div className="ui-mem__mark" data-mark="outside">
            <span className="bt-tag ui-mem__tag">{t('ui.memory.outside')}</span>
            <p className="bt-meta ui-mem__marknote">{t('ui.memory.outsideNote')}</p>
            {!archived && <Button small variant="ghost" icon="check" disabled={busy || !file} onClick={markRead}>{t('ui.memory.markRead')}</Button>}
          </div>
        )}
        {mode === 'edit' ? (
          <div className="ui-mem__edit">
            <input className="bt-field" value={title} maxLength={NOTE_TITLE_MAX} aria-label={t('ui.memory.titleField')} onChange={e => setTitle(e.target.value)} />
            <textarea className="bt-doc bt-doc--edit ui-lib__editor" autoFocus value={body} maxLength={NOTE_CONTENT_MAX} rows={10} aria-label={t('ui.memory.field')}
              onChange={e => setBody(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); toRead(); }
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
              }} />
          </div>
        ) : (
          file && <article className="bt-doc"><Markdown text={file.text} /></article>
        )}
        {error && <p className="bt-meta ui-danger" role="alert">{error}</p>}
        <History versions={versions} failed={historyFailed} now={now} busy={busy} onRun={restore} />
      </div>
    </section>
  );
}

function NewMemory({ projectId, onSaved, onClose }: { projectId: string; onSaved: (name: string) => void; onClose: () => void }) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useUnsaved(`${EDITS}-new:${projectId}`, title !== '' || body !== '');
  const ready = title.trim() !== '' && body.trim() !== '';
  const save = async () => {
    if (busy || !ready) return;
    setBusy(true); setError('');
    try {
      const result = await api.addMemoryNote(projectId, { title: title.trim(), content: body });
      onSaved(result.note.name);
      toast({ kind: 'memory', icon: 'check', title: t('ui.memory.toast.saved'), body: notePath(result.note.name) });
    } catch (failure) { setError(failText(failure, t)); } finally { setBusy(false); }
  };
  return (
    <section className="bt-pane bt-rise ui-lib__pane" aria-label={t('ui.memory.new')}>
      <div className="bt-pane__body">
        <div className="bt-pane__bar">
          <span className="bt-meta">{t('ui.memory.new')}</span>
          <Button small disabled={busy || !ready} onClick={() => void save()}>{t('ui.lib.save')}</Button>
          <Button small variant="ghost" onClick={onClose}>{t('ui.cancel')}</Button>
        </div>
        <div className="ui-mem__edit">
          <input className="bt-field" autoFocus value={title} maxLength={NOTE_TITLE_MAX} placeholder={t('ui.memory.titleField')} aria-label={t('ui.memory.titleField')} onChange={e => setTitle(e.target.value)} />
          <textarea className="bt-doc bt-doc--edit ui-lib__editor" value={body} maxLength={NOTE_CONTENT_MAX} rows={10} placeholder={t('ui.memory.notePlaceholder')} aria-label={t('ui.memory.field')}
            onChange={e => setBody(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); }
            }} />
        </div>
        {error && <p className="bt-meta ui-danger" role="alert">{error}</p>}
      </div>
    </section>
  );
}

function Scope({ product }: { product: Project | undefined }) {
  const t = useT();
  return (
    <div className="bt-seg" role="group" aria-label={t('ui.memory.scope')}>
      {product && <button type="button" className="bt-seg__opt" aria-pressed="true">{product.name}</button>}
      <button type="button" className="bt-seg__opt" aria-pressed="false" disabled title={t('ui.memory.globalNote')}>{t('ui.memory.global')}</button>
    </div>
  );
}

function Picker({ projects, loaded }: { projects: readonly Project[]; loaded: boolean }) {
  const t = useT();
  const ordered = useMemo(() => [...projects].sort((a, b) => Number(a.archived_at !== null) - Number(b.archived_at !== null) || a.created_at - b.created_at), [projects]);
  return (
    <>
      <p className="bt-meta ui-lib__usage">{t('ui.memory.pickNote')}</p>
      {loaded && ordered.length === 0 && <EmptyState title={t('ui.memory.noProducts')} />}
      {ordered.length > 0 && (
        <ul className="bt-list bt-rise ui-mem__picker" aria-label={t('ui.memory.pick')}>
          {ordered.map(project => (
            <li key={project.id} className="bt-row bt-row--link">
              <div className="bt-row__main">
                <a className="bt-row__title" href={routeHash({ view: 'memory', productId: project.id })}>{project.name}</a>
              </div>
              {project.archived_at !== null && <span className="bt-tag">{t('ui.memory.archivedTag')}</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function Memory({ productId, projects, projectsLoaded, revision }: { productId: string | undefined; projects: readonly Project[]; projectsLoaded: boolean; revision: number }) {
  const t = useT();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);
  const loads = useRef(latestOnly());
  const shown = useRef<MemoryNote | undefined>(undefined);
  const now = useNow(60_000);
  const product = projects.find(p => p.id === productId);

  const load = useCallback(async () => {
    if (!productId) return;
    const ticket = loads.current.begin();
    try {
      const result = await api.memoryNotes(productId);
      if (!loads.current.isCurrent(ticket)) return;
      setData({ notes: result.notes, archived: result.archived });
      setFailed(false);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, [productId]);
  useEffect(() => { const timer = setTimeout(() => void load(), 150); return () => clearTimeout(timer); }, [load, revision, tick]);

  const notes = data?.notes ?? [];
  const archived = data?.archived ?? product?.archived_at != null;
  let current = notes.find(note => note.name === selected) ?? (creating ? undefined : notes[0]);
  // 書きかけのある記憶が一覧から消えても（外で消された・名前が変わった）、書きかけを捨てずに開いたままにする
  const held = shown.current;
  if (held && !creating && (selected === null || selected === held.name) && current?.name !== held.name && !notes.some(note => note.name === held.name) && hasUnsavedEdits(`${EDITS}:${productId}:${held.name}`)) current = held;
  shown.current = current;
  const changed = (select?: string) => { if (select !== undefined) setSelected(select); setTick(n => n + 1); };
  const ask = useDiscardAsk(() => hasUnsavedEdits(EDITS));
  const startNew = () => { if (!creating) ask.attempt(() => { setCreating(true); setSelected(null); }); };

  return (
    <div className="bt-screen__inner">
      <header className="bt-screen__head bt-rise">
        <h1 className="bt-screen__title">{t('ui.nav.memory')}</h1>
        <div className="bt-screen__tools">
          <Scope product={product} />
          {productId && <a className="bt-btn bt-btn--sm bt-btn--ghost" href={routeHash({ view: 'memory' })}>{t('ui.memory.allProducts')}</a>}
          {productId && !archived && <Button onClick={startNew}>{t('ui.memory.new')}</Button>}
        </div>
      </header>
      {!productId && <Picker projects={projects} loaded={projectsLoaded} />}
      {productId && failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}
      {productId && data?.archived && <p className="bt-meta ui-lib__usage">{t('ui.memory.archivedNote')}</p>}
      {productId && data && notes.length === 0 && !creating && (
        <EmptyState title={t('ui.memory.empty')} text={t('ui.memory.noteEmptyText')} action={archived ? undefined : <Button onClick={startNew}>{t('ui.memory.new')}</Button>} />
      )}
      <DiscardConfirm ask={ask} />
      {productId && data && (notes.length > 0 || creating) && (
        <div className="bt-split ui-lib__split">
          <ul className="bt-list bt-rise" style={{ '--bt-i': 1 } as CSSProperties} aria-label={t('ui.memory.list')}>
            {notes.map(note => {
              const stamp = noteStamp(note);
              const active = !creating && current?.name === note.name;
              const pick = () => { if (!active) ask.attempt(() => { setCreating(false); setSelected(note.name); }); };
              return (
                <li key={note.name} className={`bt-row bt-row--link${active ? ' is-active' : ''}`} onClick={pick} data-note={note.name}>
                  <div className="bt-row__main">
                    <button type="button" className="bt-row__title ui-lib__title ui-rowbtn" aria-current={active ? 'true' : undefined} title={note.title}><code>{note.name}.md</code></button>
                    <span className="bt-row__sub bt-meta" title={formatDateTime(stamp.at, 'full')}>
                      {t(stamp.edited ? 'ui.memory.edited' : 'ui.memory.saved', whoText(t, stamp.who), formatRelative(stamp.at, now))}
                    </span>
                  </div>
                  {note.tainted && <span className="bt-tag ui-mem__tag">{t('ui.memory.outside')}</span>}
                </li>
              );
            })}
          </ul>
          {creating
            ? <NewMemory projectId={productId} onSaved={name => { setCreating(false); changed(name); }} onClose={() => ask.attempt(() => setCreating(false))} />
            : current && <Detail key={current.name} projectId={productId} note={current} archived={archived} revision={revision + tick} now={now} onChanged={() => changed()} onGone={() => { setSelected(null); changed(); }} leave={ask.attempt} />}
        </div>
      )}
    </div>
  );
}
