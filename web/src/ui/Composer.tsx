import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { PERMISSION_MODES, type PermissionMode } from '../../../src/shared/permission-mode.ts';
import { api, type ModelChoice, type ModelView, type PendingMessage, type UploadView } from '../api.ts';
import { useT } from '../i18n/index.ts';
import {
  ATTACH_ACCEPT, attachRoom, composerView, depthOptions, enterAction, MODE_LABEL, modelInEffect, modelName, modelOptions, PLACEHOLDER, queuedLine, slashItems,
  type SlashContext, type SubmitKind, type UiSlash,
} from './composer-state.ts';
import { menuStep } from './menu.ts';
import { Icon } from './parts.tsx';

const MAX_HEIGHT = 200;

export interface ComposerProps {
  hasConversation: boolean;
  running: boolean;
  sending: boolean;
  pending: PendingMessage[];
  models: ModelView[] | null;
  chatOrder: string[];
  modelId: string | null;
  effort: string | null;
  mode: PermissionMode;
  slash: SlashContext;
  onSubmit: (kind: SubmitKind, text: string, attachments: UploadView[]) => Promise<boolean>;
  onStop: () => void;
  onChoose: (choice: ModelChoice) => void;
  onCancelPending: (id: string) => void;
  onSlash: (command: UiSlash) => void;
  onAttachFailed: (error: unknown) => void;
}

type Pop = 'model' | 'depth' | null;

function PopMenu({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const items = list.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)') ?? [];
    ([...items].find(el => el.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
  }, []);
  return (
    <ul ref={list} className="bt-menu ui-pop" role="menu" aria-label={label}
      onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
        const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]:not(:disabled)')];
        const next = menuStep(items.indexOf(document.activeElement as HTMLElement), items.length, e.key);
        if (next !== null) { e.preventDefault(); items[next]?.focus(); }
      }}>
      {children}
    </ul>
  );
}

function PopItem({ name, hint, checked, disabled, onPick }: { name: string; hint?: string; checked: boolean; disabled?: boolean; onPick: () => void }) {
  return (
    <li role="none">
      <button type="button" role="menuitemradio" aria-checked={checked} disabled={disabled} className="bt-menu__item ui-pop__item" onClick={onPick}><b>{name}</b>{hint}</button>
    </li>
  );
}

export function Composer(props: ComposerProps) {
  const { hasConversation, running, sending, pending, models, chatOrder, modelId, effort, mode } = props;
  const t = useT();
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<UploadView[]>([]);
  const [uploading, setUploading] = useState(false);
  const [pop, setPop] = useState<Pop>(null);
  const [slashForced, setSlashForced] = useState(false);
  const [slashClosed, setSlashClosed] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
  const depthButton = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);

  const view = composerView({ hasConversation, running, mode, chatModels: models ? models.filter(m => m.inChat).length : null, text, attachments: attached.length, uploading, sending });
  const current = modelInEffect(models ?? [], chatOrder, modelId);
  const depths = depthOptions(current);
  const commands = slashClosed ? [] : slashItems(text, props.slash, slashForced);
  const active = Math.min(slashIndex, Math.max(0, commands.length - 1));

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(MAX_HEIGHT, el.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    if (!matchMedia('(pointer: coarse)').matches) input.current?.focus();
  }, []);

  useEffect(() => {
    if (pop === null && !slashForced) return undefined;
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) { setPop(null); setSlashForced(false); } };
    addEventListener('pointerdown', onDown);
    return () => removeEventListener('pointerdown', onDown);
  }, [pop, slashForced]);

  const closePop = () => {
    (pop === 'depth' ? depthButton : modelButton).current?.focus();
    setPop(null);
  };

  const change = (value: string) => { setText(value); setSlashIndex(0); setSlashClosed(false); if (!value.startsWith('/')) setSlashForced(false); };

  const submit = async (kind: SubmitKind) => {
    if (!view.canSubmit || submitting.current) return;
    submitting.current = true;
    try {
      if (await props.onSubmit(kind, text.trim(), attached)) { setText(''); setAttached([]); }
    } finally { submitting.current = false; }
    input.current?.focus();
  };

  const runSlash = (command: UiSlash) => {
    setSlashForced(false);
    const typed = text.startsWith('/') ? '' : text;
    if (command.name === 'rename') { setText(`/rename ${typed}`); setSlashClosed(true); input.current?.focus(); return; }
    props.onSlash(command);
    if (!typed) setText('');
    input.current?.focus();
  };

  const attach = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const picked of [...files].slice(0, attachRoom(attached.length, files.length))) {
        const upload = await api.upload(picked);
        setAttached(list => [...list, upload]);
      }
    } catch (error) { props.onAttachFailed(error); } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing || e.keyCode === 229;
    if (composing) return;
    if (commands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((active + 1) % commands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((active - 1 + commands.length) % commands.length); return; }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); runSlash(commands[active]!); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSlashClosed(true); setSlashForced(false); return; }
    }
    const action = enterAction({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, composing }, running);
    if (action === null) return;
    e.preventDefault();
    void submit(action);
  };

  const modelText = modelId ? (current ? modelName(current) : modelId) : current ? t('ui.composer.autoModel', modelName(current)) : t('ui.composer.auto');

  return (
    <div ref={box} className="bt-composer">
      {commands.length > 0 && (
        <ul className="bt-menu bt-composer__menu" role="listbox" id="ui-slash" aria-label={t('ui.composer.slash')}>
          {commands.map((command, i) => (
            <li key={command.name} id={`ui-slash-${command.name}`} role="option" aria-selected={i === active} className={`bt-menu__item${i === active ? ' is-active' : ''}`}
              onMouseDown={e => { e.preventDefault(); runSlash(command); }} onMouseEnter={() => setSlashIndex(i)}>
              <b>/{command.name}</b>{t(command.desc)}
            </li>
          ))}
        </ul>
      )}
      {pop === 'model' && (
        <PopMenu label={t('ui.composer.model')} onClose={closePop}>
          {modelOptions(models ?? [], modelId).map(option => (
            <PopItem key={option.id ?? ''} name={option.name ?? t('ui.composer.auto')} hint={option.id === null ? t('ui.composer.autoHint') : option.disabled ? t('ui.composer.unavailable') : option.hint}
              checked={option.checked} disabled={option.disabled} onPick={() => { closePop(); if (option.id !== modelId) props.onChoose({ modelId: option.id }); }} />
          ))}
        </PopMenu>
      )}
      {pop === 'depth' && (
        <PopMenu label={t('ui.composer.depth')} onClose={closePop}>
          {[null, ...depths].map(value => (
            <PopItem key={value ?? ''} name={value ?? t('ui.composer.depthDefault')} checked={effort === value} onPick={() => { closePop(); if (value !== effort) props.onChoose({ effort: value }); }} />
          ))}
        </PopMenu>
      )}
      {pending.map(p => (
        <div key={p.id} className="bt-composer__queue bt-rise">
          <span className="bt-label">{t('ui.composer.queued')}</span>
          <span className="bt-composer__queue-text">{queuedLine(p)}</span>
          <span className="bt-meta">{p.interrupt ? t('ui.composer.queuedForce') : t('ui.composer.queuedHint')}</span>
          <button type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.composer.unqueue')} onClick={() => props.onCancelPending(p.id)}><Icon name="x" /></button>
        </div>
      ))}
      {attached.length > 0 && (
        <div className="bt-composer__attach">
          {attached.map(a => (
            <button key={a.id} type="button" className="bt-chip ui-chip" title={t('ui.composer.detach', a.name)} aria-label={t('ui.composer.detach', a.name)}
              onClick={() => setAttached(list => list.filter(x => x.id !== a.id))}>
              <Icon name={a.kind === 'image' ? 'image' : 'file'} />{a.name}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={input} className="bt-composer__input" rows={1} value={text} disabled={view.disabled} readOnly={sending}
        aria-label={t('ui.composer.message')} placeholder={t(PLACEHOLDER[view.placeholder])}
        aria-controls={commands.length > 0 ? 'ui-slash' : undefined} aria-activedescendant={commands.length > 0 ? `ui-slash-${commands[active]!.name}` : undefined}
        onChange={e => change(e.target.value)} onKeyDown={onKeyDown}
      />
      <div className="bt-composer__bar">
        <input ref={file} type="file" multiple hidden accept={ATTACH_ACCEPT} onChange={e => void attach(e.target.files)} />
        <button type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.composer.attach')} title={t('ui.composer.attach')} disabled={!view.canAttach} onClick={() => file.current?.click()}>
          <Icon name="paperclip" />
        </button>
        <button type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.composer.slash')} title={t('ui.composer.slash')} aria-expanded={commands.length > 0} disabled={view.disabled}
          onClick={() => { const open = commands.length > 0; setPop(null); setSlashIndex(0); setSlashClosed(open); setSlashForced(!open); input.current?.focus(); }}>
          <Icon name="slash" />
        </button>
        <span className="ui-composer__picks">
          <button ref={modelButton} type="button" className="bt-select" aria-label={t('ui.composer.model')} aria-haspopup="menu" aria-expanded={pop === 'model'} disabled={view.disabled}
            onClick={() => { setSlashForced(false); setPop(open => (open === 'model' ? null : 'model')); }}>
            {modelText} <Icon name="chevD" className="ui-select__chev" />
          </button>
          {depths.length > 0 && (
            <button ref={depthButton} type="button" className="bt-select" aria-label={t('ui.composer.depth')} aria-haspopup="menu" aria-expanded={pop === 'depth'}
              onClick={() => { setSlashForced(false); setPop(open => (open === 'depth' ? null : 'depth')); }}>
              {t('ui.composer.depthValue', effort ?? t('ui.composer.depthDefault'))} <Icon name="chevD" className="ui-select__chev" />
            </button>
          )}
        </span>
        <span className="bt-composer__spacer" />
        <span className="bt-seg" role="group" aria-label={t('ui.composer.mode')}>
          {PERMISSION_MODES.map(value => (
            <button key={value} type="button" className="bt-seg__opt" aria-pressed={mode === value} disabled={view.disabled} onClick={() => { if (value !== mode) props.onChoose({ permissionMode: value }); }}>{t(MODE_LABEL[value])}</button>
          ))}
        </span>
        {view.actions === 'busy' ? (
          <>
            <button type="button" className="bt-btn bt-btn--sm" title={t('ui.composer.queueHint')} disabled={!view.canSubmit} onClick={() => void submit('queue')}>{t('ui.composer.queue')}</button>
            <button type="button" className="bt-btn bt-btn--sm bt-btn--primary" title={t('ui.composer.forceHint')} disabled={!view.canSubmit} onClick={() => void submit('force')}>{t('ui.composer.force')}</button>
            <button type="button" className="bt-btn bt-btn--icon" aria-label={t('ui.composer.stop')} title={t('ui.composer.stop')} onClick={props.onStop}><Icon name="square" /></button>
          </>
        ) : (
          <button type="button" className="bt-btn bt-btn--icon bt-btn--primary" aria-label={t('ui.composer.send')} title={t('ui.composer.send')} disabled={!view.canSubmit} onClick={() => void submit('send')}><Icon name="arrowUp" /></button>
        )}
      </div>
    </div>
  );
}
