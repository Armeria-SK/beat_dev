import { useEffect, useRef, useState } from 'react';
import { BLOCKING_ISSUES } from '../../../../src/runtimes/types.ts';
import { api, ApiError, type ModelView, type RuntimeIssue, type RuntimeView } from '../../api.ts';
import { formatRelative, useT } from '../../i18n/index.ts';
import { addRuntimeModel, updateRuntime } from '../../settings/model.ts';
import { Button, Pill, type PillTone } from '../parts.tsx';
import { Group, Row, Select, Switch, useSet, type Option } from './controls.tsx';

type T = ReturnType<typeof useT>;

const errorText = (error: unknown, fallback: string): string => (error instanceof ApiError ? error.message : fallback);

// Claude Code・Codex（外の実行役）の行。確かめは「Check」を押したときだけ（設定を保存するたびには起こさない）。ログインは公式の手順の案内だけで、beat はログインもログイン情報も扱わない
export const NAME = { 'claude-code': 'ui.set.runtime.claude-code', codex: 'ui.set.runtime.codex' } as const;

const PILL = {
  off: 'ui.set.runtime.pillOff', unchecked: 'ui.set.runtime.pillUnchecked', ready: 'ui.set.runtime.pillReady', missing: 'ui.set.runtime.pillMissing',
  signedOut: 'ui.set.runtime.pillSignedOut', blocked: 'ui.set.runtime.pillBlocked',
} as const;
export type RuntimePill = keyof typeof PILL;

const PILL_TONE: Record<RuntimePill, PillTone | undefined> = { off: undefined, unchecked: 'warn', ready: 'ok', missing: 'danger', signedOut: 'danger', blocked: 'warn' };

export function pillOf(view: Pick<RuntimeView, 'enabled' | 'check'>): RuntimePill {
  if (!view.enabled) return 'off';
  const check = view.check;
  if (!check) return 'unchecked';
  if (!check.installed) return 'missing';
  if (check.auth === 'login_required') return 'signedOut';
  return check.usable ? 'ready' : 'blocked';
}

// モデルの行の札（実行役のモデルの状態は、その実行役の確かめの結果）。provider.probe.runtime_* の鍵から決める
const MODEL_PILL: Record<string, RuntimePill> = {
  'provider.probe.runtime_ok': 'ready', 'provider.probe.runtime_off': 'off', 'provider.probe.runtime_unchecked': 'unchecked', 'provider.probe.runtime_missing': 'missing',
  'provider.probe.runtime_login': 'signedOut', 'provider.probe.runtime_blocked': 'blocked', 'provider.probe.runtime_unknown': 'blocked', 'provider.probe.no_runtime': 'blocked',
};

export function RuntimeModelPill({ probe }: { probe: ModelView['probe'] }) {
  const t = useT();
  const pill = probe?.messageCode ? MODEL_PILL[probe.messageCode] ?? 'blocked' : 'unchecked';
  const tone = PILL_TONE[pill];
  return <Pill {...(tone ? { tone } : {})}>{t(PILL[pill])}</Pill>;
}

function authLine(t: T, check: NonNullable<RuntimeView['check']>): string {
  if (check.auth === 'login_required') return t('ui.set.runtime.authOutDesc');
  if (check.login === 'subscription' && check.auth === 'ok') return t('ui.set.runtime.authSubscriptionDesc');
  if (check.login === 'other') return t('ui.set.runtime.authOtherDesc');
  return check.auth === 'ok' ? t('ui.set.runtime.authOkDesc') : t('ui.set.runtime.authUnknownDesc');
}

function whyBlocked(view: Pick<RuntimeView, 'enabled' | 'check'>): RuntimeIssue | undefined {
  return pillOf(view) === 'blocked' ? view.check?.issues.find(issue => BLOCKING_ISSUES.has(issue.code)) : undefined;
}

const sameIssue = (a: RuntimeIssue, b: RuntimeIssue | undefined): boolean => b !== undefined && a.code === b.code && (a.detail ?? '') === (b.detail ?? '');

// 状態の説明の 1 行: 入っているか・版（確かめた版か）・どの認証か・いつ確かめたか。札が Not ready なら、終わりにその理由
export function stateLine(t: T, view: Pick<RuntimeView, 'enabled' | 'check'>): string {
  if (!view.enabled) return t('ui.set.runtime.offDesc');
  const check = view.check;
  if (!check) return t('ui.set.runtime.uncheckedDesc');
  if (!check.installed) return t('ui.set.runtime.missingDesc');
  const version = check.version === null ? t('ui.set.runtime.versionUnknownDesc') : check.verified ? t('ui.set.runtime.versionOkDesc', check.version) : t('ui.set.runtime.versionNewDesc', check.version);
  const why = whyBlocked(view);
  return [version, authLine(t, check), t('ui.set.key.checked', formatRelative(check.checkedAt)), ...(why ? [issueLine(t, why)] : [])].join(' · ');
}

export function issueLine(t: T, issue: RuntimeIssue): string {
  const detail = issue.detail ?? '';
  switch (issue.code) {
    case 'too_old': return t('ui.set.runtime.issueTooOldDesc', detail);
    case 'sandbox_not_ready': return t('ui.set.runtime.issueSandboxDesc', detail);
    case 'world_writable': return t('ui.set.runtime.issueWritableDesc', detail);
    case 'writable_scan_failed': return t('ui.set.runtime.issueScanFailedDesc');
    case 'tools_unreviewed': return t('ui.set.runtime.issueToolsDesc', detail);
  }
}

export const PERM_LABEL: Record<string, 'ui.set.runtime.permLabel.default' | 'ui.set.runtime.permLabel.acceptEdits' | 'ui.set.runtime.permLabel.read-only' | 'ui.set.runtime.permLabel.workspace-write'> = {
  default: 'ui.set.runtime.permLabel.default', acceptEdits: 'ui.set.runtime.permLabel.acceptEdits', 'read-only': 'ui.set.runtime.permLabel.read-only', 'workspace-write': 'ui.set.runtime.permLabel.workspace-write',
};

const PERM_DESC: Record<string, 'ui.set.runtime.permDefaultDesc' | 'ui.set.runtime.permAcceptEditsDesc' | 'ui.set.runtime.permReadOnlyDesc' | 'ui.set.runtime.permWorkspaceWriteDesc'> = {
  default: 'ui.set.runtime.permDefaultDesc', acceptEdits: 'ui.set.runtime.permAcceptEditsDesc', 'read-only': 'ui.set.runtime.permReadOnlyDesc', 'workspace-write': 'ui.set.runtime.permWorkspaceWriteDesc',
};

function RuntimeRow({ view, onView }: { view: RuntimeView; onView: (view: RuntimeView) => void }) {
  const t = useT();
  const ctx = useSet();
  const k = `runtime:${view.id}`;
  const [acting, setActing] = useState<'check' | 'models' | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [open, setOpen] = useState(false);
  const busy = ctx.busy !== null || acting !== null;
  const name = t(NAME[view.kind]);
  const check = view.check;
  const pill = pillOf(view);
  const tone = PILL_TONE[pill];

  async function act(kind: 'check' | 'models') {
    setActing(kind); ctx.clear(k); if (kind === 'models') setLoadFailed(null);
    try {
      const next = await (kind === 'check' ? api.checkRuntime(view.id) : api.loadRuntimeModels(view.id));
      onView(next);
      await ctx.reload();
    } catch (error) {
      const message = errorText(error, t('ui.set.runtime.checkFailedDesc'));
      if (kind === 'models') setLoadFailed(message); else ctx.fail(k, message);
    } finally { setActing(null); }
  }

  async function toggle(enabled: boolean) {
    const saved = await ctx.commit(k, c => updateRuntime(c, view, { enabled }));
    if (saved && enabled) { setOpen(true); await act('check'); }
  }

  const taken = new Set((ctx.config.models as Array<{ runtime?: string; model: string }>).filter(m => m.runtime === view.id).map(m => m.model));
  const available: Option<string>[] = (view.models ?? []).filter(m => !taken.has(m.id)).map(m => ({ value: m.id, label: m.label === m.id ? m.id : `${m.label} (${m.id})` }));
  const addModel = (entry: { id: string; label: string; efforts: readonly string[] }) => void ctx.commit('runtime:add', c => addRuntimeModel(c, view.id, entry).config).then(ok => { if (ok) setTyped(''); });
  const why = whyBlocked(view);
  const lines = [...(check?.issues ?? []).filter(issue => issue !== why), ...(check?.stop && !sameIssue(check.stop, why) ? [check.stop] : [])];
  const permission = view.permissions.includes(view.permission) ? view.permission : null;

  return (
    <>
      <Row k={k} title={name} desc={stateLine(t, view)}
        below={lines.length > 0 && <>{lines.map((issue, i) => <p key={`${issue.code}:${i}`} className="bt-meta" data-issue={issue.code}>{issueLine(t, issue)}</p>)}</>}>
        <Pill {...(tone ? { tone } : {})}>{t(PILL[pill])}</Pill>
        {view.enabled && <Button small disabled={busy} onClick={() => void act('check')}>{acting === 'check' ? t('ui.set.runtime.checking') : t('ui.set.runtime.check')}</Button>}
        <Switch checked={view.enabled} label={t('ui.set.runtime.enable')} disabled={busy} onChange={enabled => void toggle(enabled)} />
        {view.enabled && <Button small variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('ui.set.less') : t('ui.set.edit')}</Button>}
      </Row>
      {view.enabled && open && (
        <div className="ui-set__detail">
          <Row k={`${k}:permission`} title={t('ui.set.runtime.permission')}
            desc={<>{PERM_DESC[view.permission] ? t(PERM_DESC[view.permission]!) : ''} {t('ui.set.runtime.permNoteDesc', name)}</>}>
            <Select value={permission} options={view.permissions.map(value => ({ value, label: PERM_LABEL[value] ? t(PERM_LABEL[value]!) : value }))} label={t('ui.set.runtime.permission')} disabled={busy}
              onChange={value => void ctx.commit(`${k}:permission`, c => updateRuntime(c, view, { permission: value }))} />
          </Row>
          {view.kind === 'codex' && check?.installed && check.verified === false && <p className="bt-meta" data-runtime-readonly={view.kind}>{t('ui.set.runtime.readOnlyUnverifiedDesc')}</p>}
          {view.kind === 'claude-code' && <p className="bt-meta" data-runtime-note={view.kind}>{t('ui.set.runtime.claudeNoteDesc')}</p>}
          <Row k={`${k}:models`} title={t('ui.set.runtime.models')} desc={view.models !== null && view.models.length === 0 ? t('ui.set.runtime.noModelsDesc') : t('ui.set.runtime.modelsDesc')}
            below={loadFailed !== null && (
              <>
                <p className="bt-meta" role="status">{t('ui.set.runtime.loadFailedDesc', loadFailed)}</p>
                <div className="ui-set__form">
                  <input className="bt-field bt-field--mono" aria-label={t('ui.set.model.name')} placeholder={t('ui.set.model.namePh')} value={typed} spellCheck={false} onChange={e => setTyped(e.target.value)} />
                  <Button small variant="primary" disabled={busy || !typed.trim()} onClick={() => addModel({ id: typed.trim(), label: typed.trim(), efforts: [] })}>{t('ui.set.add')}</Button>
                </div>
              </>
            )}>
            {available.length > 0 && <Select value={null} options={available} label={t('ui.set.runtime.addModel')} placeholder={t('ui.set.runtime.addModel')} disabled={busy}
              onChange={id => { const entry = view.models?.find(m => m.id === id); if (entry) addModel(entry); }} />}
            <Button small disabled={busy} onClick={() => void act('models')}>{acting === 'models' ? t('ui.set.runtime.loading') : t('ui.set.runtime.load')}</Button>
          </Row>
          <Row k={`${k}:signin`} title={t('ui.set.runtime.signIn')} desc={t(view.kind === 'claude-code' ? 'ui.set.runtime.signInClaudeDesc' : 'ui.set.runtime.signInCodexDesc')} />
        </div>
      )}
    </>
  );
}

export function RuntimesGroup() {
  const t = useT();
  const ctx = useSet();
  const [views, setViews] = useState<RuntimeView[] | null>(null);
  const live = useRef(true);
  // 設定の runtimes が変わったら（入れる・切る・許可の設定）、サーバーの見え方を読み直す
  const stamp = JSON.stringify(ctx.config.runtimes ?? []);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { api.runtimes().then(r => { if (live.current) setViews(r.runtimes); }).catch(() => { if (live.current) setViews([]); }); }, [stamp]);
  const replace = (next: RuntimeView) => setViews(list => (list ?? []).map(view => (view.id === next.id ? next : view)));
  return (
    <Group title={t('ui.set.runtimes.title')}>
      {(views ?? []).map(view => <RuntimeRow key={view.id} view={view} onView={replace} />)}
    </Group>
  );
}
