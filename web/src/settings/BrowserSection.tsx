import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type BrowserStatusView } from '../api.ts';
import { useEscapeLayer } from '../hooks.ts';
import { useT } from '../i18n/index.ts';
import { toast } from '../toast.tsx';
import { FieldRow, NumberField, SegField, SubTitle, TagsField, TextField } from './fields.tsx';
import { updateAt, type Config } from './model.ts';
import { differs, errorFor, type SectionProps } from './types.ts';

const POLL_MS = 3000;
const CHANNELS = ['auto', 'chrome', 'path'] as const;

// 設定の「ブラウザ」: 使う/使わない・操作してよいサイト・使うブラウザ・上限（保存バーで保存）と、
// 状態の表示・ログイン用の窓・ブラウザを閉じる・ログイン情報を消す（すぐ実行。保存は要らない）
export function BrowserSection({ draft, saved, update, problems }: SectionProps) {
  const t = useT();
  const browser = ((draft.tools as Config).browser ?? {}) as Record<string, any>;
  const limits = (browser.limits ?? {}) as Record<string, number>;
  const setBrowser = (patch: Record<string, unknown>) => update(c => updateAt(c, 'tools', { browser: { ...((c.tools as Config).browser as object), ...patch } }));
  const setLimit = (key: string, value: number | undefined) => { if (value !== undefined) setBrowser({ limits: { ...limits, [key]: value } }); };
  const changed = (read: (c: Config) => unknown) => differs(saved, draft, read);
  const pending = changed(c => c.tools?.browser);

  const [status, setStatus] = useState<BrowserStatusView | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => {
      if (busyRef.current) return;
      api.browserStatus().then(next => { if (live && !busyRef.current) setStatus(next); }).catch(() => { if (live) setStatus(old => old ?? 'failed'); });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);
  useEscapeLayer('dialog', asking, () => setAsking(false));

  const act = useCallback(async (fn: () => Promise<BrowserStatusView>, done: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setAsking(false); setError('');
    try {
      setStatus(await fn());
      toast({ kind: 'done', icon: 'check', title: done });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('settings.browser.failed'));
    }
    busyRef.current = false; setBusy(false);
  }, [t]);

  const current = status !== null && status !== 'failed' ? status : null;
  const stateText = (s: BrowserStatusView): string => {
    if (!s.enabled) return t('settings.browser.state.off');
    if (s.loginOpen) return t('settings.browser.state.login');
    if (s.pausedMinutes > 0) return t('settings.browser.state.paused', s.pausedMinutes);
    if (s.running) return t('settings.browser.state.running', s.tabs);
    return t('settings.browser.state.idle');
  };
  const off = busy || pending;
  const limitRow = (key: string, label: string, unit: string, min: number, max: number) => (
    <FieldRow label={label} changed={changed(c => c.tools?.browser?.limits?.[key])} path={`tools.browser.limits.${key}`} error={errorFor(problems, `tools.browser.limits.${key}`)}>
      <NumberField value={limits[key]} label={label} unit={unit} min={min} max={max} onChange={v => setLimit(key, v)} />
    </FieldRow>
  );

  return (
    <div className="set-stack">
      <div className="set-rows">
        <p className="set-note">{t('settings.browser.intro')}</p>
        <p className="set-note">{t('settings.browser.privateNote')}</p>
        <FieldRow label={t('settings.browser.enabled')} desc={t('settings.browser.enabledDesc')} changed={changed(c => c.tools?.browser?.enabled)} path="tools.browser.enabled">
          <SegField value={browser.enabled === true} label={t('settings.browser.enabled')} options={[{ value: true, label: t('settings.tools.use') }, { value: false, label: t('settings.tools.noUse') }]} onChange={v => setBrowser({ enabled: v })} />
        </FieldRow>
        <FieldRow label={t('settings.browser.sites')} desc={t('settings.browser.sitesDesc')} changed={changed(c => c.tools?.browser?.sites)} path="tools.browser.sites" error={errorFor(problems, 'tools.browser.sites')}>
          <TagsField tags={(browser.sites ?? []) as string[]} label={t('settings.browser.sites')} placeholder="example.com" onChange={sites => setBrowser({ sites })} />
        </FieldRow>
      </div>

      <div className="set-rows">
        <SubTitle>{t('settings.browser.stateTitle')}</SubTitle>
        {current === null && <span className="set-note" role="status">{t('settings.loading')}</span>}
        {status === 'failed' && <span className="set-note" role="alert">{t('settings.browser.loadFailed')}</span>}
        {current && <span className="set-note" role="status">{stateText(current)}</span>}
        {pending && <p className="set-note" role="status">{t('settings.browser.needSave')}</p>}
        {error && <span className="set-row-error" role="alert">{error}</span>}
        <div className="set-keyrow">
          <button type="button" className="btn btn-secondary" disabled={off || current === null || !current.enabled || current.loginOpen || !current.canShowWindow} onClick={() => void act(api.browserLogin, t('settings.browser.loginOpened'))}>{t('settings.browser.login')}</button>
          <button type="button" className="btn btn-ghost" disabled={busy || current === null || !(current.running || current.loginOpen)} onClick={() => void act(api.browserClose, t('settings.browser.closed'))}>{t('settings.browser.closeAll')}</button>
          <button type="button" className="btn btn-ghost" disabled={busy || current === null} onClick={() => setAsking(true)}>{t('settings.browser.reset')}</button>
        </div>
        <span className="set-row-desc">{t('settings.browser.loginDesc')}</span>
        {current && !current.canShowWindow && <span className="set-note">{t('settings.browser.noDisplay')}</span>}
        {asking && (
          <div className="set-widen" role="alertdialog" aria-label={t('settings.browser.reset')}>
            <strong>{t('settings.browser.reset')}</strong>
            <p>{t('settings.browser.resetAsk')}</p>
            <div className="set-widen-actions">
              <button type="button" className="btn btn-ghost" autoFocus onClick={() => setAsking(false)}>{t('settings.browser.resetCancel')}</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(api.browserProfileReset, t('settings.browser.resetDone'))}>{t('settings.browser.resetOk')}</button>
            </div>
          </div>
        )}
      </div>

      <div className="set-rows">
        <FieldRow label={t('settings.browser.channel')} changed={changed(c => c.tools?.browser?.channel)} path="tools.browser.channel">
          <SegField value={(browser.channel ?? 'auto') as string} label={t('settings.browser.channel')} options={CHANNELS.map(value => ({ value, label: t(`settings.browser.channel.${value}`) }))} onChange={v => setBrowser({ channel: v })} />
        </FieldRow>
        {browser.channel === 'path' && (
          <FieldRow label={t('settings.browser.path')} desc={t('settings.browser.pathDesc')} changed={changed(c => c.tools?.browser?.executablePath)} path="tools.browser.executablePath" error={errorFor(problems, 'tools.browser.executablePath')}>
            <TextField value={String(browser.executablePath ?? '')} mono label={t('settings.browser.path')} onChange={v => setBrowser({ executablePath: v })} />
          </FieldRow>
        )}
        <FieldRow label={t('settings.browser.headless')} desc={t('settings.browser.headlessDesc')} changed={changed(c => c.tools?.browser?.headless)} path="tools.browser.headless">
          <SegField value={browser.headless !== false} label={t('settings.browser.headless')} options={[{ value: true, label: t('settings.worker.on') }, { value: false, label: t('settings.worker.off') }]} onChange={v => setBrowser({ headless: v })} />
        </FieldRow>
      </div>

      <div className="set-rows">
        <SubTitle>{t('settings.browser.limitsTitle')}</SubTitle>
        {limitRow('maxTabs', t('settings.browser.maxTabs'), t('settings.unit.items'), 1, 8)}
        {limitRow('navigationTimeoutSec', t('settings.browser.navigationTimeout'), t('settings.unit.seconds'), 5, 120)}
        {limitRow('actionTimeoutSec', t('settings.browser.actionTimeout'), t('settings.unit.seconds'), 1, 60)}
        {limitRow('idleCloseMinutes', t('settings.browser.idleClose'), t('settings.unit.minutes'), 1, 120)}
        {limitRow('pageChars', t('settings.browser.pageChars'), '', 2000, 100000)}
        {limitRow('maxMbPerMinute', t('settings.browser.maxMb'), t('settings.browser.mbUnit'), 1, 500)}
      </div>
    </div>
  );
}
