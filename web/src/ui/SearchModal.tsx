import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { api, type Conversation, type Project } from '../api.ts';
import { useT } from '../i18n/index.ts';
import { isComposing } from '../keys.ts';
import type { UiIconName } from './icons.ts';
import { Icon } from './parts.tsx';
import { routeHash } from './routes.ts';
import { freshSearch, IDLE_SEARCH, SEARCH_TABS, searchNote, searchRows, stepIndex, stepTab, switchesTab, type HeldSearch, type SearchTab } from './search-state.ts';

const TAB_LABEL = { all: 'ui.search.tabAll', conversations: 'ui.search.tabSessions', products: 'ui.search.tabProducts' } as const;

interface Item { key: string; href: string; icon: UiIconName; title: string; snippet: string; meta: string | null; group: 'recent' | 'actions' | null }

export interface SearchModalProps {
  products: readonly Project[]; conversations: readonly Conversation[];
  query: string; tab: SearchTab; onQuery: (query: string) => void; onTab: (tab: SearchTab) => void;
  onClose: (opened: boolean, href?: string) => void;
}

export function SearchModal({ products, conversations, query, tab, onQuery, onTab, onClose }: SearchModalProps) {
  const t = useT();
  const uid = useId();
  const [current, setCurrent] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldSearch>(IDLE_SEARCH);
  const field = useRef<HTMLInputElement>(null);
  const shut = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { field.current?.select(); }, []);
  useEffect(() => {
    const q = query.trim();
    if (!q) { setHeld(IDLE_SEARCH); return undefined; }
    let live = true;
    const timer = setTimeout(() => {
      void api.history(q).then(r => { if (live) setHeld({ query: q, state: { kind: 'loaded', hits: r.hits } }); }).catch(() => { if (live) setHeld({ query: q, state: { kind: 'failed' } }); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [query]);

  const search = freshSearch(held, query);
  const items = useMemo<Item[]>(() => {
    const recent = query.trim() === '' && tab !== 'products';
    const found = searchRows({ query, tab, state: search, conversations, projects: products }).map<Item>(r => (r.kind === 'product'
      ? { key: `p:${r.id}`, href: routeHash({ view: 'product', id: r.id }), icon: 'grid', title: r.title ?? '', snippet: '', meta: null, group: null }
      : { key: `c:${r.id}`, href: routeHash({ view: 'chat', id: r.id }), icon: 'msg', title: r.title || t('ui.session.untitled'), snippet: r.snippet, meta: r.productName, group: recent ? 'recent' : null }));
    if (!recent || tab !== 'all') return found;
    return [...found,
      { key: 'a:new', href: routeHash({ view: 'new' }), icon: 'plus', title: t('ui.session.new'), snippet: '', meta: null, group: 'actions' },
      { key: 'a:product', href: routeHash({ view: 'newProduct' }), icon: 'plus', title: t('ui.product.new'), snippet: '', meta: null, group: 'actions' }];
  }, [query, tab, search, conversations, products, t]);

  const active = items.length === 0 ? -1 : Math.max(0, items.findIndex(item => item.key === current));
  const note = searchNote({ query, tab, state: search, rows: items.length });
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [active, items]);

  const pickTab = (next: SearchTab) => { onTab(next); setCurrent(null); field.current?.focus(); };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) return;
    const plain = !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey);
    if (e.key === 'Enter') {
      if (plain && e.target === field.current && active >= 0) { e.preventDefault(); list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.click(); }
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(false); }
    else if (e.key === 'Tab') { e.preventDefault(); (e.target === field.current ? shut.current : field.current)?.focus(); }
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && plain) {
      if (!switchesTab(e.key, e.target === field.current ? field.current : null)) return;
      e.preventDefault();
      pickTab(stepTab(tab, e.key === 'ArrowRight' ? 1 : -1));
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && plain) {
      e.preventDefault();
      const next = items[stepIndex(items.length, Math.max(active, 0), e.key === 'ArrowDown' ? 1 : -1)];
      if (next) setCurrent(next.key);
    }
  };

  const row = (item: Item, i: number) => (
    <a key={item.key} id={`${uid}-o${i}`} role="option" aria-selected={i === active} tabIndex={-1} className="bt-side ui-find__row" href={item.href}
      onMouseMove={() => { if (i !== active) setCurrent(item.key); }} onClick={() => onClose(true, item.href)}>
      <Icon name={item.icon} />
      <span className="bt-side__name">{item.title}{item.snippet && <span className="bt-meta ui-find__snippet">{item.snippet}</span>}</span>
      {item.meta && <span className="bt-meta ui-find__meta">{item.meta}</span>}
      {i === active && <kbd className="ui-find__enter" aria-hidden="true">↵</kbd>}
    </a>
  );
  const labelOf = { recent: t('ui.search.recent'), actions: t('ui.search.actions') } as const;
  const groups: Array<{ group: Item['group']; first: number; items: Item[] }> = [];
  items.forEach((item, i) => {
    const last = groups[groups.length - 1];
    if (last && last.group === item.group) last.items.push(item); else groups.push({ group: item.group, first: i, items: [item] });
  });

  return createPortal(
    <div className="ui-overlay">
      <div className="bt-scrim ui-find__scrim" onMouseDown={e => { if (e.target === e.currentTarget) { e.preventDefault(); onClose(false); } }}>
        <section className="bt-modal ui-find" role="dialog" aria-modal="true" aria-label={t('ui.search.open')} tabIndex={-1} onKeyDown={onKeyDown}>
          <div className="ui-find__bar">
            <Icon name="search" />
            <input ref={field} className="bt-field" type="text" autoFocus value={query} role="combobox" aria-expanded="true" aria-controls={`${uid}-list`} aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? `${uid}-o${active}` : undefined} aria-label={t('ui.search.field')} placeholder={t('ui.search.field')}
              onChange={e => { onQuery(e.target.value); setCurrent(null); }} />
            <button ref={shut} type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.search.close')} onClick={() => onClose(false)}><Icon name="x" /></button>
          </div>
          <div className="bt-tabs ui-find__tabs" role="tablist" aria-label={t('ui.search.tabs')}>
            {SEARCH_TABS.map(id => (
              <button key={id} type="button" role="tab" className="bt-tab" aria-selected={id === tab} aria-controls={`${uid}-list`} tabIndex={-1}
                onMouseDown={e => e.preventDefault()} onClick={() => pickTab(id)}>{t(TAB_LABEL[id])}</button>
            ))}
          </div>
          <div role="status" className="ui-find__status">
            {note === 'none' && <span className="bt-meta ui-find__none">{t('ui.search.none')}</span>}
            {note === 'failed' && <span className="bt-meta ui-find__none ui-danger">{t('ui.kanban.loadFailed')}</span>}
          </div>
          <div ref={list} id={`${uid}-list`} role="listbox" aria-label={t('ui.search.field')} className="ui-find__list">
            {groups.map(g => (g.group === null
              ? g.items.map((item, k) => row(item, g.first + k))
              : (
                <div key={g.group} role="group" aria-label={labelOf[g.group]}>
                  <span className="bt-label ui-find__label" aria-hidden="true">{labelOf[g.group]}</span>
                  {g.items.map((item, k) => row(item, g.first + k))}
                </div>
              )))}
          </div>
          <footer className="ui-find__keys bt-meta">
            <span><kbd>Esc</kbd>{t('ui.search.hintClose')}</span>
            <span><kbd>←</kbd><kbd>→</kbd>{t('ui.search.hintTab')}</span>
            <span><kbd>↑</kbd><kbd>↓</kbd>{t('ui.search.hintMove')}</span>
            <span><kbd>↵</kbd>{t('ui.search.hintOpen')}</span>
          </footer>
        </section>
      </div>
    </div>,
    document.body,
  );
}
