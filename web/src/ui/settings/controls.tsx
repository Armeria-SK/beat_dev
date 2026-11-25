import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import type { ModelView, SettingsView } from '../../api.ts';
import { useT } from '../../i18n/index.ts';
import { isComposing } from '../../keys.ts';
import { accessText } from './access-text.tsx';
import type { Access } from '../../settings/access.ts';
import type { Config } from '../../settings/model.ts';
import { menuFit, menuScrollFor, menuStep, type Box, type MenuFit } from '../menu.ts';
import { Button, Icon } from '../parts.tsx';
import { fieldStep, listAccepts, listWithout, readNumber, type FieldDraft } from './commit.ts';
import type { Enqueue } from './flow.ts';

export interface Pending { row: string; items: Access[]; title?: string; ok?: string; run: () => void; cancel?: () => void }
export type Ask = Pick<Pending, 'row' | 'items' | 'title' | 'ok'>;

export interface SetCtx {
  view: SettingsView;
  config: Config;
  models: ModelView[];
  busy: string | null;
  pending: Pending | null;
  errors: Record<string, string>;
  revision: number;
  commit: (row: string, edit: (config: Config) => Config) => Promise<boolean>;
  queue: Enqueue;
  ask: (ask: Ask, run: () => Promise<boolean>) => Promise<boolean>;
  cancel: () => void;
  setDirty: (key: string, dirty: boolean) => void;
  guard: (go: () => void) => void;
  fail: (row: string, message: string) => void;
  clear: (row: string) => void;
  reload: () => Promise<void>;
  setBusy: (row: string | null) => void;
  onProfile: () => void;
  openCategory: (id: string) => void;
}

export const SettingsContext = createContext<SetCtx | null>(null);

export function useSet(): SetCtx {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('Settings context is missing');
  return ctx;
}

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return <div className="bt-group"><h3 className="bt-group__title">{title}</h3>{children}</div>;
}

export function Widen({ pending, busy, onCancel }: { pending: Pending; busy: boolean; onCancel: () => void }) {
  const t = useT();
  const title = pending.title ?? t('ui.set.widen.title');
  return (
    <div className="ui-confirm ui-set__widen" role="alertdialog" aria-label={title}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); } }}>
      <span className="bt-label">{title}</span>
      <ul className="ui-set__items">{pending.items.map((item, i) => <li key={`${item.kind}:${i}`} className="bt-meta">{accessText(t, item)}</li>)}</ul>
      <span className="ui-confirm__buttons">
        <Button variant="primary" small disabled={busy} onClick={pending.run}>{pending.ok ?? t('ui.set.widen.ok')}</Button>
        <Button variant="ghost" small autoFocus onClick={onCancel}>{t('ui.cancel')}</Button>
      </span>
    </div>
  );
}

export function Row({ k, title, desc, children, below }: { k: string; title: ReactNode; desc?: ReactNode; children?: ReactNode; below?: ReactNode }) {
  const ctx = useSet();
  const error = ctx.errors[k];
  const pending = ctx.pending?.row === k ? ctx.pending : null;
  return (
    <>
      <div className="bt-setting" data-row={k}>
        <div className="bt-setting__main">
          <span className="bt-setting__title">{title}</span>
          {desc && <span className="bt-setting__desc">{desc}</span>}
        </div>
        {children && <div className="bt-setting__end">{children}</div>}
      </div>
      {(below || error || pending) && (
        <div className="ui-set__below" data-below={k}>
          {below}
          {error && <p className="bt-meta bt-del ui-set__error" role="alert">{error}</p>}
          {pending && <Widen pending={pending} busy={ctx.busy !== null} onCancel={ctx.cancel} />}
        </div>
      )}
    </>
  );
}

export function Switch({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: (next: boolean) => void }) {
  return <button type="button" className="bt-switch" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export interface Option<V extends string> { value: V; label: string }

export function Seg<V extends string>({ value, options, label, disabled, onChange }: { value: V | undefined; options: ReadonlyArray<Option<V>>; label: string; disabled?: boolean; onChange: (value: V) => void }) {
  return (
    <div className="bt-seg" role="group" aria-label={label}>
      {options.map(option => (
        <button key={option.value} type="button" className="bt-seg__opt" aria-pressed={value === option.value} disabled={disabled}
          onClick={() => { if (value !== option.value) onChange(option.value); }}>{option.label}</button>
      ))}
    </div>
  );
}

const MENU_GAP = 4;

function clipBounds(el: HTMLElement): Box {
  const box = { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const rect = node.getBoundingClientRect();
    box.top = Math.max(box.top, rect.top);
    box.left = Math.max(box.left, rect.left);
    box.bottom = Math.min(box.bottom, rect.top + node.clientHeight);
    box.right = Math.min(box.right, rect.left + node.clientWidth);
  }
  return box;
}

const revealIn = (menu: HTMLElement, item: HTMLElement): void => {
  menu.scrollTop = menuScrollFor({ top: item.offsetTop, height: item.offsetHeight }, menu.scrollTop, menu.clientHeight);
};

export function Select<V extends string>({ value, options, label, placeholder, disabled, onChange }: {
  value: V | null; options: ReadonlyArray<Option<V>>; label: string; placeholder?: string; disabled?: boolean; onChange: (value: V) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fit, setFit] = useState<MenuFit | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    if (!open) { setFit(null); return undefined; }
    const place = () => {
      const menu = list.current;
      const opener = button.current;
      if (menu && opener) setFit(menuFit(opener.getBoundingClientRect(), clipBounds(menu), { width: menu.offsetWidth, height: menu.scrollHeight }, MENU_GAP));
    };
    place();
    const moved = (e: Event) => { if (e.target !== list.current) place(); };
    window.addEventListener('resize', place);
    document.addEventListener('scroll', moved, true);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', moved, true); };
  }, [open]);
  const placed = fit !== null;
  useEffect(() => {
    const menu = list.current;
    if (!open || !placed || !menu) return;
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    const target = items.find(el => el.getAttribute('aria-checked') === 'true') ?? items[0];
    if (!target) return;
    target.focus({ preventScroll: true });
    revealIn(menu, target);
  }, [open, placed]);
  useLayoutEffect(() => {
    const menu = list.current;
    const active = document.activeElement;
    if (fit && menu && active instanceof HTMLElement && menu.contains(active)) revealIn(menu, active);
  }, [fit]);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };
  const current = options.find(o => o.value === value);
  return (
    <span ref={box} className="ui-set__select">
      <button ref={button} type="button" className="bt-select" aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled || options.length === 0} onClick={() => setOpen(!open)}>
        {current?.label ?? placeholder ?? '—'} <Icon name="chevD" />
      </button>
      {open && (
        <ul ref={list} className={`bt-menu ui-set__menu${fit?.up ? ' ui-set__menu--up' : ''}${fit?.left ? ' ui-set__menu--left' : ''}`} role="menu" aria-label={label}
          style={fit ? { '--ui-menu-room': `${fit.maxHeight}px`, '--ui-menu-width': `${fit.maxWidth}px` } as CSSProperties : undefined}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
            if (e.key === 'Tab') { close(); return; }
            const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
            const next = menuStep(items.indexOf(document.activeElement as HTMLElement), items.length, e.key);
            if (next !== null) { e.preventDefault(); items[next]?.focus(); }
          }}>
          {options.map(option => (
            <li key={option.value} role="none">
              <button type="button" role="menuitemradio" aria-checked={option.value === value} className="bt-menu__item"
                onClick={() => { close(); if (option.value !== value) onChange(option.value); }}><b>{option.label}</b>{option.value === value && <Icon name="check" />}</button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

function useField(value: string, revision: number, onCommit: (value: string) => void, resetKey: unknown = null, accept?: (value: string) => boolean) {
  const [draft, setDraft] = useState<FieldDraft>({ saved: value, text: value });
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => { setDraft({ saved: value, text: value }); }, [value, revision, resetKey]);
  const run = (event: Parameters<typeof fieldStep>[1]) => {
    const next = fieldStep(latest.current, event, accept);
    latest.current = next.draft;
    setDraft(next.draft);
    if (next.commit !== null) onCommit(next.commit);
  };
  return {
    value: draft.text,
    onChange: (e: { target: { value: string } }) => run({ type: 'input', text: e.target.value }),
    onBlur: () => run({ type: 'blur' }),
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      const composing = isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode });
      if (e.key === 'Escape' && latest.current.text !== latest.current.saved) { e.preventDefault(); e.stopPropagation(); }
      if (e.key === 'Enter' && !composing) e.preventDefault();
      run({ type: 'key', key: e.key, composing });
    },
  };
}

export function CommitField({ value, label, mono, short, placeholder, type, disabled, resetKey, required, onCommit }: {
  value: string; label: string; mono?: boolean; short?: boolean; placeholder?: string; type?: 'text' | 'url'; disabled?: boolean; resetKey?: unknown; required?: boolean; onCommit: (value: string) => void;
}) {
  const ctx = useSet();
  const field = useField(value, ctx.revision, onCommit, resetKey, required ? text => text !== '' : undefined);
  const classes = ['bt-field', mono && 'bt-field--mono', short && 'bt-field--short'].filter(Boolean).join(' ');
  return <input className={classes} type={type ?? 'text'} aria-label={label} placeholder={placeholder} spellCheck={false} autoComplete="off" disabled={disabled} {...field} />;
}

// 鍵・秘密の欄。値を持たせた欄は打った文字を value 属性にも写し（画面の HTML・開発者ツールに出る）、この部品は値を欄の中（プロパティ）にだけ持たせる
export function SecretField({ value, onChange, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange'> & { value: string; onChange: (value: string) => void }) {
  const field = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => { if (field.current && field.current.value !== value) field.current.value = value; });
  return <input {...rest} ref={field} type="password" onChange={e => onChange(e.target.value)} />;
}

export function NumberField({ k, value, label, min, max, optional, placeholder, onCommit }: {
  k: string; value: number | undefined; label: string; min?: number; max?: number; optional?: boolean; placeholder?: string | undefined; onCommit: (value: number | undefined) => void;
}) {
  const t = useT();
  const ctx = useSet();
  const field = useField(value === undefined ? '' : String(value), ctx.revision, text => {
    const read = readNumber(text, { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(optional ? { optional } : {}) });
    if (read.kind === 'bad') { ctx.fail(k, t('ui.set.number', min ?? 0, max ?? 0)); return; }
    ctx.clear(k);
    onCommit(read.value);
  });
  return <input className="bt-field bt-field--mono bt-field--short" inputMode="numeric" aria-label={label} placeholder={placeholder} spellCheck={false} autoComplete="off" {...field} />;
}

export function ListField({ items, label, placeholder, disabled, allowDuplicates, onChange }: { items: readonly string[]; label: string; placeholder?: string; disabled?: boolean; allowDuplicates?: boolean; onChange: (items: string[]) => void }) {
  const t = useT();
  const ctx = useSet();
  const field = useField('', ctx.revision, value => onChange([...items, value]), items.join('\n'), value => listAccepts(items, value, allowDuplicates));
  return (
    <div className="ui-set__list">
      {items.length > 0 && (
        <ul className="ui-set__chips" aria-label={label}>
          {items.map((item, index) => (
            <li key={`${index}:${item}`} className="ui-set__chip">
              <code>{item}</code>
              <button type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.set.list.remove', item)} disabled={disabled}
                onClick={() => onChange(listWithout(items, index))}><Icon name="x" /></button>
            </li>
          ))}
        </ul>
      )}
      <input className="bt-field bt-field--mono" aria-label={t('ui.set.list.add', label)} placeholder={placeholder ? t('ui.set.list.ph', placeholder) : undefined} spellCheck={false} autoComplete="off" disabled={disabled} {...field} />
    </div>
  );
}

export function Loading({ failed, onRetry }: { failed: boolean; onRetry?: () => void }) {
  const t = useT();
  return (
    <p className="bt-meta" role={failed ? 'alert' : 'status'}>
      {failed ? t('ui.set.loadFailed') : t('ui.set.loading')}
      {failed && onRetry && <> · <button type="button" className="bt-notice__action" onClick={onRetry}>{t('ui.set.retry')}</button></>}
    </p>
  );
}
