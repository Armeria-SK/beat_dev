import { useState, type ReactNode } from 'react';
import { ApiError, type Approval } from '../api.ts';
import { decideApproval, useDecisionPending, type ApprovalDecision } from '../approval-decide.ts';
import { approvalPathKey, approvalPathsMore } from '../chat-logic.ts';
import { useT } from '../i18n/index.ts';
import { useNow } from './hooks.ts';
import { Button, Icon, Pill } from './parts.tsx';
import { routeHash } from './routes.ts';
import type { ToolItem } from './thread.ts';
import { elapsedClock, folderLabel, toolRow, type ToolMeta, type ToolRowView } from './tool-row.ts';

type T = ReturnType<typeof useT>;

function verbText(t: T, view: ToolRowView): string {
  switch (view.verb) {
    case 'edit': return t('ui.tool.edit');
    case 'run': return t('ui.tool.run');
    case 'search': return t('ui.tool.search');
    case 'helper': return t('ui.tool.helper');
    default: return view.name;
  }
}

function metaNode(t: T, meta: ToolMeta): ReactNode {
  if (!meta) return null;
  switch (meta.kind) {
    case 'lines': return <><span className="bt-add">+{meta.added}</span><span className="bt-del">−{meta.removed}</span></>;
    case 'exit': return t('ui.tool.exit', meta.code, meta.seconds);
    case 'failed': return t('ui.tool.failed');
    case 'returned': return t('ui.tool.returned');
  }
}

function Lead({ view, working }: { view: ToolRowView; working: boolean }) {
  const t = useT();
  if (view.verb === 'helper' && working) {
    return (
      <span className="bt-avatar bt-avatar--sm bt-avatar--working ui-tool__avatar" role="img" aria-label={t('ui.avatar.working')}>
        <span className="bt-avatar__ring" /><span className="bt-avatar__orbit" /><span className="bt-avatar__body" />
      </span>
    );
  }
  return <Icon name={view.icon} />;
}

function Row({ view, running, meta, children }: { view: ToolRowView; running: boolean; meta: ReactNode; children?: ReactNode }) {
  const t = useT();
  return (
    <>
      <summary className={`bt-tool__row${running ? ' bt-sheen' : ''}`}>
        <Lead view={view} working={running} />
        <span className={`bt-tool__verb${view.verb === 'tool' ? ' ui-tool__verb--name' : ''}`}>{verbText(t, view)}</span>
        <span className="bt-tool__target">{view.target}</span>
        <span className="bt-tool__meta">{meta}</span>
        <Icon name="chevR" className="bt-tool__chev" />
      </summary>
      {children}
    </>
  );
}

function ToolLine({ item }: { item: ToolItem }) {
  const t = useT();
  const view = toolRow(item.name, item.input, item.result);
  const running = item.running;
  const now = useNow(1000, running?.startedAt != null);
  let meta: ReactNode;
  if (running) {
    if (running.checking) meta = t('ui.tool.checking');
    else if (running.helperTools !== null) meta = t('ui.tool.helperTools', running.helperTools);
    else meta = running.startedAt !== null ? t('ui.tool.running', elapsedClock(now - running.startedAt)) : t('ui.tool.runningPlain');
  } else meta = metaNode(t, view.meta);
  const helperLink = running?.helperConversation ? <a className="bt-tool__link" href={routeHash({ view: 'chat', id: running.helperConversation })}>{t('ui.tool.openHelper')}</a> : null;
  return (
    <details className={`bt-tool${running ? ' bt-tool--running' : ''}`} open={running && view.verb === 'helper' ? true : undefined}>
      <Row view={view} running={Boolean(running)} meta={meta}>
        <div className="bt-tool__body">
          {item.result ? <pre className="ui-tool__out">{item.result.text || t('ui.tool.noOutput')}</pre> : <span className="ui-tool__out">{view.target || view.name}</span>}
          {helperLink}
        </div>
      </Row>
    </details>
  );
}

function ApprovalLine({ approval }: { approval: Approval }) {
  const t = useT();
  const view = toolRow(approval.tool, '', null);
  const now = useNow(1000);
  const busy = useDecisionPending(approval.id);
  const [error, setError] = useState('');
  async function decide(decision: ApprovalDecision): Promise<void> {
    setError('');
    try { await decideApproval(approval.id, decision); } catch (e) { setError(e instanceof ApiError ? e.message : t('ui.approval.failed')); }
  }
  const more = approvalPathsMore(approval);
  const meta = <><Pill tone="waiting">{t('ui.approval.waiting')}</Pill>{t('ui.approval.left', elapsedClock(approval.expiresAt - now))}</>;
  return (
    <details className="bt-tool ui-approval" open>
      <Row view={{ ...view, target: approval.title }} running={false} meta={meta}>
        <div className="bt-tool__body ui-approval__body">
          {approval.body && <pre className="ui-tool__out">{approval.body}</pre>}
          {approval.fromAgent && <p className="bt-meta">{t('ui.approval.fromHelper', approval.fromAgent.title)}</p>}
          {approval.onceOnly && <p className="bt-meta">{t('ui.approval.checkCode')}</p>}
          {approval.preview.map(file => (
            <div key={file.path} className="ui-approval__file">
              <span className="bt-meta">{t('ui.approval.preview')} · <code>{file.path}</code></span>
              <pre className="ui-tool__out">{file.text}</pre>
            </div>
          ))}
          <dl className="ui-approval__facts">
            {approval.cwd && <><dt>{t('ui.approval.cwd')}</dt><dd><code>{approval.cwd}</code></dd></>}
            {approval.reasons.length > 0 && <><dt>{t('ui.approval.reasons')}</dt><dd>{approval.reasons.join(' · ')}</dd></>}
            {(approval.paths.length > 0 || approval.details.length > 0) && (
              <>
                <dt>{t('ui.approval.paths')}</dt>
                <dd>
                  {approval.paths.length > 0
                    ? approval.paths.map((p, i) => <span key={`${i}:${p.path ?? p.input}`} className="ui-approval__path"><code>{p.path ?? p.input}</code> · {t(approvalPathKey(p))}</span>)
                    : approval.details.map(d => <span key={d} className="ui-approval__path"><code>{d}</code></span>)}
                  {more > 0 && <span className="ui-approval__path">{t('approval.pathsMore', more)}</span>}
                </dd>
              </>
            )}
          </dl>
          {error && <p className="bt-meta ui-danger" role="alert">{error}</p>}
          <div className="ui-approval__actions">
            <Button variant="ghost" small disabled={busy} onClick={() => void decide('deny')}>{t('ui.approval.deny')}</Button>
            {!approval.onceOnly && !approval.everyTime && !approval.fromAgent && <Button small disabled={busy} onClick={() => void decide('conversation')}>{t('ui.approval.session')}</Button>}
            {approval.grantFolder && <Button small disabled={busy} title={approval.grantFolder} onClick={() => void decide('folder')}>{t('ui.approval.folder', folderLabel(approval.grantFolder))}</Button>}
            <Button variant="primary" small disabled={busy} onClick={() => void decide('once')}>{t('ui.approval.once')}</Button>
          </div>
        </div>
      </Row>
    </details>
  );
}

export function ToolGroup({ rows, rise }: { rows: ToolItem[]; rise: boolean }) {
  return (
    <div className={`bt-tools${rise ? ' bt-rise' : ''}`}>
      {rows.map(item => (item.approval ? <ApprovalLine key={item.key} approval={item.approval} /> : <ToolLine key={item.key} item={item} />))}
    </div>
  );
}
