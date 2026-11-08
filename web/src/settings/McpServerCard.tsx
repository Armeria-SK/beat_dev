import { useState } from 'react';
import { api, type McpServerView } from '../api.ts';
import { useT } from '../i18n/index.ts';
import { accessWidening } from './access.ts';
import { SwitchField } from './fields.tsx';
import type { McpCtx } from './mcp-ctx.ts';
import { previewServer, reasonKey, summarize, tone } from './mcp-model.ts';
import { McpServerDetail } from './McpServerDetail.tsx';

const TONE_TAG = { ok: 'tag-accent-2', busy: 'tag-neutral', bad: 'tag-accent', off: 'tag-neutral' } as const;

// サーバー 1 つのカード: 名前・状態・使う/使わないのスイッチ・要約。詳細は開いたときだけ描く
export function McpServerCard({ server, ctx, error }: { server: McpServerView; ctx: McpCtx; error: string | undefined }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const sum = summarize(server);
  const kind = tone(server.state);

  return (
    <section className="set-mcp-card" aria-label={server.id}>
      <div className="set-mcp-head">
        <strong className="mono">{server.id}</strong>
        <span className="tag tag-neutral">{server.transport === 'http' ? 'HTTP' : 'stdio'}</span>
        <span className={`tag ${TONE_TAG[kind]}`} role="status">{t(`settings.mcp.state.${server.state}`)}</span>
        <SwitchField checked={server.enabled} disabled={ctx.off} label={t('settings.mcp.serverSwitch', server.id)} onChange={next => ctx.guarded(accessWidening(ctx.saved, previewServer(ctx.saved, server.id, { enabled: next })), () => void ctx.run(server.id, () => api.patchMcpServer(server.id, { enabled: next })))} />
      </div>
      <span className="set-mcp-target">{server.target}</span>
      {server.state === 'failed' && (
        <span className="set-row-desc" role="alert">
          {t(reasonKey(server.reason))}
          {server.detail ? ` — ${server.detail}` : ''}
        </span>
      )}
      <span className="set-row-desc">{t('settings.mcp.summary', sum.registered, server.tools.length)}</span>
      {sum.changed > 0 && <span className="set-row-error" role="alert">{t('settings.mcp.changedCount', sum.changed)}</span>}
      {sum.cut > 0 && <span className="set-row-desc">{t('settings.mcp.cutCount', sum.cut, ctx.limits.maxToolsPerServer)}</span>}
      {error && <span className="set-row-error" role="alert">{error}</span>}
      <div className="set-keyrow set-notify-actions">
        <button type="button" className="btn btn-secondary" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('settings.mcp.close') : t('settings.mcp.open')}</button>
        <button type="button" className="btn btn-ghost" disabled={ctx.off || !server.enabled} onClick={() => void ctx.run(server.id, () => api.restartMcpServer(server.id), t('settings.mcp.restarted'))}>{t('settings.mcp.restart')}</button>
        <button type="button" className="btn btn-ghost" disabled={ctx.off} onClick={() => setRemoving(true)}>{t('settings.mcp.delete')}</button>
      </div>
      {removing && (
        <div className="set-keyrow">
          <span className="set-note">{t('settings.mcp.deleteAsk', server.id)}</span>
          <button type="button" className="btn btn-secondary" disabled={ctx.off} onClick={() => void ctx.run(server.id, () => api.deleteMcpServer(server.id), t('settings.mcp.deleted')).then(() => setRemoving(false))}>{t('settings.mcp.delete')}</button>
          <button type="button" className="btn btn-ghost" disabled={ctx.busy} onClick={() => setRemoving(false)}>{t('settings.key.cancel')}</button>
        </div>
      )}
      {open && <McpServerDetail server={server} ctx={ctx} />}
    </section>
  );
}
