import { useEffect, useState } from 'react';
import { notifyEnvName, secretProblem } from '../../../src/shared/secret-slots.ts';
import { api, ApiError, type NotifyChannelView, type NotifyKind, type NotifyLimits, type NotifyView } from '../api.ts';
import { useEscapeLayer } from '../hooks.ts';
import { useT } from '../i18n/index.ts';
import { toast } from '../toast.tsx';
import { AccessConfirm } from './AccessConfirm.tsx';
import { accessWidening, secretEntryAccess, type Access } from './access.ts';
import { FieldRow, NumberField } from './fields.tsx';
import { countChanges, type Config } from './model.ts';
import { SecretField } from './SecretField.tsx';
import type { SectionProps } from './types.ts';

const KINDS: readonly NotifyKind[] = ['task_done', 'task_waiting', 'task_failed', 'approval_needed', 'health_alert', 'info'];
const DEFAULT_KINDS: readonly NotifyKind[] = ['task_waiting', 'task_failed', 'approval_needed', 'health_alert'];
const ID_PATTERN = /^[a-z][a-z0-9-]{0,23}$/u;
const LIMIT_FIELDS: ReadonlyArray<{ key: keyof NotifyLimits; min: number; max: number }> = [
  { key: 'maxChannels', min: 1, max: 8 },
  { key: 'maxSendsPerHour', min: 1, max: 120 },
  { key: 'timeoutMs', min: 1000, max: 15000 },
  { key: 'retries', min: 0, max: 2 },
  { key: 'failsBeforeAlert', min: 1, max: 10 },
];

// 保存済みの設定に変更を当てた「もし保存したら」の設定。広がる変更かどうかを、保存の前に数えるために使う（保存はサーバーが行う）
function previewChannel(saved: Config, id: string, patch: Record<string, unknown>): Config {
  const next = structuredClone(saved);
  const channels = (next.notify?.channels ?? []) as Array<Record<string, unknown>>;
  const channel = channels.find(c => c.id === id);
  if (channel) Object.assign(channel, patch);
  return next;
}
function previewAdd(saved: Config, spec: { id: string; token: boolean; kinds: readonly NotifyKind[]; includeBody: boolean }): Config {
  const next = structuredClone(saved);
  const notify = (next.notify ??= { channels: [] }) as { channels?: unknown[] };
  const channel: Record<string, unknown> = { id: spec.id, kind: 'webhook', urlEnv: notifyEnvName(spec.id, 'url'), kinds: [...spec.kinds], enabled: true, includeBody: spec.includeBody };
  if (spec.token) channel.tokenEnv = notifyEnvName(spec.id, 'token');
  notify.channels = [...(notify.channels ?? []), channel];
  return next;
}
function previewNotify(saved: Config, patch: { publicBaseUrl?: string; limits?: Partial<NotifyLimits> }): Config {
  const next = structuredClone(saved);
  const notify = (next.notify ??= {}) as Record<string, any>;
  if (patch.publicBaseUrl !== undefined) notify.publicBaseUrl = patch.publicBaseUrl;
  if (patch.limits) notify.limits = { ...(notify.limits ?? {}), ...patch.limits };
  return next;
}

const savedAt = (ms: number): string => new Date(ms).toLocaleString();

export function NotifySection({ saved, draft, onChanged }: SectionProps & { onChanged: () => void }) {
  const t = useT();
  const [view, setView] = useState<NotifyView | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ items: Access[]; run: () => void } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ id: string; field: 'url' | 'token' } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ id: '', url: '', token: '', kinds: [...DEFAULT_KINDS] as NotifyKind[], includeBody: false });
  const [base, setBase] = useState('');
  const [limits, setLimits] = useState<NotifyLimits | null>(null);

  // 保存していない編集が他の節にあるときは、ここでの操作は止める（保存し直すと設定が読み込み直されるため）
  const ready = countChanges(saved, draft) === 0;

  const take = (next: NotifyView) => { setView(next); setBase(next.publicBaseUrl); setLimits(next.limits); };
  useEffect(() => {
    let live = true;
    api.notify().then(next => { if (live) take(next); }).catch(() => { if (live) setView('failed'); });
    return () => { live = false; };
  }, []);
  useEscapeLayer('dialog', confirm !== null, () => setConfirm(null));

  const fail = (failure: unknown) => setError(failure instanceof ApiError ? failure.message : t('settings.notify.failed'));
  async function act(run: () => Promise<NotifyView | undefined>, done?: string): Promise<boolean> {
    if (busy) return false;
    setBusy(true); setError(null); setConfirm(null);
    try {
      const next = await run();
      if (next) take(next);
      if (done) toast({ kind: 'done', icon: 'check', title: done });
      onChanged();
      return true;
    } catch (failure) { fail(failure); return false; } finally { setBusy(false); }
  }
  // 広がる変更は、並べて確かめてから行う
  const guarded = (items: Access[], run: () => void) => { if (items.length > 0) setConfirm({ items, run }); else run(); };

  if (view === null) return <span className="set-note" role="status">{t('settings.loading')}</span>;
  if (view === 'failed') return <span className="set-note" role="alert">{t('settings.notify.loadFailed')}</span>;
  const current: NotifyView = view;
  const full = current.channels.length >= current.limits.maxChannels;
  const off = busy || !ready;

  const reasonText = (reason: string | null): string => {
    if (!reason) return '';
    const http = /^http_(\d+)$/u.exec(reason);
    if (http) return t('settings.notify.reason.http', http[1]!);
    switch (reason) {
      case 'env_missing': return t('settings.notify.reason.env_missing');
      case 'bad_url': return t('settings.notify.reason.bad_url');
      case 'timeout': return t('settings.notify.reason.timeout');
      case 'network': return t('settings.notify.reason.network');
      case 'redirect': return t('settings.notify.reason.redirect');
      default: return t('settings.notify.reason.other');
    }
  };

  const patchChannel = (channel: NotifyChannelView, patch: { enabled?: boolean; kinds?: NotifyKind[]; includeBody?: boolean }) =>
    guarded(accessWidening(saved, previewChannel(saved, channel.id, patch)), () => void act(() => api.patchNotifyChannel(channel.id, patch)));

  const toggleKind = (channel: NotifyChannelView, kind: NotifyKind) => {
    const has = channel.kinds.includes(kind);
    if (has && channel.kinds.length === 1) return;
    patchChannel(channel, { kinds: KINDS.filter(k => (k === kind ? !has : channel.kinds.includes(k))) });
  };

  async function test(channel: NotifyChannelView) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await api.testNotifyChannel(channel.id);
      setTests(old => ({ ...old, [channel.id]: result.ok ? t('settings.notify.testOk') : t('settings.notify.testFailed', reasonText(result.reason)) }));
      take(await api.notify());
    } catch (failure) { fail(failure); } finally { setBusy(false); }
  }

  const submitUrl = (channel: NotifyChannelView, value: string) =>
    guarded(secretEntryAccess({ id: channel.id, field: 'url' }, saved), () => void act(async () => { await api.setNotifySecret(channel.id, 'url', value); return api.notify(); }, t('settings.notify.urlSaved')).then(ok => { if (ok) setEditing(null); }));
  const submitToken = (channel: NotifyChannelView, value: string) =>
    void act(async () => { await api.setNotifySecret(channel.id, 'token', value); return api.notify(); }, t('settings.notify.tokenSaved')).then(ok => { if (ok) setEditing(null); });
  const removeToken = (channel: NotifyChannelView) =>
    void act(async () => {
      const state = await api.deleteNotifySecret(channel.id, 'token');
      if (state.set) toast({ kind: 'info', icon: 'info', title: t('settings.notify.tokenStillOs') });
      return api.notify();
    }).then(() => setRemoving(null));

  const urlInvalid = form.url !== '' && secretProblem('url', form.url.trim()) !== undefined;
  const formReady = ID_PATTERN.test(form.id) && form.url.trim() !== '' && !urlInvalid && form.kinds.length > 0 && !current.channels.some(c => c.id === form.id);
  const submitAdd = () => {
    if (!formReady || off) return;
    const spec = { id: form.id, token: form.token.trim() !== '', kinds: form.kinds, includeBody: form.includeBody };
    guarded(accessWidening(saved, previewAdd(saved, spec)), () => void act(() => api.addNotifyChannel({
      id: form.id, url: form.url.trim(), ...(spec.token ? { token: form.token.trim() } : {}), kinds: [...form.kinds], includeBody: form.includeBody,
    }), t('settings.notify.added')).then(ok => { if (ok) { setAdding(false); setForm({ id: '', url: '', token: '', kinds: [...DEFAULT_KINDS], includeBody: false }); } }));
  };

  const limitsChanged = limits !== null && LIMIT_FIELDS.some(f => limits[f.key] !== current.limits[f.key]);
  const baseChanged = base.trim() !== current.publicBaseUrl;
  const saveLimits = () => {
    if (!limits) return;
    const patch = { limits, ...(baseChanged ? { publicBaseUrl: base.trim() } : {}) };
    guarded(accessWidening(saved, previewNotify(saved, patch)), () => void act(() => api.patchNotify(patch), t('settings.notify.limitsSaved')));
  };

  return (
    <div className="set-rows set-notify">
      <p className="set-note">{t('settings.notify.intro')}</p>
      {!ready && <p className="set-note" role="status">{t('settings.notify.needSave')}</p>}
      {error && <span className="set-row-error" role="alert">{error}</span>}
      {confirm && <AccessConfirm items={confirm.items} busy={busy} onCancel={() => setConfirm(null)} onConfirm={confirm.run} />}

      {current.channels.length === 0 && <p className="set-note">{t('settings.notify.none')}</p>}
      {current.channels.map(channel => (
        <section key={channel.id} className="set-notify-card" aria-label={channel.id}>
          <div className="set-row-between">
            <strong className="mono">{channel.id}</strong>
            <span className={`tag ${channel.enabled ? 'tag-neutral' : ''}`}>{channel.enabled ? t('settings.notify.enabled') : t('settings.notify.disabled')}</span>
          </div>
          <span className="set-row-desc">
            {!channel.urlSet ? t('settings.notify.urlMissing', channel.urlEnv)
              : channel.fails > 0 ? t('settings.notify.failing', channel.fails, reasonText(channel.reason))
              : channel.lastOkAt ? t('settings.notify.lastOk', savedAt(channel.lastOkAt)) : t('settings.notify.neverSent')}
          </span>
          <div className="set-notify-kinds" role="group" aria-label={t('settings.notify.kinds')}>
            {KINDS.map(kind => (
              <label key={kind} className="set-check">
                <input type="checkbox" checked={channel.kinds.includes(kind)} disabled={off || (channel.kinds.includes(kind) && channel.kinds.length === 1)} onChange={() => toggleKind(channel, kind)} />
                <span>{t(`notifications.kind.${kind}`)}</span>
              </label>
            ))}
          </div>
          <label className="set-check">
            <input type="checkbox" checked={channel.includeBody} disabled={off} onChange={() => patchChannel(channel, { includeBody: !channel.includeBody })} />
            <span>{t('settings.notify.includeBody')}</span>
          </label>
          <div className="set-keyrow set-notify-actions">
            <button type="button" className="btn btn-secondary" disabled={off} onClick={() => patchChannel(channel, { enabled: !channel.enabled })}>{channel.enabled ? t('settings.notify.turnOff') : t('settings.notify.turnOn')}</button>
            <button type="button" className="btn btn-secondary" disabled={off || !channel.urlSet} onClick={() => void test(channel)}>{t('settings.notify.test')}</button>
            <button type="button" className="btn btn-ghost" disabled={off} onClick={() => setEditing({ id: channel.id, field: 'url' })}>{t('settings.notify.replaceUrl')}</button>
            <button type="button" className="btn btn-ghost" disabled={off} onClick={() => setEditing({ id: channel.id, field: 'token' })}>{channel.tokenSet ? t('settings.notify.replaceToken') : t('settings.notify.addToken')}</button>
            {channel.tokenEnv !== null && <button type="button" className="btn btn-ghost" disabled={off} onClick={() => setRemoving(channel.id)}>{t('settings.notify.removeToken')}</button>}
            <button type="button" className="btn btn-ghost" disabled={off} onClick={() => setRemoving(`channel:${channel.id}`)}>{t('settings.notify.delete')}</button>
          </div>
          {tests[channel.id] && <span className="set-note" role="status">{tests[channel.id]}</span>}
          {editing?.id === channel.id && (
            <SecretField
              label={editing.field === 'url' ? t('settings.notify.urlLabel') : t('settings.notify.tokenLabel')}
              placeholder={editing.field === 'url' ? t('settings.notify.urlPlaceholder') : t('settings.notify.tokenPlaceholder')}
              saveLabel={t('settings.notify.save')} busyLabel={t('settings.key.saving')} cancelLabel={t('settings.key.cancel')} busy={busy}
              onSubmit={value => (editing.field === 'url' ? submitUrl(channel, value) : submitToken(channel, value))}
              onCancel={() => { setEditing(null); setError(null); }}
            />
          )}
          {removing === channel.id && (
            <div className="set-keyrow">
              <span className="set-note">{t('settings.notify.removeTokenAsk')}</span>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => removeToken(channel)}>{t('settings.notify.removeToken')}</button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setRemoving(null)}>{t('settings.key.cancel')}</button>
            </div>
          )}
          {removing === `channel:${channel.id}` && (
            <div className="set-keyrow">
              <span className="set-note">{t('settings.notify.deleteAsk', channel.id)}</span>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act(() => api.deleteNotifyChannel(channel.id), t('settings.notify.deleted')).then(() => setRemoving(null))}>{t('settings.notify.delete')}</button>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setRemoving(null)}>{t('settings.key.cancel')}</button>
            </div>
          )}
        </section>
      ))}

      {!adding && (
        <div className="set-keyrow set-notify-add">
          <button type="button" className="btn btn-primary" disabled={off || full} onClick={() => { setAdding(true); setError(null); }}>{t('settings.notify.add')}</button>
          {full && <span className="set-note">{t('settings.notify.full', current.limits.maxChannels)}</span>}
        </div>
      )}
      {adding && (
        <section className="set-notify-card" aria-label={t('settings.notify.add')}>
          <label className="set-notify-field">
            <span>{t('settings.notify.idLabel')}</span>
            <input className="input set-text mono" value={form.id} spellCheck={false} disabled={busy} onChange={e => setForm({ ...form, id: e.target.value })} />
          </label>
          {form.id !== '' && !ID_PATTERN.test(form.id) && <span className="set-row-error" role="alert">{t('settings.notify.idBad')}</span>}
          {current.channels.some(c => c.id === form.id) && <span className="set-row-error" role="alert">{t('settings.notify.idTaken')}</span>}
          <label className="set-notify-field">
            <span>{t('settings.notify.urlLabel')}</span>
            <input type="password" className="input set-text mono" value={form.url} placeholder={t('settings.notify.urlPlaceholder')} autoComplete="new-password" spellCheck={false} disabled={busy} onChange={e => setForm({ ...form, url: e.target.value })} />
          </label>
          {urlInvalid && <span className="set-row-error" role="alert">{t('settings.notify.urlBad')}</span>}
          <label className="set-notify-field">
            <span>{t('settings.notify.tokenLabel')}</span>
            <input type="password" className="input set-text mono" value={form.token} placeholder={t('settings.notify.tokenPlaceholder')} autoComplete="new-password" spellCheck={false} disabled={busy} onChange={e => setForm({ ...form, token: e.target.value })} />
          </label>
          <div className="set-notify-kinds" role="group" aria-label={t('settings.notify.kinds')}>
            {KINDS.map(kind => (
              <label key={kind} className="set-check">
                <input type="checkbox" checked={form.kinds.includes(kind)} disabled={busy} onChange={() => setForm({ ...form, kinds: KINDS.filter(k => (k === kind ? !form.kinds.includes(k) : form.kinds.includes(k))) })} />
                <span>{t(`notifications.kind.${kind}`)}</span>
              </label>
            ))}
          </div>
          <label className="set-check">
            <input type="checkbox" checked={form.includeBody} disabled={busy} onChange={() => setForm({ ...form, includeBody: !form.includeBody })} />
            <span>{t('settings.notify.includeBody')}</span>
          </label>
          <span className="set-row-desc">{t('settings.notify.secretNote')}</span>
          <div className="set-keyrow">
            <button type="button" className="btn btn-primary" disabled={off || !formReady} onClick={submitAdd}>{busy ? t('settings.key.saving') : t('settings.notify.addSubmit')}</button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setAdding(false); setError(null); setForm({ id: '', url: '', token: '', kinds: [...DEFAULT_KINDS], includeBody: false }); }}>{t('settings.key.cancel')}</button>
          </div>
        </section>
      )}

      <FieldRow label={t('settings.notify.publicBase')} desc={t('settings.notify.publicBaseDesc')}>
        <input className="input set-text mono" value={base} placeholder="https://clive.example.ts.net" spellCheck={false} disabled={off} aria-label={t('settings.notify.publicBase')} onChange={e => setBase(e.target.value)} />
      </FieldRow>
      {limits && LIMIT_FIELDS.map(f => (
        <FieldRow key={f.key} label={t(`settings.notify.limit.${f.key}`)} desc={t(`settings.notify.limit.${f.key}Desc`)}>
          <NumberField value={limits[f.key]} label={t(`settings.notify.limit.${f.key}`)} min={f.min} max={f.max} onChange={v => v !== undefined && setLimits({ ...limits, [f.key]: v })} />
        </FieldRow>
      ))}
      <div className="set-keyrow">
        <button type="button" className="btn btn-primary" disabled={off || !(limitsChanged || baseChanged)} onClick={saveLimits}>{t('settings.notify.saveLimits')}</button>
      </div>
    </div>
  );
}