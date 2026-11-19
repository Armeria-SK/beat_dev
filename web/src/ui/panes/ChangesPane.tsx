import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, type ChangedFile, type ChangesScope, type ChangesView, type RefusedChange } from '../../api.ts';
import { changesTouched, useChangesRevision } from '../../changes-undo.ts';
import { formatRelative } from '../../i18n/format.ts';
import { useT } from '../../i18n/index.ts';
import { RedoAction } from '../ChangesRedo.tsx';
import { changePicks, changeTotals, diffLines, matchChange, scopeOf, type ChangesPick } from '../changes.ts';
import { Button, EmptyState, Notice } from '../parts.tsx';
import '../styles/changes.css';

// beat 8-5b: Changes の欄（Design ChangesPane）。差分・ファイルごとと全部の Undo（確かめなし）・測る点の切り替え。branch はタスクのブランチの差分（Undo なし）
export type ChangesSource =
  | { kind: 'product'; productId: string; conversationId: string | undefined; isGit: boolean }
  | { kind: 'branch'; productId: string; worktreeId: string };

export interface ChangesFocus { path: string; n: number }
export interface UndoneNotice { projectId: string; batch: string | null; undone: number; refused: number; more: number }

type T = ReturnType<typeof useT>;
type Loaded = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'ok'; data: ChangesView };
type Problem = { title: string; text: string } | null;

const LEAVE_MS = 240;
const SHOWN_REFUSALS = 3;

const SINCE = { build: 'ui.changes.since.build', commit: 'ui.changes.since.commit', records: 'ui.changes.since.records', conversation: 'ui.changes.since.conversation' } as const;

const pickOf = (data: ChangesView, asked: ChangesPick | null): ChangesPick | 'branch' => (asked ?? data.base.kind);

function refusalText(t: T, refused: readonly RefusedChange[]): string {
  const shown = refused.slice(0, SHOWN_REFUSALS).map(r => `${r.path}: ${t(`ui.changes.why.${r.reason}`)}`);
  const rest = refused.length - shown.length;
  return [...shown, ...(rest > 0 ? [t('ui.changes.more', rest)] : [])].join(' · ');
}

export function ChangesPane({ source, revision, focus, onUndone }: { source: ChangesSource; revision: string; focus?: ChangesFocus | null | undefined; onUndone?: ((notice: UndoneNotice) => void) | undefined }) {
  const t = useT();
  const productId = source.productId;
  const conversation = source.kind === 'product' ? source.conversationId : undefined;
  const touched = useChangesRevision(productId);
  const [pick, setPick] = useState<ChangesPick | null>(null);
  const [hasBuild, setHasBuild] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [notHere, setNotHere] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const generation = useRef(0);
  const seen = useRef<Set<string> | null>(null);
  const handled = useRef(0);
  const root = useRef<HTMLDivElement>(null);
  const worktreeId = source.kind === 'branch' ? source.worktreeId : null;

  const load = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const data = worktreeId ? await api.worktreeChanges(worktreeId) : await api.changes(productId, scopeOf(pick, conversation));
      if (gen !== generation.current) return;
      if (pick === null && data.base.kind === 'build') setHasBuild(true);
      setLeaving(new Set());
      setLoaded({ state: 'ok', data });
    } catch (error) {
      if (gen === generation.current) setLoaded({ state: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }, [productId, worktreeId, pick, conversation]);

  useEffect(() => { void load(); }, [load, revision, touched]);

  const data = loaded.state === 'ok' ? loaded.data : null;

  useEffect(() => {
    if (!data) return;
    seen.current ??= new Set();
    for (const file of data.files) seen.current.add(file.path);
  }, [data]);

  useEffect(() => {
    if (!data || !focus || handled.current === focus.n) return;
    handled.current = focus.n;
    const file = matchChange(data.files, focus.path);
    setNotHere(file ? null : focus.path);
    setFocused(file?.path ?? null);
    if (!file) return;
    const el = [...(root.current?.querySelectorAll<HTMLElement>('.bt-diff[data-path]') ?? [])].find(node => node.dataset.path === file.path);
    el?.scrollIntoView?.({ block: 'start' });
    el?.focus({ preventScroll: true });
  }, [data, focus]);

  if (loaded.state === 'loading') return <div className="ui-changes" ref={root} />;
  if (loaded.state === 'failed') {
    return <div className="ui-changes" ref={root}><Notice tone="warn" icon="alert" title={t('ui.changes.loadFailed')} text={loaded.message} action={{ label: t('ui.fail.retry'), run: () => void load() }} /></div>;
  }

  const view = loaded.data;
  const product = source.kind === 'product';
  const current = pickOf(view, pick);
  const picks = product ? changePicks({ isGit: source.isGit, hasBuild, conversation }) : [];
  const since = current === 'branch' ? t('ui.changes.since.branch') : t(SINCE[current]);
  const totals = changeTotals(view.files);
  const undoable = product && view.files.some(f => f.undo);
  const fresh = seen.current;
  let stagger = 0;

  const undo = async (paths: string[] | 'all') => {
    if (working) return;
    setWorking(true);
    setProblem(null);
    const scope: ChangesScope = current === 'conversation' ? scopeOf('conversation', conversation) : { base: view.base.kind === 'branch' ? undefined : view.base.kind };
    try {
      const done = await api.undoChanges(productId, scope, paths);
      if (done.refused.length) setProblem({ title: t('ui.changes.refused', done.refused.length), text: refusalText(t, done.refused) });
      if (done.undone.length || done.refused.length) onUndone?.({ projectId: productId, batch: done.redo, undone: done.undone.length, refused: done.refused.length, more: done.more });
      setLeaving(new Set(done.undone));
      window.setTimeout(() => { setWorking(false); changesTouched(productId); }, done.undone.length ? LEAVE_MS : 0);
    } catch (error) {
      setProblem({ title: t('ui.changes.undoFailed'), text: error instanceof Error ? error.message : String(error) });
      setWorking(false);
    }
  };

  const select = picks.length > 1 && (
    <select className="bt-select ui-changes__since" aria-label={t('ui.changes.measure')} value={current} onChange={e => { setFocused(null); setNotHere(null); setPick(e.target.value as ChangesPick); }}>
      {picks.map(p => <option key={p} value={p}>{t(SINCE[p])}</option>)}
    </select>
  );

  return (
    <div className="ui-changes" ref={root} data-base={current}>
      {view.files.length > 0 ? (
        <div className="bt-pane__bar">
          <span className="bt-meta">{t('ui.changes.files', totals.files)} · <span className="bt-add">+{totals.added}</span> <span className="bt-del">−{totals.removed}</span>{!select && ` · ${since}`}</span>
          {select}
          {product && <Button small icon="undo" className="ui-changes__all" disabled={!undoable || working} onClick={() => void undo('all')}>{t('ui.changes.undoAll')}</Button>}
        </div>
      ) : select && <div className="bt-pane__bar"><span className="bt-meta" />{select}</div>}
      {problem && <Notice tone="warn" icon="alert" title={problem.title} text={problem.text} />}
      {product && view.redo && <div className="bt-notice ui-changes__redo"><span className="bt-notice__rule" /><span className="ui-notice__text">{t('ui.changes.undidAgo', view.redo.paths.length, formatRelative(view.redo.created_at))}<RedoAction projectId={productId} batch={view.redo.id} /></span><span className="bt-notice__rule" /></div>}
      {view.base.kind === 'records' && <p className="bt-meta ui-changes__note">{t('ui.changes.toolsOnly')}</p>}
      {notHere && <p className="bt-meta ui-changes__note" role="status">{t('ui.changes.notHere', notHere)}</p>}
      {view.files.length === 0
        ? <EmptyState title={t('ui.changes.empty')} text={since} />
        : (
          <div className="bt-pane__stack">
            {view.files.map(file => {
              const rise = !fresh?.has(file.path);
              return <FileDiff key={file.path} file={file} leaving={leaving.has(file.path)} enter={rise ? stagger++ : null} focused={focused === file.path} undoable={product} canUndo={!working} onUndo={() => void undo([file.path])} />;
            })}
          </div>
        )}
      {view.more > 0 && <p className="bt-meta ui-changes__note">{t('ui.changes.more', view.more)}</p>}
    </div>
  );
}

function FileDiff({ file, leaving, enter, focused, undoable, canUndo, onUndo }: { file: ChangedFile; leaving: boolean; enter: number | null; focused: boolean; undoable: boolean; canUndo: boolean; onUndo: () => void }) {
  const t = useT();
  const tag = file.hidden ? t('ui.changes.hidden') : file.status === 'added' ? t('ui.changes.new') : file.status === 'deleted' ? t('ui.changes.deleted') : null;
  const counts = [file.added > 0 && <span key="a" className="bt-add">+{file.added}</span>, file.removed > 0 && <span key="d" className="bt-del">−{file.removed}</span>].filter(Boolean);
  const motion = leaving ? ' is-leaving' : enter !== null ? ' bt-rise' : '';
  const lines = !file.hidden && file.status !== 'deleted' && file.hunks ? diffLines(file.hunks) : null;
  return (
    <div className={`bt-diff${motion}${focused ? ' is-focus' : ''}`} style={enter !== null && !leaving ? { '--bt-i': enter } as CSSProperties : undefined} aria-label={file.path} data-path={file.path} tabIndex={-1}>
      <div className="bt-diff__file">
        <span className="ui-changes__path" title={file.path}>{file.path}{tag && ` · ${tag}`}</span>
        <span className="ui-changes__counts">
          {counts.map((node, i) => <span key={i}>{i > 0 && ' '}{node}</span>)}
          {undoable && file.undo && <>{counts.length > 0 && ' · '}<button type="button" className="bt-tool__link ui-changes__undo" disabled={!canUndo} onClick={onUndo}>{t('ui.changes.undo')}</button></>}
        </span>
      </div>
      {lines?.map((line, i) => (
        <span key={i} className={`bt-diff__line${line.kind === 'add' ? ' bt-diff__line--add' : line.kind === 'del' ? ' bt-diff__line--del' : line.kind === 'gap' ? ' ui-changes__gap' : ''}`} title={line.kind === 'gap' ? undefined : line.text}>{line.text}</span>
      ))}
      {file.hidden && <span className="bt-diff__line ui-changes__why">{t('ui.changes.hiddenNote')}</span>}
      {!file.hidden && file.status !== 'deleted' && !file.hunks && <span className="bt-diff__line ui-changes__why">{t('ui.changes.noLines')}</span>}
    </div>
  );
}
