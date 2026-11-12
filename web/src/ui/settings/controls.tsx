import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ModelView, SettingsView } from '../../api.ts';
import { useT } from '../../i18n/index.ts';
import { isComposing } from '../../keys.ts';
import { accessText } from '../../settings/AccessConfirm.tsx';
import type { Access } from '../../settings/access.ts';
import type { Config } from '../../settings/model.ts';
import { menuStep } from '../menu.ts';
import { Button, Icon } from '../parts.tsx';
import { fieldStep, readNumber, type FieldDraft } from './commit.ts';

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
  ask: (ask: Ask, run: () => Promise<boolean>) => Promise<boolean>;
  cancel: () => void;
  setDirty: (key: string, dirty: boolean) => void;
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

export function Select<V extends string>({ value, options, label, placeholder, disabled, onChange }: {
  value: V | null; options: ReadonlyArray<Option<V>>; label: string; placeholder?: string; disabled?: boolean; onChange: (value: V) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const items = list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [];
    ([...items].find(el => el.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
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
        <ul ref={list} className="bt-menu ui-set__menu" role="menu" aria-label={label}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
            const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
            const next = menuStep(items.indexOf(document.activeElement as HTMLElement), items.length, e.key);
            if (next !== null) { e.preventDefault(); items[next]?.focus(); }
          }}>
          {options.map(option => (
            <li key={option.value} role="none">
              <button type="button" role="menuitemradio" aria-checked={option.value === value} className="bt-menu__item"
                onClick={() => { close(); if (option.value !== value) onChange(option.value); }}>{option.label}</button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}

function useField(value: string, revision: number, onCommit: (value: string) => void, resetKey: unknown = null) {
  const [draft, setDraft] = useState<FieldDraft>({ saved: value, text: value });
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => { setDraft({ saved: value, text: value }); }, [value, revision, resetKey]);
  const run = (event: Parameters<typeof fieldStep>[1]) => {
    const next = fieldStep(latest.current, event);
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

export function CommitField({ value, label, mono, short, placeholder, type, disabled, resetKey, onCommit }: {
  value: string; label: string; mono?: boolean; short?: boolean; placeholder?: string; type?: 'text' | 'url'; disabled?: boolean; resetKey?: unknown; onCommit: (value: string) => void;
}) {
  const ctx = useSet();
  const field = useField(value, ctx.revision, onCommit, resetKey);
  const classes = ['bt-field', mono && 'bt-field--mono', short && 'bt-field--short'].filter(Boolean).join(' ');
  return <input className={classes} type={type ?? 'text'} aria-label={label} placeholder={placeholder} spellCheck={false} autoComplete="off" disabled={disabled} {...field} />;
}

export function NumberField({ k, value, label, min, max, optional, onCommit }: {
  k: string; value: number | undefined; label: string; min?: number; max?: number; optional?: boolean; onCommit: (value: number | undefined) => void;
}) {
  const t = useT();
  const ctx = useSet();
  const field = useField(value === undefined ? '' : String(value), ctx.revision, text => {
    const read = readNumber(text, { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(optional ? { optional } : {}) });
    if (read.kind === 'bad') { ctx.fail(k, t('ui.set.number', min ?? 0, max ?? 0)); return; }
    ctx.clear(k);
    onCommit(read.value);
  });
  return <input className="bt-field bt-field--mono bt-field--short" inputMode="numeric" aria-label={label} spellCheck={false} autoComplete="off" {...field} />;
}

export function ListField({ items, label, placeholder, disabled, onChange }: { items: readonly string[]; label: string; placeholder?: string; disabled?: boolean; onChange: (items: string[]) => void }) {
  const t = useT();
  const ctx = useSet();
  const field = useField('', ctx.revision, value => { if (value && !items.includes(value)) onChange([...items, value]); }, items.join('\n'));
  return (
    <div className="ui-set__list">
      {items.length > 0 && (
        <ul className="ui-set__chips" aria-label={label}>
          {items.map(item => (
            <li key={item} className="ui-set__chip">
              <code>{item}</code>
              <button type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.set.list.remove', item)} disabled={disabled}
                onClick={() => onChange(items.filter(x => x !== item))}><Icon name="x" /></button>
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
