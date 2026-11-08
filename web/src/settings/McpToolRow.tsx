import { useState } from 'react';
import { api, type McpEffect, type McpServerView, type McpToolView } from '../api.ts';
import { useT } from '../i18n/index.ts';
import { accessWidening } from './access.ts';
import { SwitchField } from './fields.tsx';
import type { McpCtx } from './mcp-ctx.ts';
import { previewTool, type ToolPatch } from './mcp-model.ts';
import { McpDiffDialog } from './McpDiffDialog.tsx';

const EFFECTS: readonly McpEffect[] = ['read', 'write', 'network'];
const tri = (value: boolean | undefined): string => (value === undefined ? '' : String(value));
const fromTri = (value: string): boolean | null => (value === '' ? null : value === 'true');

// 道具 1 つの行: 使う/使わないのスイッチ・状態・説明・申告（読むだけか・送るか・消すか）。許可/確認/禁止の方針は、スキル・ツールの画面で変える
export function McpToolRow({ server, tool, ctx }: { server: McpServerView; tool: McpToolView; ctx: McpCtx }) {
  const t = useT();
  const [more, setMore] = useState(false);
  const [declaring, setDeclaring] = useState(false);
  const [diffing, setDiffing] = useState(false);

  const configured = (ctx.saved.mcp?.servers as Array<Record<string, any>> | undefined)?.find(s => s.id === server.id)?.tools?.[tool.name] as { effect?: McpEffect; sends?: boolean; removes?: boolean } | undefined;
  const enabled = tool.state !== 'off' && tool.state !== 'unlisted';
  const patch = (change: ToolPatch) =>
    ctx.guarded(accessWidening(ctx.saved, previewTool(ctx.saved, server.id, tool.name, change)), () => void ctx.run(server.id, () => api.patchMcpTool(server.id, tool.name, change)));

  const reason = (): string | null => {
    if (!tool.reason) return null;
    if (tool.reason === 'not_found') return t('settings.mcp.toolReason.not_found');
    if (tool.reason === 'duplicate_name') return t('settings.mcp.toolReason.duplicate_name');
    return t('settings.mcp.toolReason.detail', tool.reason.slice(0, 160));
  };
  const why = reason();
  const long = tool.description.length > 140 || tool.description.includes('\n');

  return (
    <li className="set-mcp-tool">
      <div className="set-mcp-tool-head">
        <strong className="mono">{tool.name}</strong>
        <span className={`tag ${tool.state === 'registered' ? 'tag-accent-2' : tool.state === 'changed' || tool.state === 'schema_invalid' ? 'tag-accent' : 'tag-neutral'}`}>{t(`settings.mcp.toolState.${tool.state}`)}</span>
        <SwitchField checked={enabled} disabled={ctx.off} label={t('settings.mcp.toolSwitch', tool.name)} onChange={next => patch({ enabled: next })} />
      </div>
      {tool.description !== '' && (
        <>
          <span className={`set-mcp-desc${more ? ' is-open' : ''}`}>{tool.description}</span>
          {long && <button type="button" className="btn btn-ghost" onClick={() => setMore(!more)}>{more ? t('settings.mcp.less') : t('settings.mcp.more')}</button>}
        </>
      )}
      {why && <span className="set-row-desc">{why}</span>}
      {tool.state === 'changed' && (
        <div className="set-keyrow set-notify-actions">
          <span className="set-note">{t('settings.mcp.changedNote')}</span>
          <button type="button" className="btn btn-secondary" disabled={ctx.off} onClick={() => setDiffing(true)}>{t('settings.mcp.diff.open')}</button>
        </div>
      )}
      {diffing && <McpDiffDialog server={server.id} tool={tool.name} ctx={ctx} onClose={() => setDiffing(false)} />}
      {tool.state !== 'unlisted' && tool.state !== 'missing' && (
        <>
          <button type="button" className="btn btn-ghost" aria-expanded={declaring} onClick={() => setDeclaring(!declaring)}>{t('settings.mcp.declare')}</button>
          {declaring && (
            <>
              <div className="set-mcp-decl">
                <label>
                  <span>{t('settings.mcp.declare.effect')}</span>
                  <select className="input" value={configured?.effect ?? ''} disabled={ctx.off} onChange={e => patch({ effect: e.target.value === '' ? null : (e.target.value as McpEffect) })}>
                    <option value="">{t('settings.mcp.declare.unset')}</option>
                    {EFFECTS.map(effect => <option key={effect} value={effect}>{t(`settings.mcp.declare.effect.${effect}`)}</option>)}
                  </select>
                </label>
                <label>
                  <span>{t('settings.mcp.declare.sends')}</span>
                  <select className="input" value={tri(configured?.sends)} disabled={ctx.off} onChange={e => patch({ sends: fromTri(e.target.value) })}>
                    <option value="">{t('settings.mcp.declare.unset')}</option>
                    <option value="true">{t('settings.mcp.declare.yes')}</option>
                    <option value="false">{t('settings.mcp.declare.no')}</option>
                  </select>
                </label>
                <label>
                  <span>{t('settings.mcp.declare.removes')}</span>
                  <select className="input" value={tri(configured?.removes)} disabled={ctx.off} onChange={e => patch({ removes: fromTri(e.target.value) })}>
                    <option value="">{t('settings.mcp.declare.unset')}</option>
                    <option value="true">{t('settings.mcp.declare.yes')}</option>
                    <option value="false">{t('settings.mcp.declare.no')}</option>
                  </select>
                </label>
              </div>
              <span className="set-row-desc">{t('settings.mcp.declare.note')}</span>
            </>
          )}
        </>
      )}
    </li>
  );
}
