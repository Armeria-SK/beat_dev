import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError, type Conversation, type Project } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatDateTime, formatRelative, useT } from '../../i18n/index.ts';
import { useNow } from '../hooks.ts';
import { latestOnly } from '../latest.ts';
import { archivedLine, archivedNothing } from '../library.ts';
import { Button, Notice } from '../parts.tsx';
import { needsShelved, productLine } from '../product-meta.ts';
import { routeHash } from '../routes.ts';
import { RowConfirm } from '../RowConfirm.tsx';

const failText = (error: unknown): string | undefined => (error instanceof ApiError ? error.message : undefined);

export function Archived({ revision, projects, projectsLoaded }: { revision: number; projects: readonly Project[]; projectsLoaded: boolean }) {
  const t = useT();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [shelved, setShelved] = useState<Project[] | null>(null);
  const [loadedFor, setLoadedFor] = useState('');
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loads = useRef(latestOnly());
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const now = useNow(60_000);

  const load = useCallback(async (q: string) => {
    const ticket = loads.current.begin();
    try {
      const result = await api.archivedConversations(q);
      if (!loads.current.isCurrent(ticket)) return;
      setItems(result.conversations); setLoadedFor(q); setFailed(false);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, []);
  useEffect(() => { const timer = setTimeout(() => void load(query), query ? 200 : 100); return () => clearTimeout(timer); }, [load, query, revision, tick]);
  const hasProducts = items?.some(c => c.project_id) ?? false;
  const activeKey = projects.map(p => p.id).join(',');
  useEffect(() => {
    if (!hasProducts) return;
    void api.projects(true).then(r => setShelved(r.projects)).catch(() => setShelved(old => old ?? []));
  }, [hasProducts, activeKey, revision]);

  const reload = () => setTick(n => n + 1);
  const title = (c: Conversation): string => c.title || t('ui.session.untitled');
  const productText = (c: Conversation): string | null => {
    const line = productLine(c.project_id, projects, shelved, projectsLoaded);
    if (!line) return null;
    return line.archived ? (line.name ? t('ui.pf.archived', line.name) : t('ui.pf.someArchived')) : line.name;
  };
  const restore = async (c: Conversation) => {
    if (busy) return;
    setBusy(c.id);
    try {
      await api.unarchiveConversation(c.id);
      setItems(current => current?.filter(x => x.id !== c.id) ?? current);
      const known = needsShelved(c.project_id, projects, shelved) ? await api.projects(true).then(r => r.projects, () => []) : shelved;
      const line = productLine(c.project_id, projects, known, projectsLoaded);
      toast({
        icon: 'undo', title: t('ui.archived.toast.restored'), body: line?.archived ? t('ui.pf.restoredUnder', line.name ?? t('ui.pf.someArchived')) : title(c),
        action: { label: t('ui.toast.undo'), run: () => { void api.archiveConversation(c.id).then(reload).catch(error => toast({ icon: 'alert', title: t('ui.task.toast.undoFailed'), body: failText(error) })); } },
      });
      reload();
    } catch (error) { toast({ icon: 'alert', title: t('ui.archived.toast.failed'), body: failText(error) }); } finally { setBusy(null); }
  };
  const remove = async (c: Conversation) => {
    if (busy) return;
    setBusy(c.id);
    try {
      await api.deleteConversation(c.id);
      setConfirming(null);
      setItems(current => current?.filter(x => x.id !== c.id) ?? current);
      toast({ icon: 'x', title: t('ui.archived.toast.deleted'), body: title(c) });
      reload();
    } catch (error) { toast({ icon: 'alert', title: t('ui.archived.toast.failed'), body: failText(error) }); } finally { setBusy(null); }
  };
  const keep = (id: string, refocus: boolean) => { setConfirming(null); if (refocus) requestAnimationFrame(() => deleteButtons.current.get(id)?.focus()); };
  const nothing = archivedNothing(items, loadedFor, query);

  return (
    <div className="bt-screen__inner">
      <header className="bt-screen__head bt-rise">
        <h1 className="bt-screen__title">{t('ui.nav.archived')}</h1>
        <div className="bt-screen__tools">{items && !nothing && <span className="bt-meta">{t('ui.archived.count', items.length)}</span>}</div>
      </header>
      {!nothing && <input type="search" className="bt-field ui-lib__search bt-rise" value={query} placeholder={t('ui.archived.search')} aria-label={t('ui.archived.search')} onChange={e => setQuery(e.target.value)} />}
      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: reload }} />}
      {items && items.length === 0 && <p className="ui-lib__nothing">{nothing ? t('ui.archived.empty') : t('ui.archived.noMatch')}</p>}
      {items && items.length > 0 && (
        <ul className="bt-list bt-rise" style={{ '--bt-i': 1 } as CSSProperties} aria-label={t('ui.nav.archived')}>
          {items.map(c => {
            const { messages, archivedAt } = archivedLine(c);
            const meta = [
              productText(c),
              messages !== null ? t('ui.archived.messages', messages) : null,
              archivedAt !== null ? t('ui.archived.at', formatRelative(archivedAt, now)) : t('ui.archived.atUnknown'),
            ].filter(Boolean).join(' · ');
            return (
              <li key={c.id} className="bt-row ui-lib__archived">
                <div className="bt-row__main">
                  <a className="bt-row__title ui-card__link" href={routeHash({ view: 'chat', id: c.id })}>{title(c)}</a>
                  <span className="bt-row__sub bt-meta" title={archivedAt !== null ? formatDateTime(archivedAt, 'full') : undefined}>{meta}</span>
                </div>
                {confirming === c.id ? (
                  <RowConfirm warn={t('ui.lib.deleteWarn')} note={t('ui.session.deleteWhat')} action={t('ui.lib.delete')} busy={busy === c.id}
                    onConfirm={() => void remove(c)} onKeep={refocus => keep(c.id, refocus)} />
                ) : (
                  <div className="bt-row__end">
                    <Button small disabled={busy !== null} onClick={() => void restore(c)}>{t('ui.archived.restore')}</Button>
                    <Button small variant="ghost" className="bt-btn--danger" disabled={busy !== null}
                      ref={el => { if (el) deleteButtons.current.set(c.id, el); else deleteButtons.current.delete(c.id); }}
                      onClick={() => setConfirming(c.id)}>{t('ui.lib.delete')}</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
