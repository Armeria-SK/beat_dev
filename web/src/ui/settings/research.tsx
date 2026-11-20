import type { ResearchLanguageName } from '../../api.ts';
import { useT } from '../../i18n/index.ts';
import { LIMIT_KEYS, LIMIT_RANGE, RESEARCH_LANGUAGE_LIST, researchModel, setResearch, setResearchModel, toggleLanguage } from '../research.ts';
import '../styles/research.css';
import { Group, NumberField, Row, Seg, Select, Switch, useSet, type Option } from './controls.tsx';

type Json = Record<string, any>;

export const WHEN_LABEL = { new: 'ui.set.rs.when.new', button: 'ui.set.rs.when.button', off: 'ui.set.rs.when.off' } as const;
export const MODE_LABEL = { auto: 'ui.set.rs.mode.auto', one_by_one: 'ui.set.rs.mode.one_by_one', batch: 'ui.set.rs.mode.batch' } as const;
export const LIMIT_LABEL = {
  candidates: ['ui.set.rs.candidates', 'ui.set.rs.candidatesDesc'], searches: ['ui.set.rs.searches', 'ui.set.rs.searchesDesc'],
  fetches: ['ui.set.rs.fetches', 'ui.set.rs.fetchesDesc'], minutes: ['ui.set.rs.minutes', 'ui.set.rs.minutesDesc'],
} as const;

export function LanguagePicker({ chosen, label, disabled, onToggle }: { chosen: readonly ResearchLanguageName[]; label: string; disabled?: boolean; onToggle: (language: ResearchLanguageName) => void }) {
  return (
    <div className="ui-rs__langs" role="group" aria-label={label}>
      {RESEARCH_LANGUAGE_LIST.map(language => (
        <button key={language} type="button" className="bt-btn bt-btn--sm ui-rs__lang" aria-pressed={chosen.includes(language)} disabled={disabled} onClick={() => onToggle(language)}>{language}</button>
      ))}
    </div>
  );
}

export function ResearchPanel() {
  const t = useT();
  const ctx = useSet();
  const research = (ctx.config.research ?? {}) as Json;
  const limits = (research.limits ?? {}) as Json;
  const prefer = (research.preferLanguages ?? []) as ResearchLanguageName[];
  const avoid = (research.avoidLanguages ?? []) as ResearchLanguageName[];
  const busy = ctx.busy !== null;
  const set = (row: string, patch: Json) => void ctx.commit(row, c => setResearch(c, patch));
  const models = (ctx.config.models ?? []) as Json[];
  const modelOptions: Option<string>[] = [{ value: '', label: t('ui.set.rs.modelSame') }, ...models.map(m => ({ value: m.id as string, label: (m.label as string) || (m.id as string) }))];
  const toggle = (row: string, which: 'prefer' | 'avoid', language: ResearchLanguageName) => {
    const next = toggleLanguage({ prefer, avoid }, which, language);
    set(row, { preferLanguages: next.prefer.length ? next.prefer : undefined, avoidLanguages: next.avoid.length ? next.avoid : undefined });
  };
  return (
    <Group title={t('ui.set.rs.title')}>
      <Row k="rs:when" title={t('ui.set.rs.when')} desc={t('ui.set.rs.whenDesc')}>
        <Seg value={(research.when ?? 'new') as keyof typeof WHEN_LABEL} options={(['new', 'button', 'off'] as const).map(v => ({ value: v, label: t(WHEN_LABEL[v]) }))} label={t('ui.set.rs.when')} disabled={busy} onChange={when => set('rs:when', { when })} />
      </Row>
      <Row k="rs:mode" title={t('ui.set.rs.mode')} desc={t('ui.set.rs.modeDesc')}>
        <Seg value={(research.mode ?? 'auto') as keyof typeof MODE_LABEL} options={(['auto', 'one_by_one', 'batch'] as const).map(v => ({ value: v, label: t(MODE_LABEL[v]) }))} label={t('ui.set.rs.mode')} disabled={busy} onChange={mode => set('rs:mode', { mode })} />
      </Row>
      <Row k="rs:model" title={t('ui.set.rs.model')} desc={t('ui.set.rs.modelDesc')}>
        <Select value={researchModel(ctx.config)} options={modelOptions} label={t('ui.set.rs.model')} disabled={busy} onChange={id => void ctx.commit('rs:model', c => setResearchModel(c, id))} />
      </Row>
      {LIMIT_KEYS.map(key => (
        <Row key={key} k={`rs:${key}`} title={t(LIMIT_LABEL[key][0])} desc={t(LIMIT_LABEL[key][1])}>
          <NumberField k={`rs:${key}`} value={limits[key] as number | undefined} min={LIMIT_RANGE[key].min} max={LIMIT_RANGE[key].max} optional placeholder={String(LIMIT_RANGE[key].default)} label={t(LIMIT_LABEL[key][0])}
            onCommit={v => set(`rs:${key}`, { limits: { [key]: v } })} />
        </Row>
      ))}
      <Row k="rs:askLanguage" title={t('ui.set.rs.askLanguage')} desc={t('ui.set.rs.askLanguageDesc')}>
        <Switch checked={research.askLanguage !== false} label={t('ui.set.rs.askLanguage')} disabled={busy} onChange={askLanguage => set('rs:askLanguage', { askLanguage })} />
      </Row>
      <Row k="rs:prefer" title={t('ui.set.rs.prefer')} desc={t('ui.set.rs.preferDesc')} below={<LanguagePicker chosen={prefer} label={t('ui.set.rs.prefer')} disabled={busy} onToggle={l => toggle('rs:prefer', 'prefer', l)} />} />
      <Row k="rs:avoid" title={t('ui.set.rs.avoid')} desc={t('ui.set.rs.avoidDesc')} below={<LanguagePicker chosen={avoid} label={t('ui.set.rs.avoid')} disabled={busy} onToggle={l => toggle('rs:avoid', 'avoid', l)} />} />
      <Row k="rs:columns" title={t('ui.set.rs.columns')} desc={t('ui.set.rs.columnsDesc')} />
    </Group>
  );
}
