import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { api, ApiError, type Conversation } from '../api.ts';
import { useT } from '../i18n/index.ts';
import { menuFit, menuFixed, menuLeft, menuStep, type FixedMenu } from './menu.ts';
import { Button } from './parts.tsx';

const MENU_GAP = 4;
const ENABLED_ITEMS = '[role="menuitem"]:not(:disabled)';

export function SessionMenu({ conversation, label, lead, opener, floating, className, onArchived, onDeleted, onClose }: {
  conversation: Pick<Conversation, 'id' | 'archived' | 'project_id'>;
  label: string;
  lead?: ReactNode;
  opener: RefObject<HTMLElement | null>;
  floating?: boolean;
  className?: string;
  onArchived: () => void;
  onDeleted: () => void;
  onClose: (refocus: boolean) => void;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [box, setBox] = useState<FixedMenu | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const remove = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  const note = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    if (!floating) return undefined;
    const place = () => {
      const menu = list.current;
      const anchor = opener.current;
      if (!menu || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      const view = { width: window.innerWidth, height: window.innerHeight };
      setBox(menuFixed(rect, menuFit(rect, { top: 0, left: 0, right: view.width, bottom: view.height }, { width: menu.offsetWidth, height: menu.scrollHeight }, MENU_GAP), view, MENU_GAP));
    };
    place();
    const resized = () => close.current(false);
    const scrolled = (e: Event) => { if (opener.current && e.target instanceof Node && e.target.contains(opener.current)) close.current(false); };
    window.addEventListener('resize', resized);
    document.addEventListener('scroll', scrolled, true);
    return () => { window.removeEventListener('resize', resized); document.removeEventListener('scroll', scrolled, true); };
  }, [floating, opener, confirming, error]);

  useLayoutEffect(() => { list.current?.querySelector<HTMLElement>(ENABLED_ITEMS)?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (confirming) confirm.current?.focus({ preventScroll: true });
    else if (asked.current) remove.current?.focus({ preventScroll: true });
    asked.current = confirming;
  }, [confirming]);
  useEffect(() => {
    if (error) (confirm.current ?? list.current?.querySelector<HTMLElement>(ENABLED_ITEMS))?.focus({ preventScroll: true });
  }, [error]);

  const act = async (run: () => Promise<unknown>, after: () => void) => {
    setBusy(true); setError('');
    try { await run(); after(); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); setBusy(false); }
  };
  const style: CSSProperties | undefined = floating && box ? box : undefined;
  return (
    <ul ref={list} className={`bt-menu${className ? ` ${className}` : ''}`} role="menu" aria-label={label} style={style}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); return; }
        const items = [...e.currentTarget.querySelectorAll<HTMLElement>(ENABLED_ITEMS)];
        const next = menuStep(items.indexOf(document.activeElement as HTMLElement), items.length, e.key);
        if (next !== null) { e.preventDefault(); items[next]?.focus(); }
      }}
      onBlur={e => { if (menuLeft(e.relatedTarget, e.currentTarget.contains(e.relatedTarget as Node | null), opener.current)) onClose(false); }}>
      {lead}
      {conversation.archived !== 1 && (
        <li role="none"><button type="button" role="menuitem" className="bt-menu__item ui-menu__btn" disabled={busy}
          onClick={() => void act(() => api.archiveConversation(conversation.id), onArchived)}>{t('ui.session.archive')}</button></li>
      )}
      {confirming ? (
        <li role="none" className="ui-menu__confirm">
          <span id={note} className="bt-meta">{t(conversation.project_id ? 'ui.session.deleteWhatProduct' : 'ui.session.deleteWhat')}</span>
          <span className="ui-menu__confirmrow">
            <Button ref={confirm} role="menuitem" variant="danger" small aria-describedby={note} disabled={busy} onClick={() => void act(() => api.deleteConversation(conversation.id), onDeleted)}>{t('ui.session.deleteConfirm')}</Button>
            <Button role="menuitem" variant="ghost" small onClick={() => setConfirming(false)}>{t('ui.session.keep')}</Button>
          </span>
        </li>
      ) : (
        <li role="none"><button ref={remove} type="button" role="menuitem" className="bt-menu__item ui-menu__btn ui-danger" onClick={() => setConfirming(true)}>{t('ui.session.delete')}</button></li>
      )}
      {error && <li role="alert" className="bt-meta ui-danger ui-menu__error">{error}</li>}
    </ul>
  );
}
