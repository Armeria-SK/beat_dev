import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, type BrowserView } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { t as tr, useT } from '../../i18n/index.ts';
import { useNow } from '../hooks.ts';
import { latestOnly } from '../latest.ts';
import { Button, EmptyState, Icon, Notice, Pill } from '../parts.tsx';
import { reportOpError } from '../task-ops.ts';
import '../styles/browser.css';

export const POLL_MS = 1000;

export function actionText(action: BrowserView['action']): string {
  switch (action.kind) {
    case 'open': return tr('ui.browser.act.open', action.target);
    case 'click': return tr('ui.browser.act.click', action.target);
    case 'type': return tr('ui.browser.act.type', action.target);
    case 'read': return tr('ui.browser.act.read');
    case 'screenshot': return tr('ui.browser.act.screenshot');
  }
}

export function agoShort(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const clampPct = (n: number): string => `${Math.min(100, Math.max(0, n)).toFixed(3).replace(/\.?0+$/u, '')}%`;

export function pointerStyle(pointer: { x: number; y: number }, viewport: { width: number; height: number }): { left: string; top: string } {
  return { left: clampPct((pointer.x / viewport.width) * 100), top: clampPct((pointer.y / viewport.height) * 100) };
}

export const displayUrl = (url: string): string => url.replace(/^https?:\/\//iu, '');

export function metaLine(view: BrowserView): string {
  const title = view.by.title || tr('ui.session.untitled');
  const by = view.by.kind === 'task' ? tr('ui.browser.byTask', title) : view.by.kind === 'agent' ? tr('ui.browser.byAgent', title) : tr('ui.browser.byConversation', title);
  return [
    tr('ui.browser.watching'),
    tr('ui.browser.size', view.viewport.width, view.viewport.height),
    view.profile.kind === 'owner' ? tr('ui.browser.profileOwner', view.profile.path) : tr('ui.browser.profileWork'),
    by,
  ].join(' · ');
}

interface Frame { src: string; seq: number; tab: string }

export function BrowserPane({ productId }: { productId: string }) {
  const t = useT();
  const [view, setView] = useState<BrowserView | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [stopping, setStopping] = useState(false);
  const busy = useRef(false);
  const alive = useRef(true);
  const frames = useRef(latestOnly());
  const wanted = useRef<string | null>(null);
  const shownRef = useRef<Frame | null>(null);

  const show = useCallback((next: Frame | null) => {
    const before = shownRef.current;
    if (before && before.src !== next?.src) URL.revokeObjectURL(before.src);
    shownRef.current = next;
    setFrame(next);
  }, []);

  const loadFrame = useCallback(async (next: BrowserView) => {
    const key = `${next.tab}:${next.seq}`;
    if (wanted.current === key) return;
    wanted.current = key;
    const ticket = frames.current.begin();
    try {
      const got = await api.browserFrame(productId, next.tab);
      const src = URL.createObjectURL(got.blob);
      if (!alive.current || !frames.current.isCurrent(ticket)) { URL.revokeObjectURL(src); return; }
      show({ src, seq: got.seq || next.seq, tab: next.tab });
    } catch {
      if (frames.current.isCurrent(ticket)) wanted.current = null;
    }
  }, [productId, show]);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = (await api.browserView(productId)).view;
      if (!alive.current) return;
      setView(next);
      setFailed(false);
      if (!next) { frames.current.begin(); wanted.current = null; show(null); return; }
      const had = shownRef.current;
      if (next.seq > 0 && (had?.seq !== next.seq || had.tab !== next.tab)) void loadFrame(next);
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      busy.current = false;
    }
  }, [productId, loadFrame, show]);

  useEffect(() => {
    alive.current = true;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(timer);
      const had = shownRef.current;
      if (had) URL.revokeObjectURL(had.src);
      shownRef.current = null;
    };
  }, [load]);

  const now = useNow(1000);

  const stop = async () => {
    if (!view || stopping) return;
    setStopping(true);
    try {
      const { stopped } = await api.stop(view.runId);
      toast({ icon: 'square', title: t(stopped ? 'ui.browser.stopped' : 'ui.browser.notRunning') });
      void load();
    } catch (error) { reportOpError(error); } finally { setStopping(false); }
  };

  if (failed && view === undefined) return <Notice tone="warn" icon="alert" title={t('ui.browser.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />;
  if (view === undefined) return <div className="ui-browser" />;
  if (view === null) return <div className="ui-browser"><EmptyState title={t('ui.browser.empty')} text={t('ui.browser.emptyText')} /></div>;

  const shown = frame && frame.tab === view.tab ? frame : null;
  const status = view.driving ? actionText(view.action) : view.at === null ? t('ui.browser.noFrame') : t('ui.browser.lastFrame', agoShort(now - view.at));
  const stage = { '--ui-browser-w': view.viewport.width, '--ui-browser-h': view.viewport.height } as CSSProperties;
  return (
    <div className="ui-browser" data-browser-tab={view.tab}>
      <div className="bt-pane__bar">
        {view.driving ? <Pill tone="running">{t('ui.browser.driving')}</Pill> : <Pill>{t('ui.browser.idle')}</Pill>}
        <span className="bt-meta ui-browser__status" title={view.title || undefined}>{status}</span>
        {view.driving && <Button small icon="square" disabled={stopping} onClick={() => void stop()}>{t('ui.browser.stop')}</Button>}
      </div>
      <div className="bt-browser" role="img" aria-label={t('ui.browser.mirrorOf', displayUrl(view.url))}>
        <div className="bt-browser__bar" aria-hidden="true">
          <Icon name="arrowL" />
          <Icon name="refresh" />
          <span className="bt-browser__url">{displayUrl(view.url)}</span>
        </div>
        <div className="bt-browser__view ui-browser__view">
          <div className="ui-browser__stage" style={stage}>
            {shown && <img src={shown.src} alt="" draggable={false} />}
            {view.driving && view.pointer && (
              <span className="bt-cursor" aria-hidden="true" style={pointerStyle(view.pointer, view.viewport)}><svg viewBox="0 0 18 18"><path d="M3 2l11 6.5-5 1.2L6.5 15z" /></svg></span>
            )}
          </div>
        </div>
      </div>
      <p className="bt-meta ui-browser__meta">{metaLine(view)}</p>
    </div>
  );
}
