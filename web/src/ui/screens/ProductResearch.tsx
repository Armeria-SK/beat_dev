import { useEffect, useState } from 'react';
import { api, ApiError, type Project, type ResearchLanguageName, type ResearchOwn, type ResearchView } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { useT } from '../../i18n/index.ts';
import { Button } from '../parts.tsx';
import { LIMIT_KEYS, LIMIT_RANGE, ownSettings, toggleLanguage } from '../research.ts';
import { LanguagePicker, LIMIT_LABEL, MODE_LABEL, WHEN_LABEL } from '../settings/research.tsx';

type Limits = Record<(typeof LIMIT_KEYS)[number], string>;

const limitText = (own: ResearchOwn | null): Limits =>
  Object.fromEntries(LIMIT_KEYS.map(key => [key, own?.limits?.[key] === undefined ? '' : String(own.limits[key])])) as Limits;

export function readLimit(key: (typeof LIMIT_KEYS)[number], text: string): number | undefined | 'bad' {
  const value = text.trim();
  if (!value) return undefined;
  if (!/^\d+$/u.test(value)) return 'bad';
  const n = Number(value);
  return n >= LIMIT_RANGE[key].min && n <= LIMIT_RANGE[key].max ? n : 'bad';
}

export function ProductResearch({ project }: { project: Project }) {
  const t = useT();
  const [view, setView] = useState<ResearchView | null>(null);
  const [draft, setDraft] = useState<ResearchOwn>({});
  const [limits, setLimits] = useState<Limits>(() => limitText(null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const take = (next: ResearchView) => { setView(next); setDraft(next.own ?? {}); setLimits(limitText(next.own)); };
  useEffect(() => {
    let live = true;
    void api.research(project.id).then(next => { if (live) take(next); }, () => { if (live) setView(null); });
    return () => { live = false; };
  }, [project.id]);
  if (!view) return null;
  const read = LIMIT_KEYS.map(key => [key, readLimit(key, limits[key])] as const);
  const bad = read.find(([, v]) => v === 'bad');
  const own = ownSettings({ ...draft, limits: Object.fromEntries(read.filter(([, v]) => typeof v === 'number')) });
  const dirty = JSON.stringify(own) !== JSON.stringify(view.own ?? null);
  const set = (patch: Partial<ResearchOwn>) => setDraft(ownSettings({ ...draft, ...patch }) ?? {});
  const lists = { prefer: draft.preferLanguages ?? [], avoid: draft.avoidLanguages ?? [] };
  const toggle = (which: 'prefer' | 'avoid', language: ResearchLanguageName) => {
    const next = toggleLanguage(lists, which, language);
    set({ preferLanguages: draft.preferLanguages || which === 'prefer' ? next.prefer : undefined, avoidLanguages: draft.avoidLanguages || which === 'avoid' ? next.avoid : undefined });
  };
  const save = async () => {
    if (busy || bad || !dirty) return;
    setBusy(true); setError('');
    try {
      await api.patchProject(project.id, { researchSettings: own });
      take(await api.research(project.id));
      toast({ icon: 'check', title: t('ui.ps.saved') });
    } catch (e) { setError(t('ui.ps.failed', e instanceof ApiError ? e.message : String(e))); } finally { setBusy(false); }
  };
  const select = (id: string, label: string, value: string, options: Array<[string, string]>, onChange: (v: string) => void) => (
    <div className="bt-form-row">
      <label className="bt-label" htmlFor={id}>{label}</label>
      <select id={id} className="bt-field ui-ps__lang" value={value} disabled={busy} onChange={e => onChange(e.target.value)}>
        <option value="">{t('ui.ps.rs.global')}</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </div>
  );
  const listRow = (which: 'prefer' | 'avoid', label: string) => {
    const mine = which === 'prefer' ? draft.preferLanguages : draft.avoidLanguages;
    return (
      <div className="bt-form-row" data-rs-list={which}>
        <span className="bt-label">{label}</span>
        <label className="ui-rs__line"><input type="checkbox" checked={mine !== undefined} disabled={busy}
          onChange={e => set(which === 'prefer' ? { preferLanguages: e.target.checked ? [] : undefined } : { avoidLanguages: e.target.checked ? [] : undefined })} /><span>{t('ui.ps.rs.own')}</span></label>
        {mine !== undefined && <LanguagePicker chosen={mine} label={label} disabled={busy} onToggle={l => toggle(which, l)} />}
      </div>
    );
  };
  return (
    <section className="bt-section" data-research-settings>
      <div className="bt-section__head"><span className="bt-label">{t('ui.ps.rs.title')}</span></div>
      <p className="bt-meta">{t('ui.ps.rs.intro')}</p>
      {select('ui-ps-rs-when', t('ui.set.rs.when'), draft.when ?? '', (['new', 'button', 'off'] as const).map(v => [v, t(WHEN_LABEL[v])]), v => set({ when: v ? v as ResearchOwn['when'] : undefined }))}
      {select('ui-ps-rs-mode', t('ui.set.rs.mode'), draft.mode ?? '', (['auto', 'one_by_one', 'batch'] as const).map(v => [v, t(MODE_LABEL[v])]), v => set({ mode: v ? v as ResearchOwn['mode'] : undefined }))}
      {select('ui-ps-rs-ask', t('ui.set.rs.askLanguage'), draft.askLanguage === undefined ? '' : draft.askLanguage ? 'on' : 'off', [['on', t('ui.ps.rs.on')], ['off', t('ui.ps.rs.off')]], v => set({ askLanguage: v === '' ? undefined : v === 'on' }))}
      {LIMIT_KEYS.map(key => (
        <label key={key} className="bt-form-row">
          <span className="bt-label">{t(LIMIT_LABEL[key][0])}</span>
          <input className="bt-field bt-field--mono bt-field--short" inputMode="numeric" value={limits[key]} placeholder={t('ui.ps.rs.global')} disabled={busy} aria-invalid={readLimit(key, limits[key]) === 'bad'}
            onChange={e => setLimits({ ...limits, [key]: e.target.value })} />
          {readLimit(key, limits[key]) === 'bad' && <span className="bt-meta ui-danger">{t('ui.ps.rs.badNumber', LIMIT_RANGE[key].min, LIMIT_RANGE[key].max)}</span>}
        </label>
      ))}
      {listRow('prefer', t('ui.set.rs.prefer'))}
      {listRow('avoid', t('ui.set.rs.avoid'))}
      {error && <p className="bt-meta ui-danger" role="alert">{error}</p>}
      <div><Button small variant="primary" disabled={busy || !dirty || bad !== undefined} onClick={() => void save()}>{t('ui.ps.rs.save')}</Button></div>
    </section>
  );
}

export function ResearchUsing({ id, revision }: { id: string; revision: number }) {
  const t = useT();
  const [using, setUsing] = useState<Array<{ id: number; name: string; url: string | null; memo: string | null }>>([]);
  useEffect(() => {
    let live = true;
    void api.research(id).then(view => {
      if (!live) return;
      const record = view.products;
      setUsing(record?.status === 'confirmed' ? record.items.filter(item => item.kind === 'similar' && item.decision === 'use').map(item => ({ id: item.id, name: item.name, url: item.url, memo: item.reason })) : []);
    }, () => { if (live) setUsing([]); });
    return () => { live = false; };
  }, [id, revision]);
  if (using.length === 0) return null;
  return (
    <section className="bt-section" aria-label={t('ui.home.rs.using')} data-home="using">
      <div className="bt-section__head"><span className="bt-label">{t('ui.home.rs.using')}</span></div>
      <ul className="bt-list">
        {using.map(item => (
          <li key={item.id} className="bt-row">
            <div className="bt-row__main">
              <span className="bt-row__title">{item.name}</span>
              {item.url && <a className="bt-meta ui-rs__url" href={item.url} target="_blank" rel="noopener noreferrer nofollow">{item.url}</a>}
              {item.memo && <span className="bt-row__sub bt-meta">{item.memo}</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
