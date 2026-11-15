import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Project, unreachable } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { useT } from '../../i18n/index.ts';
import { isComposing } from '../../keys.ts';
import { nameFor, newProjectInput, noteKeys } from '../folder-pick.ts';
import { latestOnly } from '../latest.ts';
import { Button, Notice } from '../parts.tsx';
import { routeHash } from '../routes.ts';

const failText = (error: unknown): string => (error instanceof ApiError ? error.message : String(error));

type Action = 'learn' | 'check' | 'browse' | 'create';
type Retry = Action | (() => void);

function ArchivedProducts({ onProject, revive, onReached, onUnreached }: { onProject: (project: Project) => void; revive: number; onReached: () => void; onUnreached: (retry: () => void) => void }) {
  const t = useT();
  const [items, setItems] = useState<Project[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.projects(true).then(r => { if (live) setItems(r.projects.filter(p => p.archived_at !== null)); }).catch(() => undefined);
    return () => { live = false; };
  }, [revive]);
  if (items.length === 0) return null;
  const restore = async (project: Project) => {
    if (busy) return;
    setBusy(project.id);
    try {
      const result = await api.patchProject(project.id, { archived: false });
      onReached();
      onProject(result.project);
      setItems(old => old.filter(p => p.id !== project.id));
      toast({ icon: 'undo', title: t('ui.np.restored', result.project.name) });
    } catch (error) {
      if (unreachable(error)) onUnreached(() => void restore(project));
      else toast({ icon: 'alert', title: t('ui.np.restoreFailed', failText(error)) });
    } finally { setBusy(null); }
  };
  return (
    <section className="bt-section ui-np__archived">
      <span className="bt-label">{t('ui.np.archived')}</span>
      <ul className="bt-list">
        {items.map(p => (
          <li key={p.id} className="bt-row">
            <div className="bt-row__main">
              <span className="bt-row__title">{p.name}</span>
              <span className="bt-row__sub bt-meta ui-np__path">{p.root}</span>
            </div>
            <div className="bt-row__end"><Button small disabled={busy !== null} onClick={() => void restore(p)}>{t('ui.np.restore')}</Button></div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function NewProduct({ onProject, connected = true }: { onProject: (project: Project) => void; connected?: boolean }) {
  const t = useT();
  const [canPick, setCanPick] = useState<boolean | null>(null);
  const [picking, setPicking] = useState(false);
  const [offline, setOffline] = useState<Retry | null>(null);
  const [revive, setRevive] = useState(0);
  const [folderError, setFolderError] = useState('');
  const [folderOk, setFolderOk] = useState<string | null>(null);
  const [root, setRoot] = useState('');
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [check, setCheck] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const loads = useRef(latestOnly());
  const canPickRef = useRef<boolean | null>(null);
  const offlineRef = useRef<Retry | null>(null);
  const pickAbort = useRef<AbortController | null>(null);
  const actions = useRef<Record<Action, () => void>>({ learn: () => undefined, check: () => undefined, browse: () => undefined, create: () => undefined });

  const markOffline = useCallback((retry: Retry | null) => { offlineRef.current = retry; setOffline(() => retry); }, []);
  const failed = (error: unknown, retry: Retry): boolean => {
    if (!unreachable(error)) return false;
    markOffline(retry);
    return true;
  };

  const learn = useCallback(async () => {
    try {
      const { available } = await api.folderPickAvailable();
      canPickRef.current = available;
      setCanPick(available);
      if (offlineRef.current === 'learn') { markOffline(null); setRevive(n => n + 1); }
    } catch (e) {
      if (unreachable(e)) { if (offlineRef.current === null) markOffline('learn'); }
      else { canPickRef.current = false; setCanPick(false); }
    }
  }, [markOffline]);
  useEffect(() => { void learn(); }, [learn]);
  useEffect(() => () => pickAbort.current?.abort(), []);

  const reached = () => {
    if (offlineRef.current !== null) { markOffline(null); setRevive(n => n + 1); }
    if (canPickRef.current === null) void learn();
  };

  const runCheck = async (path: string) => {
    const ticket = loads.current.begin();
    setFolderError(''); setFolderOk(null);
    try {
      const checked = await api.checkFolder(path);
      if (!loads.current.isCurrent(ticket)) return;
      reached();
      setFolderOk(noteKeys(checked.notes).map(key => t(key)).join(' '));
    } catch (e) {
      if (!loads.current.isCurrent(ticket)) return;
      if (!failed(e, 'check')) setFolderError(t('ui.np.checkFailed', failText(e)));
    }
  };

  const browse = async () => {
    if (picking) return;
    const abort = new AbortController();
    pickAbort.current = abort;
    setPicking(true); setFolderError(''); setFolderOk(null);
    try {
      const picked = await api.pickFolder(root.trim() || undefined, abort.signal);
      reached();
      if ('path' in picked) { setRoot(picked.path); setError(''); void runCheck(picked.path); }
    } catch (e) {
      if (abort.signal.aborted) return;
      if (!failed(e, 'browse')) setFolderError(t('ui.np.pickFailed', failText(e)));
    } finally {
      if (pickAbort.current === abort) pickAbort.current = null;
      if (!abort.signal.aborted) setPicking(false);
    }
  };

  const shownName = nameFor(root, name, named);
  const input = newProjectInput(root, shownName, check);

  const create = async () => {
    if (!input || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.createProject(input);
      onProject(result.project);
      const notes = noteKeys(result.notes).map(key => t(key));
      toast({ icon: 'check', title: t('ui.np.created', result.project.name), ...(notes.length ? { body: notes.join(' ') } : {}) });
      location.hash = routeHash({ view: 'productNew', id: result.project.id });
    } catch (e) {
      if (!failed(e, 'create')) setError(t('ui.np.failed', failText(e)));
      setBusy(false);
    }
  };

  actions.current = {
    learn: () => void learn(),
    check: () => { if (root.trim()) void runCheck(root.trim()); else markOffline(null); },
    browse: () => void browse(),
    create: () => { if (input) void create(); else markOffline(null); },
  };
  const retry = () => {
    const what = offlineRef.current;
    if (what === null) return;
    if (canPickRef.current === null && what !== 'learn') void learn();
    if (typeof what === 'function') what(); else actions.current[what]();
  };

  const wasConnected = useRef(connected);
  useEffect(() => {
    const what = offlineRef.current;
    if (connected && !wasConnected.current && (what === 'learn' || what === 'check')) retry();
    wasConnected.current = connected;
  });

  return (
    <div className="bt-screen__inner ui-np">
      <header className="bt-screen__head bt-rise">
        <h1 className="bt-screen__title">{t('ui.product.new')}</h1>
      </header>
      <p className="bt-meta">{t('ui.np.lead')}</p>
      {offline !== null && <Notice tone="warn" icon="alert" title={t('ui.np.notAnswering')} action={{ label: t('ui.fail.retry'), run: retry }} />}
      <form className="ui-np__form" onSubmit={e => { e.preventDefault(); void create(); }}>
        <div className="bt-form-row">
          <label className="bt-label" htmlFor="ui-np-root">{t('ui.np.folder')}</label>
          <div className="ui-np__pathrow">
            <input id="ui-np-root" className="bt-field bt-field--mono" type="text" value={root} spellCheck={false} autoComplete="off" placeholder={canPick ? t('ui.np.folderFieldPick') : t('ui.np.folderField')}
              onChange={e => { setRoot(e.target.value); setError(''); setFolderError(''); setFolderOk(null); }}
              onKeyDown={e => { if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); if (root.trim()) void runCheck(root.trim()); } }} />
            {canPick
              ? <Button small disabled={picking} onClick={() => void browse()}>{t('ui.np.open')}</Button>
              : <Button small disabled={!root.trim()} onClick={() => void runCheck(root.trim())}>{t('ui.np.open')}</Button>}
          </div>
          {picking && <p className="bt-meta" role="status">{t('ui.np.picking')}</p>}
          {folderError && <p className="bt-meta ui-danger" role="alert">{folderError}</p>}
          {folderOk !== null && <p className="bt-meta" role="status">{folderOk ? `${t('ui.np.folderOk')} · ${folderOk}` : t('ui.np.folderOk')}</p>}
        </div>

        <label className="bt-form-row">
          <span className="bt-label">{t('ui.np.name')}</span>
          <input className="bt-field" type="text" value={shownName} maxLength={100} autoComplete="off" placeholder={t('ui.np.nameHint')}
            onChange={e => { setName(e.target.value); setNamed(true); }} />
        </label>
        <label className="bt-form-row">
          <span className="bt-label">{t('ui.np.check')}</span>
          <input className="bt-field bt-field--mono" type="text" value={check} spellCheck={false} autoComplete="off" onChange={e => setCheck(e.target.value)} />
          <span className="bt-meta">{t('ui.np.checkHint')}</span>
        </label>
        <p className="bt-meta">{t('ui.np.agents')}</p>
        {error && <p className="bt-meta ui-danger" role="alert">{error}</p>}
        <div className="ui-np__actions"><Button type="submit" variant="primary" disabled={!input || busy}>{t('ui.np.create')}</Button></div>
      </form>
      <ArchivedProducts onProject={onProject} revive={revive} onReached={reached} onUnreached={again => markOffline(again)} />
    </div>
  );
}
