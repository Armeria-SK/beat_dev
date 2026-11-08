import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, type McpView } from '../api.ts';
import { useEscapeLayer } from '../hooks.ts';
import { useT } from '../i18n/index.ts';
import { toast } from '../toast.tsx';
import { AccessConfirm } from './AccessConfirm.tsx';
import type { Access } from './access.ts';
import type { McpCtx } from './mcp-ctx.ts';
import { attempt } from './mcp-model.ts';
import { McpAddForm } from './McpAddForm.tsx';
import { McpServerCard } from './McpServerCard.tsx';
import { countChanges } from './model.ts';
import type { SectionProps } from './types.ts';

const POLL_MS = 3000;
const isView = (value: unknown): value is McpView => typeof value === 'object' && value !== null && Array.isArray((value as McpView).servers);

// 設定の「MCP サーバー」: 外の MCP サーバーの登録・使う/使わない・道具ごとの切り替え。状態は 3 秒おきに読み直す
export function McpSection({ saved, draft, onChanged }: SectionProps & { onChanged: () => void }) {
  const t = useT();
  const [view, setView] = useState<McpView | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const seq = useRef(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ items: Access[]; run: () => void } | null>(null);
  const [adding, setAdding] = useState(false);

  // 保存していない編集が他の節にあるときは、ここでの操作は止める（反映すると設定が読み込み直されるため）
  const ready = countChanges(saved, draft) === 0;

  useEffect(() => {
    let live = true;
    const load = () => {
      // 操作の最中は、古い読み込みで答えを上書きしない
      if (busyRef.current) return;
      const mine = ++seq.current;
      // 操作の完了より前に出した要求の答えは、新しい view を上書きしないよう捨てる
      api.mcp().then(next => { if (live && !busyRef.current && mine === seq.current) setView(next); }).catch(() => { if (live) setView(old => old ?? 'failed'); });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);
  useEscapeLayer('dialog', confirm !== null, () => setConfirm(null));

  const clear = useCallback((key: string) => setErrors(old => (old[key] ? { ...old, [key]: '' } : old)), []);
  const run = useCallback(async (key: string, fn: () => Promise<unknown>, done?: string): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true; seq.current++; setBusy(true); setConfirm(null); clear(key);
    const ok = await attempt(async () => {
      const next = await fn();
      // 秘密の操作などは view を返さないので、読み直す
      setView(isView(next) ? next : await api.mcp());
    }, {
      describe: failure => (failure instanceof ApiError ? failure.message : t('settings.mcp.failed')),
      onError: message => setErrors(old => ({ ...old, [key]: message })),
      notify: message => toast({ kind: 'info', icon: 'info', title: message }),
    });
    busyRef.current = false; seq.current++; setBusy(false);
    if (ok) {
      if (done) toast({ kind: 'done', icon: 'check', title: done });
      onChanged();
    }
    return ok;
  }, [clear, onChanged, t]);
  const guarded = useCallback((items: Access[], go: () => void) => { if (items.length > 0) setConfirm({ items, run: go }); else go(); }, []);

  const current = view !== null && view !== 'failed' ? view : null;
  const ctx = useMemo<McpCtx | null>(() => (current ? { saved, limits: current.limits, off: busy || !ready, busy, guarded, run, clear } : null), [saved, current, busy, ready, guarded, run, clear]);

  if (view === null) return <span className="set-note" role="status">{t('settings.loading')}</span>;
  if (view === 'failed' || !current || !ctx) return <span className="set-note" role="alert">{t('settings.mcp.loadFailed')}</span>;
  const full = current.servers.length >= current.limits.maxServers;

  return (
    <div className="set-rows set-mcp">
      <p className="set-note">{t('settings.mcp.intro')}</p>
      {!ready && <p className="set-note" role="status">{t('settings.mcp.needSave')}</p>}
      {errors[''] && !adding && <span className="set-row-error" role="alert">{errors['']}</span>}
      {confirm && <AccessConfirm items={confirm.items} busy={busy} onCancel={() => setConfirm(null)} onConfirm={confirm.run} />}

      {current.servers.length === 0 && <p className="set-note">{t('settings.mcp.none')}</p>}
      {current.servers.map(server => <McpServerCard key={server.id} server={server} ctx={ctx} error={errors[server.id] || undefined} />)}

      {!adding && (
        <div className="set-keyrow set-notify-add">
          <button type="button" className="btn btn-primary" disabled={ctx.off || full} onClick={() => { setAdding(true); clear(''); }}>{t('settings.mcp.add')}</button>
          {full && <span className="set-note">{t('settings.mcp.full', current.limits.maxServers)}</span>}
        </div>
      )}
      {adding && <McpAddForm ctx={ctx} taken={current.servers.map(s => s.id)} onClose={() => { setAdding(false); setConfirm(null); clear(''); }} />}
      {adding && errors[''] && <span className="set-row-error" role="alert">{errors['']}</span>}
    </div>
  );
}
