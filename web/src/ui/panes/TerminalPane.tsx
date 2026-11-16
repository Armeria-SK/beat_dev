import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type BackgroundItem } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { useT } from '../../i18n/index.ts';
import { useNow } from '../hooks.ts';
import { latestOnly } from '../latest.ts';
import { Button, EmptyState, Notice, Pill } from '../parts.tsx';
import { reportOpError } from '../task-ops.ts';
import { addText, atBottom, EMPTY_TEXT, holdsText, linkParts, pickJob, pillOf, POLL_MS, type TerminalFocus, type TermText } from '../terminal.ts';

export interface TerminalPaneProps { productId: string; revision: string; focus?: TerminalFocus | null | undefined }

interface Shown { id: string; startedAt: number; text: TermText; next: number | undefined; skipped: number; fresh: number | null }

function Line({ text }: { text: string }) {
  return <>{linkParts(text).map((part, i) => (part.href ? <a key={i} className="bt-tool__link" href={part.href} target="_blank" rel="noreferrer noopener">{part.text}</a> : part.text))}</>;
}

export function TerminalPane({ productId, revision, focus }: TerminalPaneProps) {
  const t = useT();
  const [items, setItems] = useState<BackgroundItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [wanted, setWanted] = useState<string | null>(focus?.id ?? null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [unseen, setUnseen] = useState(0);
  const [stopping, setStopping] = useState(false);
  const term = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  const lists = useRef(latestOnly());
  const reads = useRef(latestOnly());

  useEffect(() => { if (focus) setWanted(focus.id); }, [focus]);

  const loadList = useCallback(async () => {
    const ticket = lists.current.begin();
    try {
      const next = (await api.background(productId)).items;
      if (!lists.current.isCurrent(ticket)) return;
      setItems(next);
      setFailed(false);
    } catch {
      if (lists.current.isCurrent(ticket)) setFailed(true);
    }
  }, [productId]);

  useEffect(() => { void loadList(); }, [loadList, revision]);

  const selected = items ? pickJob(items, wanted) : null;
  const item = items?.find(i => i.id === selected);
  const running = item?.state === 'running';
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const read = useCallback(async (id: string, from: number | undefined) => {
    const ticket = reads.current.begin();
    let out;
    try { out = await api.backgroundOutput(id, productId, from); } catch { return; }
    if (!reads.current.isCurrent(ticket)) return;
    const had = shownRef.current;
    if (from !== undefined && had?.id === id && (out.next < from || had.startedAt !== out.startedAt)) {
      void read(id, undefined);
      return;
    }
    const live = follow.current;
    setShown(prev => {
      const goOn = prev && prev.id === id && from !== undefined;
      const base = goOn ? prev : { id, startedAt: out.startedAt, text: EMPTY_TEXT, next: undefined, skipped: out.skipped, fresh: null };
      const { next, added } = addText(base.text, out.text, goOn ? out.skipped : 0);
      const fresh = from !== undefined && added > 0 && live ? next.count - added : null;
      return { id, startedAt: out.startedAt, text: next, next: out.next, skipped: base.skipped + (goOn && base.text.lines.length === 0 ? out.skipped : 0), fresh };
    });
    if (from !== undefined && !live) {
      const added = out.text.split('\n').length - (out.text.endsWith('\n') ? 1 : 0);
      if (added > 0) setUnseen(n => n + added);
    }
    setItems(list => list?.map(i => (i.id === id ? { ...i, ...withoutText(out) } : i)) ?? list);
  }, [productId]);

  useEffect(() => {
    follow.current = true;
    setUnseen(0);
    setShown(null);
    if (selected) void read(selected, undefined);
  }, [selected, read]);

  const position = shown && shown.id === selected ? shown.next : undefined;
  const positionRef = useRef(position);
  positionRef.current = position;

  useEffect(() => {
    if (!selected || positionRef.current === undefined) return;
    void read(selected, positionRef.current);
  }, [revision, selected, read]);

  useEffect(() => {
    if (!selected || !running) return undefined;
    const timer = setInterval(() => { if (positionRef.current !== undefined) void read(selected, positionRef.current); }, POLL_MS);
    return () => clearInterval(timer);
  }, [selected, running, read]);

  useLayoutEffect(() => {
    const el = term.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const onScroll = () => {
    const el = term.current;
    if (!el) return;
    follow.current = atBottom(el);
    if (follow.current) setUnseen(0);
  };
  const toBottom = () => {
    const el = term.current;
    follow.current = true;
    setUnseen(0);
    if (el) el.scrollTop = el.scrollHeight;
  };

  const stop = async () => {
    if (!item || stopping) return;
    setStopping(true);
    try {
      const { item: next } = await api.stopBackground(item.id, productId);
      setItems(list => list?.map(i => (i.id === next.id ? next : i)) ?? list);
      toast({ icon: 'square', title: t('ui.term.stoppedToast') });
      if (selectedRef.current === item.id) void read(item.id, positionRef.current);
    } catch (error) { reportOpError(error); } finally { setStopping(false); }
  };

  const now = useNow(running ? 1000 : 60_000);

  if (failed && !items) return <Notice tone="warn" icon="alert" title={t('ui.term.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void loadList() }} />;
  if (!items) return <div className="ui-term" />;
  if (!item) return <div className="ui-term"><EmptyState title={t('ui.term.empty')} text={t('ui.term.emptyText')} /></div>;

  const pill = pillOf(item);
  const text = shown && shown.id === item.id ? shown : null;
  const lines = text?.text.lines ?? [];
  const meta = [
    t('ui.term.readOnly'),
    t('ui.term.startedBy', item.startedBy.title || t('ui.session.untitled')),
    item.tainted && t('ui.term.tainted'),
    item.orphaned && t('ui.term.orphaned'),
  ].filter(Boolean).join(' · ');

  return (
    <div className="ui-term" data-terminal={item.id}>
      <div className="bt-pane__bar">
        <div className="bt-seg ui-term__seg" role="group" aria-label={t('ui.term.command')}>
          {items.map(i => <button key={i.id} type="button" className="bt-seg__opt" aria-pressed={i.id === item.id} title={i.command} onClick={() => setWanted(i.id)}>{i.command}</button>)}
        </div>
        <span className="bt-meta">{holdsText(item, now)}</span>
        <Pill tone={pill.tone}>{pill.label}</Pill>
        {running && <Button small icon="square" disabled={stopping} onClick={() => void stop()}>{t('ui.term.stop')}</Button>}
      </div>
      <pre className="bt-term ui-term__out" ref={term} aria-live="off" tabIndex={0} onScroll={onScroll}>
        {text && (text.skipped > 0 || text.text.trimmed) && <span className="bt-term__line bt-meta ui-term__earlier">{t('ui.term.earlier')}</span>}
        <span className="bt-term__line bt-term__line--cmd">$ {item.command}</span>
        {lines.map((line, i) => (line.gap ? <span key={line.n} className="bt-term__line bt-meta ui-term__gap">{t('ui.term.gap')}</span> : (
          <span key={line.n} className={`bt-term__line${text?.fresh !== null && text?.fresh !== undefined && line.n >= text.fresh ? ' bt-term__line--new' : ''}`}>
            <Line text={line.text || ' '} />{running && i === lines.length - 1 && <span className="bt-caret" />}
          </span>
        )))}
        {running && lines.length === 0 && <span className="bt-term__line"><span className="bt-caret" /></span>}
      </pre>
      <p className="bt-meta ui-term__meta">
        <span>{meta}</span>
        {unseen > 0 && <button type="button" className="bt-tool__link ui-term__unseen" onClick={toBottom}>{t('ui.term.newLines', unseen)}</button>}
      </p>
    </div>
  );
}

function withoutText(out: BackgroundItem & { text?: string; next?: number; skipped?: number }): BackgroundItem {
  const { text: _text, next: _next, skipped: _skipped, ...rest } = out;
  return rest;
}
