import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError, type ChangedFile, type ChangesScope, type ChangesView, type RuntimeChangeFile, type RuntimeChangeRun } from '../../api.ts';
import { changesTouched, ownUndo, rememberUndo, useChangesRevision } from '../../changes-undo.ts';
import { formatRelative } from '../../i18n/format.ts';
import { useT } from '../../i18n/index.ts';
import { RedoAction } from '../ChangesRedo.tsx';
import { changePicks, changeTotals, diffLines, matchChange, refusalText, scopeOf, shownHashes, type ChangesPick } from '../changes.ts';
import { Button, EmptyState, Notice } from '../parts.tsx';
import '../styles/changes.css';

// beat 8-5b: Changes の欄（Design ChangesPane）。差分・ファイルごとと全部の Undo（確かめなし）・測る点の切り替え。branch はタスクのブランチの差分（Undo なし）
export type ChangesSource =
  | { kind: 'product'; productId: string; conversationId: string | undefined; isGit: boolean; root?: string | null | undefined }
  | { kind: 'branch'; productId: string; worktreeId: string };

export interface ChangesFocus { path: string; n: number }
export interface UndoneNotice { projectId: string; batch: string | null; undone: number; refused: number; more: number }

type Loaded = { state: 'loading' } | { state: 'failed'; message: string; runs: RuntimeChangeRun[] } | { state: 'ok'; data: ChangesView; asked: ChangesPick | null; seq: number };
type Problem = { title: string; text: string } | null;

const LEAVE_MS = 240;

// 読めなかったときの返事にも、実行役の返事ごとの一覧が付いてくることがある（git が使えなくなったとき）
const runsOf = (error: unknown): RuntimeChangeRun[] => (error instanceof ApiError && Array.isArray(error.body?.runtime?.runs) ? error.body.runtime.runs as RuntimeChangeRun[] : []);

const SINCE = { build: 'ui.changes.since.build', commit: 'ui.changes.since.commit', records: 'ui.changes.since.records', conversation: 'ui.changes.since.conversation' } as const;
export function ChangesPane({ source, revision, focus, onFocusUsed, onUndone }: { source: ChangesSource; revision: string; focus?: ChangesFocus | null | undefined; onFocusUsed?: (() => void) | undefined; onUndone?: ((notice: UndoneNotice) => void) | undefined }) {
  const t = useT();
  const productId = source.productId;
  const conversation = source.kind === 'product' ? source.conversationId : undefined;
  const productRoot = source.kind === 'product' ? source.root ?? null : null;
  const touched = useChangesRevision(productId);
  const [pick, setPick] = useState<ChangesPick | null>(null);
  const [hasBuild, setHasBuild] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [notHere, setNotHere] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const generation = useRef(0);
  const seen = useRef<Set<string> | null>(null);
  const wanted = useRef<{ path: string; after: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const worktreeId = source.kind === 'branch' ? source.worktreeId : null;
  const busy = useRef<string | null>(null);
  const dirty = useRef(false);
  const leaveTimer = useRef<number | null>(null);
  const key = `${productId}|${worktreeId ?? ''}|${pick ?? ''}|${conversation ?? ''}`;

  const load = useCallback(async (): Promise<void> => {
    const gen = ++generation.current;
    busy.current = key;
    dirty.current = false;
    try {
      const data = worktreeId ? await api.worktreeChanges(worktreeId) : await api.changes(productId, scopeOf(pick, conversation));
      if (gen !== generation.current) return;
      if (pick === null && data.base.kind === 'build') setHasBuild(true);
      setLeaving(new Set());
      setNotHere(null);
      setLoaded({ state: 'ok', data, asked: pick, seq: gen });
    } catch (error) {
      if (gen === generation.current) setLoaded({ state: 'failed', message: error instanceof Error ? error.message : String(error), runs: runsOf(error) });
    } finally {
      if (gen === generation.current) {
        busy.current = null;
        if (dirty.current) void load();
      }
    }
  }, [key, productId, worktreeId, pick, conversation]);

  useEffect(() => {
    if (busy.current === key) dirty.current = true;
    else void load();
  }, [load, key, revision, touched, focusTick]);

  useEffect(() => () => {
    generation.current++;
    busy.current = null;
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
  }, []);

  useEffect(() => {
    if (!focus) return;
    wanted.current = { path: focus.path, after: generation.current + 1 };
    onFocusUsed?.();
    setFocused(null);
    setFocusTick(n => n + 1);
  }, [focus, onFocusUsed]);

  const data = loaded.state === 'ok' ? loaded.data : null;

  useEffect(() => {
    if (!data) return;
    seen.current ??= new Set();
    for (const file of data.files) seen.current.add(file.path);
  }, [data]);

  useEffect(() => {
    const want = wanted.current;
    if (loaded.state !== 'ok' || !want || loaded.seq < want.after) return;
    wanted.current = null;
    const file = matchChange(loaded.data.files, want.path, productRoot);
    setNotHere(file ? null : want.path);
    setFocused(file?.path ?? null);
    if (!file) return;
    const el = [...(root.current?.querySelectorAll<HTMLElement>('.bt-diff[data-path]') ?? [])].find(node => node.dataset.path === file.path);
    el?.scrollIntoView?.({ block: 'start' });
    el?.focus({ preventScroll: true });
  }, [loaded, productRoot]);

  const product = source.kind === 'product';
  const picks = product ? changePicks({ isGit: source.isGit, hasBuild, conversation }) : [];
  const picker = (value: ChangesPick | 'branch' | '') => picks.length > 1 && value !== 'branch' && (
    <select className="bt-select ui-changes__since" aria-label={t('ui.changes.measure')} value={value} onChange={e => { setFocused(null); setNotHere(null); setProblem(null); setPick(e.target.value as ChangesPick); }}>
      {value === '' && <option value="" disabled>{t('ui.changes.measure')}</option>}
      {picks.map(p => <option key={p} value={p}>{t(SINCE[p])}</option>)}
    </select>
  );

  if (loaded.state === 'loading') return <div className="ui-changes" ref={root} />;
  if (loaded.state === 'failed') {
    const select = picker(pick ?? '');
    return (
      <div className="ui-changes" ref={root}>
        {select && <div className="bt-pane__bar"><span className="bt-meta" />{select}</div>}
        <Notice tone="warn" icon="alert" title={t('ui.changes.loadFailed')} text={loaded.message} action={{ label: t('ui.fail.retry'), run: () => void load() }} />
        {loaded.runs.length > 0 && <RuntimeGroup runs={loaded.runs} />}
      </div>
    );
  }

  const view = loaded.data;
  const runs = view.runtime?.runs ?? [];
  const shown: ChangesPick | 'branch' = loaded.asked ?? view.base.kind;
  const current: ChangesPick | 'branch' = pick ?? shown;
  const stale = pick !== loaded.asked;
  const since = shown === 'branch' ? t('ui.changes.since.branch') : t(SINCE[shown]);
  const totals = changeTotals(view.files);
  const undoPaths = product ? view.files.filter(f => f.undo).map(f => f.path) : [];
  const blocked = working || stale;
  const fresh = seen.current;
  let stagger = 0;

  const undo = async (paths: string[]) => {
    if (blocked || !paths.length || view.base.kind === 'branch') return;
    setWorking(true);
    setProblem(null);
    const scope: ChangesScope = shown === 'conversation' ? scopeOf('conversation', conversation) : { base: view.base.kind };
    const more = paths.length === undoPaths.length ? view.more : 0;
    try {
      const done = await api.undoChanges(productId, scope, paths, shownHashes(view.files, paths));
      if (done.redo) rememberUndo(done.redo);
      if (done.refused.length) setProblem({ title: t('ui.changes.refused', done.refused.length), text: refusalText(t, done.refused) });
      if (done.undone.length || done.refused.length) onUndone?.({ projectId: productId, batch: done.redo, undone: done.undone.length, refused: done.refused.length, more });
      setLeaving(new Set(done.undone));
      leaveTimer.current = window.setTimeout(() => { leaveTimer.current = null; setWorking(false); changesTouched(productId); }, done.undone.length ? LEAVE_MS : 0);
    } catch (error) {
      setProblem({ title: t('ui.changes.undoFailed'), text: error instanceof Error ? error.message : String(error) });
      setWorking(false);
    }
  };

  const select = picker(current);
  const redo = product && view.redo && ownUndo(view.redo.id) ? view.redo : null;

  return (
    <div className="ui-changes" ref={root} data-base={current}>
      {view.files.length > 0 ? (
        <div className="bt-pane__bar">
          <span className="bt-meta">{t('ui.changes.files', totals.files)} · <span className="bt-add">+{totals.added}</span> <span className="bt-del">−{totals.removed}</span>{!select && ` · ${since}`}</span>
          {select}
          {product && <Button small icon="undo" className="ui-changes__all" disabled={!undoPaths.length || blocked} onClick={() => void undo(undoPaths)}>{t('ui.changes.undoAll')}</Button>}
        </div>
      ) : select && <div className="bt-pane__bar"><span className="bt-meta" />{select}</div>}
      {problem && <Notice tone="warn" icon="alert" title={problem.title} text={problem.text} />}
      {redo && <div className="bt-notice ui-changes__redo"><span className="bt-notice__rule" /><span className="ui-notice__text">{t('ui.changes.undidAgo', redo.paths.length, formatRelative(redo.created_at))}<RedoAction projectId={productId} batch={redo.id} /></span><span className="bt-notice__rule" /></div>}
      {view.base.kind === 'records' && <p className="bt-meta ui-changes__note">{t('ui.changes.toolsOnly')}</p>}
      {notHere && <p className="bt-meta ui-changes__note" role="status">{t('ui.changes.notHere', notHere)}</p>}
      {view.files.length === 0
        ? (runs.length === 0 && <EmptyState title={t('ui.changes.empty')} text={since} />)
        : (
          <div className="bt-pane__stack">
            {view.files.map(file => {
              const rise = !fresh?.has(file.path);
              return <FileDiff key={file.path} file={file} leaving={leaving.has(file.path)} enter={rise ? stagger++ : null} focused={focused === file.path} undoable={product} canUndo={!blocked} onUndo={() => void undo([file.path])} />;
            })}
          </div>
        )}
      {view.more > 0 && <p className="bt-meta ui-changes__note">{t('ui.changes.more', view.more)}</p>}
      {runs.length > 0 && <RuntimeGroup runs={runs} />}
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

const RUNTIME_NAME: Record<string, 'ui.set.runtime.claude-code' | 'ui.set.runtime.codex'> = { 'claude-code': 'ui.set.runtime.claude-code', codex: 'ui.set.runtime.codex' };
const RUNTIME_MARK = { protected: 'ui.changes.runtime.mark.protected', guarded: 'ui.changes.runtime.mark.guarded', link: 'ui.changes.runtime.mark.link', outside: 'ui.changes.runtime.mark.outside', unsafe: 'ui.changes.runtime.mark.unsafe' } as const;
const RUNTIME_STATE = { no_git: 'ui.changes.runtime.state.no_git', git_unusable: 'ui.changes.runtime.state.git_unusable', too_many: 'ui.changes.runtime.state.too_many', too_many_after: 'ui.changes.runtime.state.too_many_after', unknown: 'ui.changes.runtime.state.unknown', timeout: 'ui.changes.runtime.state.timeout', failed: 'ui.changes.runtime.state.failed' } as const;
const RUNTIME_GIT = { head: 'ui.changes.runtime.git.head', branch: 'ui.changes.runtime.git.branch', refs: 'ui.changes.runtime.git.refs', stash: 'ui.changes.runtime.git.stash', config: 'ui.changes.runtime.git.config', hooks: 'ui.changes.runtime.git.hooks', worktrees: 'ui.changes.runtime.git.worktrees', git: 'ui.changes.runtime.git.git', exclude: 'ui.changes.runtime.git.exclude', modules: 'ui.changes.runtime.git.modules', index: 'ui.changes.runtime.git.index', link: 'ui.changes.runtime.git.link' } as const;

// beat AR-9: 外の実行役の返事ごとに、beat 自身が git の前後から割り出した変更。差分の行も Undo もない（元に戻す対象ではない）
function RuntimeGroup({ runs }: { runs: RuntimeChangeRun[] }) {
  const t = useT();
  return (
    <section className="ui-changes__runtime" aria-label={t('ui.changes.runtime.title')}>
      <h3 className="bt-card__title">{t('ui.changes.runtime.title')}</h3>
      <p className="bt-meta ui-changes__note">{t('ui.changes.runtime.note')}</p>
      {runs.map(run => <RuntimeRun key={run.runId} run={run} />)}
    </section>
  );
}

function RuntimeRun({ run }: { run: RuntimeChangeRun }) {
  const t = useT();
  const name = run.kind && RUNTIME_NAME[run.kind] ? t(RUNTIME_NAME[run.kind]!) : run.runtime;
  const git = run.git.map(code => (Object.hasOwn(RUNTIME_GIT, code) ? t(RUNTIME_GIT[code as keyof typeof RUNTIME_GIT]) : code));
  const nothing = run.state === 'ok' && run.files.length === 0 && run.unchecked === 0 && run.git.length === 0;
  return (
    <div className="ui-changes__run" data-run={run.runId} data-alert={run.alert ? 'true' : undefined}>
      <div className="ui-changes__runhead">
        <span className="bt-meta">{name} · {formatRelative(run.at)}</span>
        {run.outcome !== 'ok' && <span className="bt-tag">{t(run.outcome === 'failed' ? 'ui.changes.runtime.outcome.failed' : 'ui.changes.runtime.outcome.stopped')}</span>}
      </div>
      {run.state !== 'ok' && <p className="bt-meta ui-changes__note">{t(RUNTIME_STATE[run.state])}</p>}
      {nothing && <p className="bt-meta ui-changes__note">{t('ui.changes.runtime.none')}</p>}
      {run.files.length > 0 && (
        <ul className="ui-changes__runfiles">
          {run.files.map(file => <RuntimeFile key={file.path} file={file} />)}
        </ul>
      )}
      {run.more > 0 && <p className="bt-meta ui-changes__note">{t('ui.changes.more', run.more)}</p>}
      {run.unchecked > 0 && <p className="bt-meta ui-changes__note">{t('ui.changes.runtime.unchecked', run.unchecked)}</p>}
      {git.length > 0 && <p className="bt-meta ui-changes__note">{t('ui.changes.runtime.git', git.join(', '))}</p>}
      {run.unseen && <p className="bt-meta ui-changes__note ui-changes__alert" role="status">{t('ui.changes.runtime.unseen')}</p>}
      {run.alert && !run.unseen && <p className="bt-meta ui-changes__note ui-changes__alert" role="status">{t('ui.changes.runtime.alert')}</p>}
    </div>
  );
}

function RuntimeFile({ file }: { file: RuntimeChangeFile }) {
  const t = useT();
  const status = file.status === 'added' ? t('ui.changes.new') : file.status === 'deleted' ? t('ui.changes.deleted') : t('ui.changes.runtime.modified');
  return (
    <li className="ui-changes__runfile" data-path={file.path}>
      <span className="ui-changes__path" title={file.path}>{file.path}</span>
      <span className="ui-changes__marks">
        <span className="bt-tag">{status}</span>
        {file.marks.map(mark => <span key={mark} className="bt-tag ui-changes__mark" data-mark={mark}>{t(RUNTIME_MARK[mark])}</span>)}
      </span>
    </li>
  );
}
