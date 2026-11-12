import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, type ModelView, type SettingsView } from '../../api.ts';
import { applyServerSettings, useT } from '../../i18n/index.ts';
import { problemsOf, type Config } from '../../settings/model.ts';
import { Icon } from '../parts.tsx';
import { routeHash } from '../routes.ts';
import { BackgroundPanel, ModelsPanel, SkillsPanel } from './agent.tsx';
import { planSave } from './commit.ts';
import { BrowserPanel, FoldersPanel, HooksPanel, ServerPanel } from './computer.tsx';
import { Loading, SettingsContext, type Pending, type SetCtx } from './controls.tsx';
import { AdvancedPanel, AppearancePanel, PersonaPanel } from './customize.tsx';
import { McpPanel } from './mcp.tsx';
import { CATEGORIES, categoryById, DEFAULT_CATEGORY, GROUP_LABEL, isCategory, matchCategories, type CategoryId, type GroupId } from './rows.ts';

export interface SettingsProps {
  section: string | undefined;
  onClose: () => void;
  onReplay: () => void;
  onSaved: () => void;
  onProfile: () => void;
}

const GROUPS: readonly GroupId[] = ['agent', 'computer', 'customize'];

export const openCategory = (id: string): void => location.replace(routeHash({ view: 'settings', section: id }));

export function Settings({ section, onClose, onReplay, onSaved, onProfile }: SettingsProps) {
  const t = useT();
  const [view, setView] = useState<SettingsView | null>(null);
  const [failed, setFailed] = useState(false);
  const [models, setModels] = useState<ModelView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const close = useRef<HTMLButtonElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const current: CategoryId = isCategory(section) ? section : DEFAULT_CATEGORY;

  useEffect(() => { close.current?.focus(); }, []);
  useEffect(() => { main.current?.scrollTo({ top: 0 }); setPending(null); }, [current]);

  const reload = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([api.settings(), api.models()]);
      setView(s); setModels(m.models); setFailed(false); applyServerSettings(s);
    } catch { setFailed(true); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const fail = useCallback((row: string, message: string) => { setErrors(old => ({ ...old, [row]: message })); setRevision(n => n + 1); }, []);
  const clear = useCallback((row: string) => setErrors(old => (old[row] ? { ...old, [row]: '' } : old)), []);
  const cancel = useCallback(() => { setPending(old => { if (old) setRevision(n => n + 1); return null; }); }, []);

  const commit = useCallback(async function run(row: string, edit: (config: Config) => Config, confirmed: string | null = null): Promise<boolean> {
    setBusy(row); setPending(null); setErrors(old => (old[row] ? { ...old, [row]: '' } : old));
    let latest: Config | null = null;
    try {
      latest = (await api.settings()).config;
      const plan = planSave(latest, edit, confirmed);
      if (plan.kind === 'same') return true;
      if (plan.kind === 'confirm') {
        setPending({ row, items: plan.items, run: () => void run(row, edit, plan.key) });
        return false;
      }
      const result = await api.saveSettings(plan.config);
      setView(result); setModels(result.models); applyServerSettings(result);
      onSaved();
      return true;
    } catch (error) {
      const problems = error instanceof ApiError ? problemsOf(error.body, error.message, latest ?? {}) : problemsOf(undefined, t('ui.set.failed'), latest ?? {});
      setErrors(old => ({ ...old, [row]: problems.map(p => p.text).join(' · ') }));
      setRevision(n => n + 1);
      return false;
    } finally { setBusy(null); }
  }, [onSaved, t]);

  const ctx = useMemo<SetCtx | null>(() => (view ? {
    view, config: view.config, models, busy, pending, errors, revision,
    commit, ask: setPending, cancel, fail, clear, reload, setBusy, onProfile, openCategory,
  } : null), [view, models, busy, pending, errors, revision, commit, cancel, fail, clear, reload, onProfile]);

  const matches = useMemo(() => matchCategories(query, key => t(key)), [query, t]);
  const search = (text: string) => {
    setQuery(text);
    const hits = matchCategories(text, key => t(key));
    if (text.trim() && hits[0] && hits[0] !== current) openCategory(hits[0]);
  };
  const category = categoryById(current);

  let body: ReactNode;
  if (!ctx) body = <Loading failed={failed} onRetry={() => void reload()} />;
  else {
    switch (current) {
      case 'models': body = <ModelsPanel />; break;
      case 'skills': body = <SkillsPanel />; break;
      case 'background': body = <BackgroundPanel />; break;
      case 'folders': body = <FoldersPanel />; break;
      case 'hooks': body = <HooksPanel />; break;
      case 'browser': body = <BrowserPanel />; break;
      case 'mcp': body = <McpPanel />; break;
      case 'server': body = <ServerPanel />; break;
      case 'persona': body = <PersonaPanel onReplay={onReplay} />; break;
      case 'appearance': body = <AppearancePanel />; break;
      case 'advanced': body = <AdvancedPanel />; break;
    }
  }

  return (
    <div className="ui-overlay">
      <div className="bt-scrim" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
        <section className="bt-modal" role="dialog" aria-modal="true" aria-labelledby="ui-settings-title">
          <header className="bt-modal__bar">
            <h2 className="bt-modal__title" id="ui-settings-title">{t('ui.nav.settings')}</h2>
            <span className="bt-meta ui-set__hint">{t('ui.set.escHint')}</span>
            <button ref={close} type="button" className="bt-btn bt-btn--icon bt-btn--ghost" aria-label={t('ui.set.close')} onClick={onClose}><Icon name="x" /></button>
          </header>
          <div className="bt-modal__body">
            <nav className="bt-modal__nav" aria-label={t('ui.set.categories')}>
              <div className="bt-modal__search">
                <Icon name="search" />
                <input className="bt-field" type="search" placeholder={t('ui.set.search')} aria-label={t('ui.set.searchLabel')} value={query} onChange={e => search(e.target.value)} />
              </div>
              {GROUPS.map(group => (
                <div key={group} className="ui-set__navgroup" hidden={!CATEGORIES.some(c => c.group === group && matches.includes(c.id))}>
                  <span className="bt-label">{t(GROUP_LABEL[group])}</span>
                  {CATEGORIES.filter(c => c.group === group).map(c => (
                    <button key={c.id} type="button" className="bt-cat" data-cat={c.id} hidden={!matches.includes(c.id)} aria-current={c.id === current ? 'true' : undefined}
                      onClick={() => { if (c.id !== current) openCategory(c.id); }}>
                      <Icon name={c.icon} />{t(c.label)}
                    </button>
                  ))}
                </div>
              ))}
              {matches.length === 0 && <p className="bt-meta ui-set__nomatch">{t('ui.set.noMatch')}</p>}
            </nav>
            <div className="bt-modal__main" ref={main}>
              <section className="bt-panel is-current" data-panel={current} aria-label={t(category.label)}>
                <h2 className="bt-panel__title">{t(category.label)}</h2>
                {ctx ? <SettingsContext.Provider value={ctx}>{body}</SettingsContext.Provider> : body}
              </section>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
