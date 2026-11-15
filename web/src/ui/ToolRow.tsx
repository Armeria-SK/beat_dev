import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { useT } from '../i18n/index.ts';
import { useNow } from './hooks.ts';
import { Icon, Pill } from './parts.tsx';
import { routeHash, type Route } from './routes.ts';
import type { ToolItem } from './thread.ts';
import { elapsedClock, emptyOutput, staggerOf, toolLabel, toolRow, type ToolMeta, type ToolRowView } from './tool-row.ts';

type T = ReturnType<typeof useT>;

const enterClass = (enter: number | null): string => (enter === null ? '' : ' bt-rise');
const enterStyle = (enter: number | null): CSSProperties | undefined => (enter === null ? undefined : { '--bt-i': enter } as CSSProperties);

function verbText(t: T, view: ToolRowView): string {
  switch (view.verb) {
    case 'edit': return t('ui.tool.edit');
    case 'run': return t('ui.tool.run');
    case 'search': return t('ui.tool.search');
    case 'helper': return t('ui.tool.helper');
    default: return toolLabel(view.name);
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

export interface PendingLink { route: Route; open: (id: number) => void }

function gateMeta(t: T, item: ToolItem, pending: PendingLink | undefined): ReactNode {
  const gate = item.gate;
  if (!gate) return null;
  if (gate.by === 'judge') return <span className="ui-tool__why" title={gate.reason}>{gate.same !== undefined ? t('ui.tool.judgeSame') : t('ui.tool.judgeReason', gate.reason)}</span>;
  if (gate.by === 'not-parked') return <Pill tone="danger">{t('ui.tool.notRun')}</Pill>;
  if (gate.by === 'no-judge') return <span className="ui-tool__why">{t('ui.tool.noJudge')}</span>;
  const open = pending ? (e: MouseEvent<HTMLAnchorElement>) => { e.preventDefault(); pending.open(gate.id); } : undefined;
  return <><Pill tone="warn">{t('ui.tool.parked')}</Pill><a className="bt-tool__link ui-tool__open" href={routeHash(pending?.route ?? { view: 'pending' })} onClick={open}>{t('ui.tool.openPending', gate.id)}</a></>;
}

function ToolLine({ item, enter, pending }: { item: ToolItem; enter: number | null; pending: PendingLink | undefined }) {
  const t = useT();
  const view = toolRow(item.name, item.input, item.result);
  const running = item.running;
  const now = useNow(1000, running?.startedAt != null);
  let meta: ReactNode;
  if (running) {
    if (running.checking) meta = t('ui.tool.checking');
    else if (running.helperTools !== null) meta = t('ui.tool.helperTools', running.helperTools);
    else meta = running.startedAt !== null ? t('ui.tool.running', elapsedClock(now - running.startedAt)) : t('ui.tool.runningPlain');
  } else meta = item.gate && item.gate.by !== 'judge' && item.gate.by !== 'no-judge' ? gateMeta(t, item, pending) : <>{metaNode(t, view.meta)}{gateMeta(t, item, pending)}</>;
  const helperLink = running?.helperConversation ? <a className="bt-tool__link" href={routeHash({ view: 'chat', id: running.helperConversation })}>{t('ui.tool.openHelper')}</a> : null;
  return (
    <details className={`bt-tool${running ? ' bt-tool--running' : ''}${enterClass(enter)}`} style={enterStyle(enter)} open={running && view.verb === 'helper' ? true : undefined}>
      <Row view={view} running={Boolean(running)} meta={meta}>
        <div className="bt-tool__body">
          {item.gate?.by === 'judge' && <p className="bt-meta ui-tool__gate">{t('ui.tool.judgeReason', item.gate.reason)}</p>}
          {item.gate?.by === 'not-parked' && <p className="bt-meta ui-tool__gate">{t('ui.tool.notRunWhy')}</p>}
          {item.result ? <pre className="ui-tool__out">{emptyOutput(item.result.text) ? t('ui.tool.noOutput') : item.result.text}</pre> : <span className="ui-tool__out">{view.target || view.name}</span>}
          {helperLink}
        </div>
      </Row>
    </details>
  );
}

export function ToolGroup({ rows, isNew, pending }: { rows: ToolItem[]; isNew: (key: string) => boolean; pending?: PendingLink | undefined }) {
  const enters = staggerOf(rows.map(r => isNew(r.key)));
  return (
    <div className="bt-tools">
      {rows.map((item, i) => <ToolLine key={item.key} item={item} enter={enters[i]!} pending={pending} />)}
    </div>
  );
}
