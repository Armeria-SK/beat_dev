import { useState } from 'react';
import { api, type McpSecretView, type McpServerView } from '../api.ts';
import { useT } from '../i18n/index.ts';
import { toast } from '../toast.tsx';
import { accessWidening, mcpSecretAccess } from './access.ts';
import { SwitchField } from './fields.tsx';
import type { McpCtx } from './mcp-ctx.ts';
import { previewServer } from './mcp-model.ts';
import { McpToolRow } from './McpToolRow.tsx';
import { SecretField } from './SecretField.tsx';

// サーバー 1 つの詳細: 手元のモデルへの公開・秘密の値・道具の一覧・サーバーの標準エラー出力・再起動・削除
export function McpServerDetail({ server, ctx }: { server: McpServerView; ctx: McpCtx }) {
  const t = useT();
  const [editing, setEditing] = useState<McpSecretView | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const secretKey = (s: McpSecretView): string => `${s.kind}:${s.name}`;
  const submit = (secret: McpSecretView, value: string) =>
    ctx.guarded(mcpSecretAccess({ id: server.id, kind: secret.kind, name: secret.name }, ctx.saved), () =>
      void ctx.run(server.id, () => api.setMcpSecret(server.id, secret.kind, secret.name, value), t('settings.mcp.secretSaved')).then(ok => { if (ok) setEditing(null); }));
  const removeSecret = (secret: McpSecretView) =>
    void ctx.run(server.id, async () => {
      const state = await api.deleteMcpSecret(server.id, secret.kind, secret.name);
      if (state.set) toast({ kind: 'info', icon: 'info', title: t('settings.mcp.secretStillOs') });
    }).then(() => setRemoving(null));

  return (
    <div className="set-mcp-detail">
      <div className="set-row-between">
        <span>
          <strong>{t('settings.mcp.local')}</strong>
          <span className="set-row-desc">{t('settings.mcp.localDesc')}</span>
        </span>
        <SwitchField checked={server.localOk} disabled={ctx.off} label={t('settings.mcp.local')} onChange={next => ctx.guarded(accessWidening(ctx.saved, previewServer(ctx.saved, server.id, { localOk: next })), () => void ctx.run(server.id, () => api.patchMcpServer(server.id, { localOk: next })))} />
      </div>

      <strong>{t('settings.mcp.secrets')}</strong>
      {server.secrets.length === 0 && <span className="set-note">{t('settings.mcp.secretsNone')}</span>}
      {server.secrets.map(secret => (
        <div key={secretKey(secret)} className="set-mcp-secret-row">
          <span className="mono">{secret.name}</span>
          <span className="set-note">{secret.set ? (secret.source === 'os' ? t('settings.mcp.secretOs') : t('settings.mcp.secretSet')) : t('settings.mcp.secretUnset')}</span>
          <button type="button" className="btn btn-ghost" disabled={ctx.off} onClick={() => { setEditing(secret); setRemoving(null); ctx.clear(server.id); }}>{secret.set ? t('settings.mcp.secretReplace') : t('settings.mcp.secretEnter')}</button>
          {secret.set && secret.source !== 'os' && <button type="button" className="btn btn-ghost" disabled={ctx.off} onClick={() => { setRemoving(secretKey(secret)); setEditing(null); }}>{t('settings.mcp.secretRemove')}</button>}
          {editing && secretKey(editing) === secretKey(secret) && (
            <SecretField
              label={t('settings.mcp.secretLabel', secret.name)} placeholder={t('settings.mcp.secretPlaceholder')}
              saveLabel={t('settings.mcp.save')} busyLabel={t('settings.key.saving')} cancelLabel={t('settings.key.cancel')} busy={ctx.busy}
              onSubmit={value => submit(secret, value)} onCancel={() => setEditing(null)}
            />
          )}
          {removing === secretKey(secret) && (
            <div className="set-keyrow">
              <span className="set-note">{t('settings.mcp.secretRemoveAsk', secret.name)}</span>
              <button type="button" className="btn btn-secondary" disabled={ctx.busy} onClick={() => removeSecret(secret)}>{t('settings.mcp.secretRemove')}</button>
              <button type="button" className="btn btn-ghost" disabled={ctx.busy} onClick={() => setRemoving(null)}>{t('settings.key.cancel')}</button>
            </div>
          )}
        </div>
      ))}

      <strong>{t('settings.mcp.tools')}</strong>
      <span className="set-row-desc">{t('settings.mcp.toolsNote', ctx.limits.maxToolsPerServer)}</span>
      {server.tools.length === 0
        ? <span className="set-note">{server.state === 'ready' ? t('settings.mcp.toolsNone') : t('settings.mcp.toolsNotConnected')}</span>
        : <ul className="set-mcp-tools">{server.tools.map(tool => <McpToolRow key={tool.name} server={server} tool={tool} ctx={ctx} />)}</ul>}

      {server.stderr !== '' && (
        <details>
          <summary>{t('settings.mcp.stderr')}</summary>
          <pre className="set-mcp-pre">{server.stderr}</pre>
        </details>
      )}
    </div>
  );
}
