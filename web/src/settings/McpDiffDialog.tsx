import { useEffect, useRef, useState } from 'react';
import { api, type McpDiffView, type McpShapeView } from '../api.ts';
import { useEscapeLayer } from '../hooks.ts';
import { useT } from '../i18n/index.ts';
import type { McpCtx } from './mcp-ctx.ts';
import { revealHidden, sameShape, shapeChanges } from './mcp-model.ts';

function Shape({ title, shape }: { title: string; shape: McpShapeView | undefined }) {
  const t = useT();
  return (
    <div className="set-notify-field">
      <strong>{title}</strong>
      {shape ? (
        <>
          <span className="set-row-desc">{t('settings.mcp.diff.description')}</span>
          <pre className="set-mcp-pre">{revealHidden(shape.description) || '—'}</pre>
          <span className="set-row-desc">{t('settings.mcp.diff.schema')}</span>
          <pre className="set-mcp-pre">{revealHidden(shape.schema) || '—'}</pre>
          <span className="set-row-desc">{shape.destructive ? t('settings.mcp.diff.destructive') : t('settings.mcp.diff.notDestructive')}</span>
          <span className="set-row-desc">{shape.openWorld ? t('settings.mcp.diff.openWorld') : t('settings.mcp.diff.notOpenWorld')}</span>
          {shape.stripped > 0 && <span className="set-row-error" role="status">{t('settings.mcp.diff.stripped', shape.stripped)}</span>}
        </>
      ) : <span className="set-note">{t('settings.mcp.diff.none')}</span>}
    </div>
  );
}

// 説明や入力の形が変わって止まっている道具の、前と今の違い。受け入れるまで、その道具は使われない。画面の文字は、そのまま文字として出す（相手が書いた文）
export function McpDiffDialog({ server, tool, ctx, onClose }: { server: string; tool: string; ctx: McpCtx; onClose: () => void }) {
  const t = useT();
  const [diff, setDiff] = useState<McpDiffView | 'failed' | null>(null);
  const [stale, setStale] = useState(false);
  const [checking, setChecking] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  useEscapeLayer('dialog', true, onClose);
  useEffect(() => {
    let live = true;
    api.mcpToolDiff(server, tool).then(next => { if (live) setDiff(next); }).catch(() => { if (live) setDiff('failed'); });
    return () => { live = false; };
  }, [server, tool]);
  useEffect(() => { close.current?.focus(); }, []);

  // 押した時点の形を取り直し、見せた形と違えば受け入れない（見ている間に相手が書き換えても、見ていない内容は受け入れない）
  async function accept(shown: McpDiffView) {
    setChecking(true);
    try {
      const fresh = await api.mcpToolDiff(server, tool);
      if (!sameShape(fresh.after, shown.after)) { setDiff(fresh); setStale(true); return; }
    } catch { setDiff('failed'); return; } finally { setChecking(false); }
    setStale(false);
    const ok = await ctx.run(server, () => api.acceptMcpTool(server, tool), t('settings.mcp.diff.accepted'));
    if (ok) onClose();
  }
  const changes = diff !== null && diff !== 'failed' ? shapeChanges(diff) : null;

  return (
    <div className="set-widen" role="dialog" aria-label={t('settings.mcp.diff.title', tool)}>
      <strong>{t('settings.mcp.diff.title', tool)}</strong>
      <span className="set-row-desc">{t('settings.mcp.diff.intro')}</span>
      {diff === null && <span className="set-note" role="status">{t('settings.loading')}</span>}
      {diff === 'failed' && <span className="set-row-error" role="alert">{t('settings.mcp.diff.failed')}</span>}
      {stale && <span className="set-row-error" role="alert">{t('settings.mcp.diff.stale')}</span>}
      {changes && (changes.description || changes.schema || changes.destructive || changes.openWorld || changes.stripped) && (
        <span className="set-row-desc" role="status">
          {changes.description && t('settings.mcp.diff.changedDescription')} {changes.schema && t('settings.mcp.diff.changedSchema')} {changes.destructive && t('settings.mcp.diff.changedDestructive')} {changes.openWorld && t('settings.mcp.diff.changedOpenWorld')} {changes.stripped && t('settings.mcp.diff.changedStripped')}
        </span>
      )}
      {diff !== null && diff !== 'failed' && (
        <div className="set-mcp-diff">
          <Shape title={t('settings.mcp.diff.before')} shape={diff.before} />
          <Shape title={t('settings.mcp.diff.after')} shape={diff.after} />
        </div>
      )}
      <div className="set-widen-actions">
        <button ref={close} type="button" className="btn btn-ghost" onClick={onClose}>{t('settings.mcp.diff.close')}</button>
        <button type="button" className="btn btn-primary" disabled={ctx.off || checking || diff === null || diff === 'failed'} onClick={() => void accept(diff as McpDiffView)}>{t('settings.mcp.diff.accept')}</button>
      </div>
    </div>
  );
}
