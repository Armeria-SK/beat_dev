import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useT } from '../i18n/index.ts';
import type { AgentState } from './agent-state.ts';
import { GLYPHS, type UiIconName } from './icons.ts';

export function Icon({ name }: { name: UiIconName }) {
  const glyph = GLYPHS[name];
  if (!glyph) return null;
  return <svg className="bt-icon" viewBox="0 0 16 16" aria-hidden="true" dangerouslySetInnerHTML={{ __html: glyph }} />;
}

type ButtonVariant = 'primary' | 'ghost' | 'danger';

export function Button({ variant, small, icon, children, className, type = 'button', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant; small?: boolean; icon?: UiIconName;
}) {
  const classes = ['bt-btn', variant && `bt-btn--${variant}`, small && 'bt-btn--sm', icon && !children && 'bt-btn--icon', className].filter(Boolean).join(' ');
  return <button {...rest} type={type} className={classes}>{icon && <Icon name={icon} />}{children}</button>;
}

export type PillTone = 'running' | 'waiting' | 'ok' | 'warn' | 'danger';

export function Pill({ tone, children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={`bt-pill${tone ? ` bt-pill--${tone}` : ''}`}><span className="bt-pill__dot" />{children}</span>;
}

export const countText = (n: number): string => (n > 99 ? '99+' : String(n));

export function CountBadge({ n, quiet, label }: { n: number; quiet?: boolean; label?: string }) {
  if (n <= 0) return null;
  return <span className={`bt-count${quiet ? ' bt-count--quiet' : ''}`} aria-label={label}><span className="bt-count__n">{countText(n)}</span></span>;
}

const AVATAR_LABEL = { idle: 'ui.avatar.idle', working: 'ui.avatar.working', waiting: 'ui.avatar.waiting' } as const;

export function Avatar({ state, size }: { state: AgentState; size?: 'sm' | 'lg' }) {
  const t = useT();
  const classes = ['bt-avatar', size && `bt-avatar--${size}`, state !== 'idle' && `bt-avatar--${state}`].filter(Boolean).join(' ');
  return (
    <span className={classes} role="img" aria-label={t(AVATAR_LABEL[state])}>
      <span className="bt-avatar__ring" /><span className="bt-avatar__orbit" /><span className="bt-avatar__body" />
    </span>
  );
}

export function EmptyState({ lead, title, text, action }: { lead?: ReactNode; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="bt-empty bt-rise">
      {lead}
      <h2 className="bt-empty__title">{title}</h2>
      {text && <p className="bt-empty__text">{text}</p>}
      {action}
    </div>
  );
}

export function Notice({ tone, icon, title, text, action }: {
  tone?: 'warn' | 'fail'; icon?: UiIconName; title: ReactNode; text?: ReactNode; action?: { label: string; run: () => void };
}) {
  if (tone === 'fail') {
    return (
      <div className="bt-notice bt-notice--fail bt-rise" role="alert">
        <Icon name={icon ?? 'alert'} />
        <div className="bt-notice__body"><strong>{title}</strong>{text && <p>{text}</p>}</div>
        {action && <Button small onClick={action.run}>{action.label}</Button>}
      </div>
    );
  }
  return (
    <div className={`bt-notice${tone ? ` bt-notice--${tone}` : ''} bt-rise`}>
      <span className="bt-notice__rule" />
      {icon && <Icon name={icon} />}
      {title}
      {action && <button type="button" className="bt-notice__action" onClick={action.run}>{action.label}</button>}
      <span className="bt-notice__rule" />
    </div>
  );
}

export function Toast({ title, text, icon, live, leaving }: { title: string; text?: string | undefined; icon?: UiIconName | undefined; live?: boolean; leaving?: boolean }) {
  return (
    <div className={`bt-toast${leaving ? ' is-leaving' : ''}`}>
      {live ? <span className="bt-dot" aria-hidden="true" /> : <Icon name={icon ?? 'check'} />}
      <div className="bt-toast__body">
        <p className="bt-toast__title">{title}</p>
        {text && <p className="bt-toast__text">{text}</p>}
      </div>
    </div>
  );
}

export function ToastStack({ children }: { children: ReactNode }) {
  const t = useT();
  return <div className="bt-toasts" role="status" aria-live="polite" aria-label={t('ui.toasts')}>{children}</div>;
}
