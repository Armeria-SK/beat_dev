import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type FolderEntry, type FolderList, type Project } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { getLanguage, useT } from '../../i18n/index.ts';
import { serverText } from '../../server-text.ts';
import { entryReason, nameFor, newProjectInput, noteKeys, upTarget } from '../folder-pick.ts';
import { latestOnly } from '../latest.ts';
import { Button, Icon } from '../parts.tsx';
import { routeHash } from '../routes.ts';

type T = ReturnType<typeof useT>;

const failText = (error: unknown): string => (error instanceof ApiError ? error.message : String(error));

function reasonText(t: T, entry: FolderEntry): string | null {
  const reason = entryReason(entry);
  if (reason === null) return null;
  if (reason.kind === 'link') return t('ui.np.link');
  return serverText(reason.code, null, getLanguage()) ?? t('ui.np.unusable');
}

function FolderRow({ entry, chosen, onPick, onOpen }: { entry: FolderEntry; chosen: boolean; onPick: () => void; onOpen: () => void }) {
  const t = useT();
  const reason = reasonText(t, entry);
  return (
    <li className={`bt-row ui-np__row${chosen ? ' is-chosen' : ''}`}>
      <div className="bt-row__main">
        {entry.selectable
          ? <button type="button" className="bt-row__title ui-np__pick" aria-pressed={chosen} onClick={onPick}>{entry.name}</button>
          : <span className="bt-row__title ui-np__name">{entry.name}</span>}
        {reason && <span className="bt-row__sub bt-meta">{reason}</span>}
      </div>
      <div className="bt-row__end">
        {entry.isGit && <span className="bt-tag">{t('ui.np.git')}</span>}
        <button type="button" className="bt-btn bt-btn--icon bt-btn--sm bt-btn--ghost" aria-label={t('ui.np.openFolder', entry.name)} title={t('ui.np.open')} onClick={onOpen}><Icon name="chevR" /></button>
      </div>
    </li>
  );
}

function ArchivedProducts({ onProject }: { onProject: (project: Project) => void }) {
  const t = useT();
  const [items, setItems] = useState<Project[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api.projects(true).then(r => { if (live) setItems(r.projects.filter(p => p.archived_at !== null)); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  if (items.length === 0) return null;
  const restore = async (project: Project) => {
    if (busy) return;
    setBusy(project.id);
    try {
      const result = await api.patchProject(project.id, { archived: false });
      onProject(result.project);
      setItems(old => old.filter(p => p.id !== project.id));
      toast({ icon: 'undo', title: t('ui.np.restored', result.project.name) });
    } catch (error) { toast({ icon: 'alert', title: t('ui.np.restoreFailed', failText(error)) }); } finally { setBusy(null); }
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

export function NewProduct({ onProject }: { onProject: (project: Project) => void }) {
  const t = useT();
  const [listing, setListing] = useState<FolderList | null>(null);
  const [listError, setListError] = useState('');
  const [root, setRoot] = useState('');
  const [name, setName] = useState('');
  const [named, setNamed] = useState(false);
  const [check, setCheck] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const loads = useRef(latestOnly());

  const open = useCallback(async (path?: string) => {
    const ticket = loads.current.begin();
    setListError('');
    try {
      const next = await api.listFolders(path);
      if (loads.current.isCurrent(ticket)) setListing(next);
    } catch (e) {
      if (loads.current.isCurrent(ticket)) setListError(t('ui.np.listFailed', failText(e)));
    }
  }, [t]);
  useEffect(() => { void open(); }, [open]);

  const pick = (path: string) => { setRoot(path); setError(''); };
  const up = listing ? upTarget(listing) : undefined;
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
      setError(t('ui.np.failed', failText(e)));
      setBusy(false);
    }
  };

  return (
    <div className="bt-screen__inner ui-np">
      <header className="bt-screen__head bt-rise">
        <h1 className="bt-screen__title">{t('ui.product.new')}</h1>
      </header>
      <p className="bt-meta">{t('ui.np.lead')}</p>
      <form className="ui-np__form" onSubmit={e => { e.preventDefault(); void create(); }}>
        <div className="bt-form-row">
          <label className="bt-label" htmlFor="ui-np-root">{t('ui.np.folder')}</label>
          <div className="ui-np__pathrow">
            <input id="ui-np-root" className="bt-field bt-field--mono" type="text" value={root} spellCheck={false} autoComplete="off" placeholder={t('ui.np.folderField')}
              onChange={e => { setRoot(e.target.value); setError(''); }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); if (root.trim()) void open(root.trim()); } }} />
            <Button small disabled={!root.trim()} onClick={() => void open(root.trim())}>{t('ui.np.open')}</Button>
          </div>
        </div>

        <section className="bt-section ui-np__browser" aria-label={t('ui.np.folder')}>
          <div className="bt-section__head">
            <span className="bt-meta ui-np__path">{listing?.path ?? t('ui.np.starts')}</span>
            <span className="ui-np__tools">
              {up !== undefined && <Button small variant="ghost" onClick={() => void open(up ?? undefined)}><Icon name="arrowUp" />{t('ui.np.up')}</Button>}
              {listing?.path && <Button small variant="ghost" onClick={() => pick(listing.path!)}>{t('ui.np.use')}</Button>}
            </span>
          </div>
          {listError && <p className="bt-meta ui-danger" role="alert">{listError}</p>}
          {listing && listing.entries.length === 0 && !listError && <p className="bt-meta">{t('ui.np.emptyDir')}</p>}
          {listing && listing.entries.length > 0 && (
            <ul className="bt-list ui-np__list">
              {listing.entries.map(entry => (
                <FolderRow key={entry.path} entry={entry} chosen={entry.path === root} onPick={() => pick(entry.path)} onOpen={() => void open(entry.path)} />
              ))}
            </ul>
          )}
          {listing?.truncated && <p className="bt-meta">{t('ui.np.truncated')}</p>}
        </section>

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
      <ArchivedProducts onProject={onProject} />
    </div>
  );
}
