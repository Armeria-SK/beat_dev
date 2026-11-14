import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError, type Book, type BookView, type MemoryContext, type MemoryEvent, type MemoryItem } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatDateTime, formatNumber, formatRelative, useT } from '../../i18n/index.ts';
import { Markdown } from '../../Markdown.tsx';
import { memoryRef } from '../../memory-page.ts';
import { DiscardConfirm, useDiscardAsk, useUnsaved } from '../Discard.tsx';
import { pickFocus } from '../focus.ts';
import { useNow } from '../hooks.ts';
import { latestOnly } from '../latest.ts';
import { latestEventByMemory, memoryHistory, memoryStamp, undoDeletes, type MemoryVersion } from '../library.ts';
import { Button, EmptyState, Icon, Notice } from '../parts.tsx';
import { routeHash } from '../routes.ts';
import { RowConfirm } from '../RowConfirm.tsx';
import type { UiIconName } from '../icons.ts';
import { hasUnsavedEdits, SCREEN_EDITS } from '../unsaved.ts';

type T = ReturnType<typeof useT>;
interface Loaded { books: Record<Book, BookView>; context: MemoryContext | null; events: MemoryEvent[] }

const BOOKS: readonly Book[] = ['user', 'notes'];
const BOOK_KEY = { user: 'ui.memory.user', notes: 'ui.memory.notes' } as const satisfies Record<Book, string>;
const ACTION_KEY = { create: 'ui.memory.action.create', update: 'ui.memory.action.update', forget: 'ui.memory.action.forget', restore: 'ui.memory.action.restore' } as const;
const ACTION_ICON: Record<string, UiIconName> = { create: 'plus', update: 'pencil', forget: 'x', restore: 'undo' };
const MAX = 600;
const EDITS = `${SCREEN_EDITS}memory`;

const failText = (error: unknown, t: T): string => (error instanceof ApiError ? error.message : t('ui.memory.toast.failed'));
const whoText = (t: T, who: 'you' | 'beat'): string => t(who === 'you' ? 'ui.lib.you' : 'ui.lib.beat');

function undoAction(t: T, eventId: number, reload: () => void) {
  return {
    label: t('ui.toast.undo'),
    run: () => {
      void api.undoMemory(eventId).then(() => { reload(); toast({ icon: 'undo', title: t('ui.memory.toast.undone') }); })
        .catch(error => toast({ icon: 'alert', title: t('ui.task.toast.undoFailed'), body: failText(error, t) }));
    },
  };
}

function History({ item, events, failed, now, busy, onRun }: {
  item: MemoryItem; events: MemoryEvent[] | null; failed: boolean; now: number; busy: boolean;
  onRun: (version: MemoryVersion) => void;
}) {
  const t = useT();
  const versions = useMemo(() => (events ? memoryHistory(events, item.content) : []), [events, item.content]);
  return (
    <div className="bt-section ui-lib__history">
      <div className="bt-section__head"><span className="bt-label">{t('ui.lib.history')}</span>{events && <span className="bt-meta">{t('ui.lib.versions', versions.length)}</span>}</div>
      {failed && <p className="bt-meta ui-danger" role="alert">{t('ui.memory.historyFailed')}</p>}
      {versions.length > 0 && (
        <ul className="bt-list">
          {versions.map(version => {
            const { event } = version;
            const label = Object.hasOwn(ACTION_KEY, event.action) ? t(ACTION_KEY[event.action as keyof typeof ACTION_KEY]) : event.action;
            return (
              <li key={event.id} className="bt-row ui-lib__version">
                <Icon name={ACTION_ICON[event.action] ?? 'pencil'} />
                <div className="bt-row__main">
                  <span className="bt-row__title">{label}{event.undone_at ? <span className="bt-meta"> · {t('ui.memory.undone')}</span> : null}</span>
                  <span className="bt-row__sub bt-meta" title={formatDateTime(event.created_at, 'full')}>{whoText(t, version.who)} · {formatRelative(event.created_at, now)}</span>
                  {event.after !== null && <span className="bt-row__sub bt-meta ui-lib__text">{event.after}</span>}
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

function Detail({ item, revision, now, onChanged, onGone, leave }: {
  item: MemoryItem; revision: number; now: number; onChanged: (select?: number) => void; onGone: () => void; leave: (run: () => void) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [draft, setDraft] = useState(item.content);
  const [events, setEvents] = useState<MemoryEvent[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const deleteButton = useRef<HTMLButtonElement>(null);
  const confirmOpener = useRef<Element | null>(null);
  const askDelete = () => { confirmOpener.current = document.activeElement; setConfirming(true); };
  const loads = useRef(latestOnly());

  useEffect(() => {
    const ticket = loads.current.begin();
    void api.memoryEvents(item.id).then(r => { if (loads.current.isCurrent(ticket)) { setEvents(r.events); setHistoryFailed(false); } })
      .catch(() => { if (loads.current.isCurrent(ticket)) setHistoryFailed(true); });
  }, [item.id, item.updated_at, revision]);
  useEffect(() => { if (mode === 'read') setDraft(item.content); }, [item.content, mode]);
  useUnsaved(`${EDITS}:${item.id}`, mode === 'edit' && draft !== item.content);
  const toRead = () => leave(() => { setMode('read'); setError(''); });

  const reload = () => onChanged(item.id);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); } catch (failure) { setError(failText(failure, t)); } finally { setBusy(false); }
  };
  const save = () => void run(async () => {
    if (!draft.trim() || draft.trim() === item.content) { setMode('read'); return; }
    const result = await api.editMemory(item.id, draft);
    setMode('read');
    reload();
    toast({ kind: 'memory', icon: 'check', title: t('ui.memory.toast.saved'), body: result.memory.content, action: undoAction(t, result.eventId, reload) });
  });
  const restore = (version: MemoryVersion) => void run(async () => {
    if (undoDeletes(version)) { askDelete(); return; }
    if (version.action === 'undo') {
      await api.undoMemory(version.event.id);
      reload();
      toast({ icon: 'undo', title: t('ui.memory.toast.undone'), body: item.content });
      return;
    }
    if (version.event.after === null) return;
    const result = await api.editMemory(item.id, version.event.after);
    reload();
    toast({ kind: 'memory', icon: 'undo', title: t('ui.memory.toast.restored'), body: result.memory.content, action: undoAction(t, result.eventId, reload) });
  });
  const remove = () => void run(async () => {
    const result = await api.forgetMemory(item.id);
    setConfirming(false);
    onGone();
    toast({ kind: 'memory', icon: 'x', title: t('ui.memory.toast.deleted'), body: item.content, action: undoAction(t, result.eventId, () => onChanged(item.id)) });
  });
  const ref = `${memoryRef(item)} · ${t(BOOK_KEY[item.book])}`;

  return (
    <section className="bt-pane bt-rise ui-lib__pane" style={{ '--bt-i': 2 } as CSSProperties} aria-label={ref}>
      <div className="bt-pane__body">
        <div className="bt-pane__bar">
          <span className="bt-meta">{ref}</span>
          <div className="bt-seg" role="group" aria-label={t('ui.lib.mode')}>
            <button type="button" className="bt-seg__opt" aria-pressed={mode === 'read'} onClick={toRead}>{t('ui.lib.read')}</button>
            <button type="button" className="bt-seg__opt" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>{t('ui.lib.edit')}</button>
          </div>
          {mode === 'edit' && <Button small disabled={busy || !draft.trim()} onClick={save}>{t('ui.lib.save')}</Button>}
          {!confirming && <Button ref={deleteButton} small variant="ghost" disabled={busy} onClick={askDelete}>{t('ui.lib.delete')}</Button>}
        </div>
        {confirming && (
          <RowConfirm warn={t('ui.memory.deleteWarn')} note={t('ui.memory.deleteNote')} action={t('ui.lib.delete')} busy={busy}
            onConfirm={remove} onKeep={refocus => {
              setConfirming(false);
              if (refocus) requestAnimationFrame(() => pickFocus([confirmOpener.current as HTMLElement | null, deleteButton.current], document.body, () => false)?.focus());
            }} />
        )}
        {mode === 'edit' ? (
          <textarea className="bt-doc bt-doc--edit ui-lib__editor" autoFocus value={draft} maxLength={MAX} rows={5} aria-label={t('ui.memory.field')}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); toRead(); }
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
            }} />
        ) : (
          <article className="bt-doc"><Markdown text={item.content} /></article>
        )}
        {error && <p className="bt-meta ui-danger" role="alert">{error}</p>}
        {item.source_conversation_id && <a className="bt-tool__link bt-meta" href={routeHash({ view: 'chat', id: item.source_conversation_id })}>{t('ui.memory.source')}</a>}
        <History item={item} events={events} failed={historyFailed} now={now} busy={busy} onRun={restore} />
      </div>
    </section>
  );
}

function NewMemory({ book, onSaved, onClose }: { book: Book; onSaved: (id: number) => void; onClose: () => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useUnsaved(`${EDITS}-new`, text !== '');
  const save = async () => {
    if (busy || !text.trim()) return;
    setBusy(true); setError('');
    try {
      const result = await api.addMemory(book, text);
      onSaved(result.memory.id);
      toast({ kind: 'memory', icon: 'check', title: t('ui.memory.toast.saved'), body: result.memory.content, action: undoAction(t, result.eventId, () => onSaved(result.memory.id)) });
    } catch (failure) { setError(failText(failure, t)); } finally { setBusy(false); }
  };
  return (
    <section className="bt-pane bt-rise ui-lib__pane" aria-label={t('ui.memory.new')}>
      <div className="bt-pane__body">
        <div className="bt-pane__bar">
          <span className="bt-meta">{t('ui.memory.new')} · {t(BOOK_KEY[book])}</span>
          <Button small disabled={busy || !text.trim()} onClick={() => void save()}>{t('ui.lib.save')}</Button>
          <Button small variant="ghost" onClick={onClose}>{t('ui.cancel')}</Button>
        </div>
        <textarea className="bt-doc bt-doc--edit ui-lib__editor" autoFocus value={text} maxLength={MAX} rows={5} placeholder={t('ui.memory.placeholder')} aria-label={t('ui.memory.field')}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); }
          }} />
        {error && <p className="bt-meta ui-danger" role="alert">{error}</p>}
      </div>
    </section>
  );
}

export function Memory({ revision }: { revision: number }) {
  const t = useT();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [book, setBook] = useState<Book>('user');
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);
  const loads = useRef(latestOnly());
  const now = useNow(60_000);

  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const [memories, recent] = await Promise.all([api.memories(), api.recentMemoryEvents()]);
      if (!loads.current.isCurrent(ticket)) return;
      setData({ books: memories.books, context: memories.context, events: recent.events });
      setFailed(false);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, []);
  useEffect(() => { const timer = setTimeout(() => void load(), 150); return () => clearTimeout(timer); }, [load, revision, tick]);

  const items = data?.books[book].items ?? [];
  const latest = useMemo(() => latestEventByMemory(data?.events ?? []), [data]);
  const current = items.find(item => item.id === selected) ?? (creating ? undefined : items[0]);
  const changed = (select?: number) => { if (select !== undefined) setSelected(select); setTick(n => n + 1); };
  const ask = useDiscardAsk(() => hasUnsavedEdits(EDITS));
  const pickBook = (next: Book) => { if (next !== book) ask.attempt(() => { setBook(next); setSelected(null); setCreating(false); }); };
  const usage = data ? (data.context === null ? t('ui.memory.notUsed') : data.context.budget === null
    ? t('ui.memory.usage', formatNumber(data.books[book].used), formatNumber(data.context.tokens))
    : t('ui.memory.usageBudget', formatNumber(data.books[book].used), formatNumber(data.context.tokens), formatNumber(data.context.budget))) : '';

  return (
    <div className="bt-screen__inner">
      <header className="bt-screen__head bt-rise">
        <h1 className="bt-screen__title">{t('ui.nav.memory')}</h1>
        <div className="bt-screen__tools">
          <div className="bt-seg" role="group" aria-label={t('ui.memory.book')}>
            {BOOKS.map(id => <button key={id} type="button" className="bt-seg__opt" aria-pressed={book === id} onClick={() => pickBook(id)}>{t(BOOK_KEY[id])}</button>)}
          </div>
          <Button onClick={() => { if (!creating) ask.attempt(() => { setCreating(true); setSelected(null); }); }}>{t('ui.memory.new')}</Button>
        </div>
      </header>
      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}
      {data && (
        <p className="bt-meta ui-lib__usage">
          {usage}{data.context !== null && data.context.omitted > 0 && <> · <span className="ui-danger">{t('ui.memory.omitted', data.context.omitted)}</span></>}
        </p>
      )}
      {data && items.length === 0 && !creating && (
        <EmptyState title={t('ui.memory.empty')} text={t('ui.memory.emptyText')} action={<Button onClick={() => setCreating(true)}>{t('ui.memory.new')}</Button>} />
      )}
      <DiscardConfirm ask={ask} />
      {data && (items.length > 0 || creating) && (
        <div className="bt-split ui-lib__split">
          <ul className="bt-list bt-rise" style={{ '--bt-i': 1 } as CSSProperties} aria-label={t('ui.memory.list')}>
            {items.map(item => {
              const stamp = memoryStamp(item, latest.get(item.id));
              const active = !creating && current?.id === item.id;
              const pick = () => { if (!active) ask.attempt(() => { setCreating(false); setSelected(item.id); }); };
              return (
                <li key={item.id} className={`bt-row bt-row--link${active ? ' is-active' : ''}`} onClick={pick}>
                  <div className="bt-row__main">
                    <button type="button" className="bt-row__title ui-lib__title ui-rowbtn" aria-current={active ? 'true' : undefined}>{item.content}</button>
                    <span className="bt-row__sub bt-meta" title={formatDateTime(stamp.at, 'full')}>
                      {t(stamp.edited ? 'ui.memory.edited' : 'ui.memory.saved', whoText(t, stamp.who), formatRelative(stamp.at, now))}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {creating
            ? <NewMemory book={book} onSaved={id => { setCreating(false); changed(id); }} onClose={() => ask.attempt(() => setCreating(false))} />
            : current && <Detail key={current.id} item={current} revision={revision + tick} now={now} onChanged={changed} onGone={() => { setSelected(null); changed(); }} leave={ask.attempt} />}
        </div>
      )}
    </div>
  );
}
