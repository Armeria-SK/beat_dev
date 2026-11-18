import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type PersonaView } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { autoLanguage, EXPLAIN_CHOICES, formatNumber, isExplainChoice, LANG_NAME, useT, type ExplainChoice } from '../../i18n/index.ts';
import { accessKey, accessWidening } from '../../settings/access.ts';
import { issueMessage } from '../../settings/model.ts';
import { estimateTokens, overPersonaBudget } from '../../tokens.ts';
import { Button } from '../parts.tsx';
import { RowConfirm } from '../RowConfirm.tsx';
import { applyTheme, browserStorage, readReducedMotion, readTheme, saveReducedMotion, saveTheme, THEMES, type Theme } from '../theme.ts';
import { mergeRawConfig, parseRawConfig } from './commit.ts';
import { CommitField, Group, Row, Seg, Switch, useSet } from './controls.tsx';
import { checkThenRun } from './flow.ts';

const errorText = (error: unknown, fallback: string): string => (error instanceof ApiError ? error.message : fallback);
const HEX = /^#[0-9a-fA-F]{6}$/u;

function DocEditor({ k, title, desc, text, max, onSave }: { k: string; title: string; desc: string; text: string; max: number; onSave: (text: string) => Promise<void> }) {
  const t = useT();
  const ctx = useSet();
  const [value, setValue] = useState(text);
  useEffect(() => { setValue(text); }, [text]);
  const dirty = value !== text;
  const { setDirty } = ctx;
  useEffect(() => { setDirty(k, dirty); }, [setDirty, k, dirty]);
  useEffect(() => () => setDirty(k, false), [setDirty, k]);
  return (
    <Row k={k} title={title} desc={`${desc} · ${t('ui.set.persona.tokens', formatNumber(estimateTokens(value)))}`}
      below={(
        <div className="ui-set__doc">
          <textarea className="bt-doc bt-doc--edit ui-set__editor" aria-label={title} value={value} maxLength={max} spellCheck={false} onChange={e => setValue(e.target.value)} />
          <span className="ui-confirm__buttons">
            <Button small variant="primary" disabled={!dirty || !value.trim() || ctx.busy !== null} onClick={() => void onSave(value)}>{t('ui.set.save')}</Button>
            <Button small variant="ghost" disabled={!dirty} onClick={() => setValue(text)}>{t('ui.set.revert')}</Button>
          </span>
        </div>
      )} />
  );
}

export function PersonaPanel({ onReplay }: { onReplay: () => void }) {
  const t = useT();
  const ctx = useSet();
  const profile = (ctx.config.profile ?? {}) as { name?: string; color?: string };
  const [persona, setPersona] = useState<PersonaView | 'failed' | null>(null);
  const color = useRef<HTMLInputElement>(null);
  useEffect(() => { api.persona().then(setPersona).catch(() => setPersona('failed')); }, []);

  const rename = async (name: string) => {
    if (!name) { ctx.fail('persona:name', t('ui.set.persona.nameEmpty')); return; }
    ctx.setBusy('persona:name'); ctx.clear('persona:name');
    try { await api.onboardingPersona({ botName: name }); await ctx.reload(); ctx.onProfile(); toast({ icon: 'check', title: t('ui.set.persona.renamed') }); }
    catch (error) { ctx.fail('persona:name', errorText(error, t('ui.set.failed'))); }
    finally { ctx.setBusy(null); }
  };
  const paint = async (value: string) => {
    if (!HEX.test(value) || value.toUpperCase() === (profile.color ?? '').toUpperCase()) return;
    ctx.setBusy('persona:color'); ctx.clear('persona:color');
    try { await api.saveProfile({ color: value.toUpperCase() }); await ctx.reload(); ctx.onProfile(); }
    catch (error) { ctx.fail('persona:color', errorText(error, t('ui.set.failed'))); }
    finally { ctx.setBusy(null); }
  };
  useEffect(() => {
    const input = color.current;
    if (!input) return undefined;
    const onChange = () => void paint(input.value);
    input.addEventListener('change', onChange);
    return () => input.removeEventListener('change', onChange);
  });
  const write = async (k: string, patch: { soul?: string; user?: string }) => {
    ctx.setBusy(k); ctx.clear(k);
    try { setPersona(await api.savePersona(patch)); toast({ icon: 'check', title: t('ui.set.persona.saved') }); }
    catch (error) { ctx.fail(k, errorText(error, t('ui.set.failed'))); }
    finally { ctx.setBusy(null); }
  };
  const view = persona !== null && persona !== 'failed' ? persona : null;
  const total = view ? estimateTokens(view.soul) + estimateTokens(view.user) : 0;
  return (
    <>
      <Group title={t('ui.set.persona.agent')}>
        <Row k="persona:name" title={t('ui.set.persona.name')} desc={t('ui.set.persona.nameDesc')}>
          <CommitField value={profile.name ?? ''} label={t('ui.set.persona.name')} onCommit={name => void rename(name)} />
        </Row>
        <Row k="persona:color" title={t('ui.set.persona.color')} desc={t('ui.set.persona.colorDesc')}>
          <input ref={color} type="color" className="ui-set__color" aria-label={t('ui.set.persona.color')} defaultValue={HEX.test(profile.color ?? '') ? profile.color : '#61B8A5'} key={profile.color} disabled={ctx.busy !== null} />
        </Row>
      </Group>
      <Group title={t('ui.set.persona.files')}>
        <p className="bt-meta">{t('ui.set.persona.scope')}</p>
        {persona === null && <p className="bt-meta" role="status">{t('ui.set.loading')}</p>}
        {persona === 'failed' && <p className="bt-meta bt-del" role="alert">{t('ui.set.loadFailed')}</p>}
        {view && (
          <>
            <DocEditor k="persona:soul" title={t('ui.set.persona.soul')} desc={t('ui.set.persona.soulDesc')} text={view.soul} max={view.max} onSave={soul => write('persona:soul', { soul })} />
            <DocEditor k="persona:user" title={t('ui.set.persona.user')} desc={t('ui.set.persona.userDesc')} text={view.user} max={view.max} onSave={user => write('persona:user', { user })} />
            {overPersonaBudget(total, view.budget) && view.budget !== null && <p className="bt-meta bt-del" role="status">{t('ui.set.persona.over', formatNumber(total), formatNumber(view.budget))}</p>}
          </>
        )}
      </Group>
      <Group title={t('ui.set.persona.setup')}>
        <Row k="persona:replay" title={t('ui.set.persona.replay')} desc={t('ui.set.persona.replayDesc')}>
          <Button small onClick={onReplay}>{t('ui.set.persona.replayShort')}</Button>
        </Row>
      </Group>
    </>
  );
}

const THEME_NAME: Record<Theme, 'ui.set.theme.light' | 'ui.set.theme.dusk' | 'ui.set.theme.sand' | 'ui.set.theme.mist' | 'ui.set.theme.moss' | 'ui.set.theme.ember'> = {
  light: 'ui.set.theme.light', dusk: 'ui.set.theme.dusk', sand: 'ui.set.theme.sand', mist: 'ui.set.theme.mist', moss: 'ui.set.theme.moss', ember: 'ui.set.theme.ember',
};

export function AppearancePanel() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(() => readTheme(browserStorage()));
  const [reduced, setReduced] = useState(() => readReducedMotion(browserStorage()));
  const pick = (next: Theme) => { applyTheme(document.documentElement, next); saveTheme(browserStorage(), next); setTheme(next); };
  const reduce = (on: boolean) => { document.body.classList.toggle('is-reduced', on); saveReducedMotion(browserStorage(), on); setReduced(on); };
  const ctx = useSet();
  const saved: unknown = ctx.config.ui?.explainLanguage;
  const explain: ExplainChoice = isExplainChoice(saved) ? saved : 'auto';
  const explainOptions = EXPLAIN_CHOICES.map(value => ({ value, label: value === 'auto' ? t('ui.set.look.explainAuto', LANG_NAME[autoLanguage()]) : LANG_NAME[value] }));
  return (
    <>
      <Group title={t('ui.set.look.language')}>
        <Row k="look:explain" title={t('ui.set.look.explain')} desc={t('ui.set.look.explainDesc')}>
          <Seg value={explain} options={explainOptions} label={t('ui.set.look.explain')} disabled={ctx.busy !== null}
            onChange={next => void ctx.commit('look:explain', c => ({ ...c, ui: { ...c.ui, explainLanguage: next } }))} />
        </Row>
      </Group>
      <Group title={t('ui.set.look.theme')}>
        <div className="bt-themes" role="group" aria-label={t('ui.set.look.theme')}>
          {THEMES.map(id => (
            <button key={id} type="button" className="bt-theme" aria-pressed={theme === id} data-set-theme={id} onClick={() => pick(id)}>
              <span className="bt-theme__swatch" data-theme={id}><i /><i /><i /></span>
              <span className="bt-theme__name">{t(THEME_NAME[id])}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group title={t('ui.set.look.behaviour')}>
        <Row k="look:reduce" title={t('ui.set.look.reduce')} desc={t('ui.set.look.reduceDesc')}>
          <Switch checked={reduced} label={t('ui.set.look.reduce')} onChange={reduce} />
        </Row>
      </Group>
    </>
  );
}

export function AdvancedPanel() {
  const t = useT();
  const ctx = useSet();
  const [text, setText] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const { setDirty } = ctx;
  useEffect(() => { setDirty('adv:file', text !== null && text !== loaded); }, [setDirty, text, loaded]);
  useEffect(() => () => setDirty('adv:file', false), [setDirty]);
  const open = async () => {
    ctx.clear('adv:file');
    try { const fresh = JSON.stringify((await api.settings()).config, null, 2); setText(fresh); setLoaded(fresh); setBad(false); }
    catch (error) { ctx.fail('adv:file', errorText(error, t('ui.set.loadFailed'))); }
  };
  const save = async () => {
    if (text === null) return;
    const parsed = parseRawConfig(text);
    if (!parsed) { setBad(true); return; }
    setBad(false);
    const base = loaded === null ? null : parseRawConfig(loaded);
    if (!base) return;
    let conflicts: string[] = [];
    const saved = await ctx.commit('adv:file', latest => {
      const merged = mergeRawConfig(base, parsed, latest);
      conflicts = merged.conflicts;
      return merged.config;
    });
    if (conflicts.length > 0) { ctx.fail('adv:file', t('ui.set.adv.conflict', conflicts.join(', '))); return; }
    if (saved) { toast({ icon: 'check', title: t('ui.set.adv.saved') }); await open(); }
  };
  const [resetting, setResetting] = useState(false);
  const [backup, setBackup] = useState<string | null>(null);
  const reset = async () => {
    setResetting(false); ctx.clear('adv:reset');
    const run = async (signal: AbortSignal): Promise<boolean> => {
      ctx.setBusy('adv:reset');
      try {
        const done = await api.resetSettings(signal);
        setBackup(done.backup); setText(null);
        await ctx.reload(); ctx.onProfile();
        toast({ icon: 'check', title: t('ui.set.adv.resetDone') });
        return true;
      } catch (error) { ctx.fail('adv:reset', errorText(error, t('ui.set.adv.resetFailed'))); return false; }
      finally { ctx.setBusy(null); }
    };
    try {
      await checkThenRun(ctx.queue, async signal => {
        const [latest, preview] = await Promise.all([api.settings(signal), api.resetPreview(signal)]);
        return accessWidening(latest.config, preview.config);
      }, accessKey, (items, go) => ctx.ask({ row: 'adv:reset', items: [...items], title: t('ui.set.adv.resetWiden'), ok: t('ui.set.adv.reset') }, go), run);
    } catch (error) { ctx.fail('adv:reset', errorText(error, t('ui.set.adv.resetFailed'))); }
  };
  const broken = ctx.view.configError;
  return (
    <Group title={t('ui.set.adv.file')}>
      {broken && (
        <div className="bt-notice bt-notice--fail" role="alert">
          <div className="bt-notice__body"><strong>{t('ui.set.adv.broken')}</strong>
            <p>{(broken.issues?.length ? broken.issues.map(i => `${i.path ? `${i.path}: ` : ''}${issueMessage(i)}`) : broken.problems).join(' · ')}</p></div>
        </div>
      )}
      <Row k="adv:file" title={t('ui.set.adv.everything')} desc={<code className="bt-meta">{ctx.view.configPath}</code>}
        below={text !== null && (
          <div className="ui-set__doc">
            <textarea className="bt-doc bt-doc--edit ui-set__editor ui-set__editor--tall" aria-label={t('ui.set.adv.editor')} aria-invalid={bad || undefined} value={text} spellCheck={false}
              onChange={e => { setText(e.target.value); setBad(false); }} />
            {bad && <p className="bt-meta bt-del" role="alert">{t('ui.set.adv.parse')}</p>}
            <span className="ui-confirm__buttons">
              <Button small variant="primary" disabled={ctx.busy !== null} onClick={() => void save()}>{t('ui.set.save')}</Button>
              <Button small variant="ghost" disabled={ctx.busy !== null} onClick={() => void open()}>{t('ui.set.revert')}</Button>
              <Button small variant="ghost" onClick={() => ctx.guard(() => { setText(null); ctx.cancel(); })}>{t('ui.close')}</Button>
            </span>
          </div>
        )}>
        {text === null && <Button small onClick={() => void open()}>{t('ui.set.adv.open')}</Button>}
      </Row>
      <Row k="adv:reset" title={t('ui.set.adv.reset')} desc={t('ui.set.adv.resetDesc')}
        below={(resetting || backup) && (
          <>
            {resetting && <RowConfirm warn={t('ui.set.adv.resetWarn')} note={t('ui.set.adv.resetNote')} action={t('ui.set.adv.reset')} busy={ctx.busy !== null} onConfirm={() => void reset()} onKeep={() => setResetting(false)} />}
            {backup && <p className="bt-meta" role="status">{t('ui.set.adv.resetBackup', backup)}</p>}
          </>
        )}>
        {!resetting && <Button small variant="danger" disabled={ctx.busy !== null} onClick={() => setResetting(true)}>{t('ui.set.adv.reset')}</Button>}
      </Row>
    </Group>
  );
}
