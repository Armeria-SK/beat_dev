import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiError, type Probe, type Profile, type RuntimeView } from '../api.ts';
import { useT } from '../i18n/index.ts';
import { isComposing } from '../keys.ts';
import { dropListed, keyEnvOf, plannedProviderId, runtimeIdOf, setupModelConfig, setupRuntimeConfig, turnOnRuntime, type RuntimeKindId } from '../onboarding.ts';
import { accessKey, accessWidening, keyEntryAccess, type Access } from '../settings/access.ts';
import { applyEdits, deepEqual, diffConfig } from '../settings/merge.ts';
import type { Config } from '../settings/model.ts';
import type { AgentState } from './agent-state.ts';
import {
  agentInput, canContinue, connectProblem, emptyConnect, escapeAction, listPlan, modelFormOf, nameInput, ONBOARD_STEPS, PROVIDERS, REACHABLE, styleInput, STYLES,
  type ConnectForm, type StyleId,
} from './onboarding-steps.ts';
import { Avatar, Button, Pill } from './parts.tsx';
import { Widen } from './settings/controls.tsx';
import { NAME as RUNTIME_NAME, pillOf, stateLine, type RuntimePill } from './settings/runtimes.tsx';

type Json = Record<string, any>;

const errorText = (error: unknown, fallback: string): string => (error instanceof ApiError ? error.message : fallback);
const HEX = /^#[0-9a-fA-F]{6}$/u;

const PREVIEW_LABEL = { idle: 'ui.ob.agent.idle', working: 'ui.ob.agent.working', waiting: 'ui.ob.agent.waiting' } as const;
const PROVIDER_LABEL = { anthropic: 'ui.ob.model.anthropic', openai: 'ui.ob.model.openai', custom: 'ui.ob.model.custom', runtime: 'ui.ob.model.runtime' } as const;
const RUNTIME_KINDS = ['claude-code', 'codex'] as const satisfies readonly RuntimeKindId[];
const RUNTIME_PILL = { off: 'ui.set.runtime.pillOff', unchecked: 'ui.set.runtime.pillUnchecked', ready: 'ui.set.runtime.pillReady', missing: 'ui.set.runtime.pillMissing', signedOut: 'ui.set.runtime.pillSignedOut', blocked: 'ui.set.runtime.pillBlocked' } as const satisfies Record<RuntimePill, string>;
const RUNTIME_PILL_TONE = { off: undefined, unchecked: 'warn', ready: 'ok', missing: 'danger', signedOut: 'danger', blocked: 'warn' } as const;
const SIGN_IN = { 'claude-code': 'ui.set.runtime.signInClaudeDesc', codex: 'ui.set.runtime.signInCodexDesc' } as const;
const PROBLEM_TEXT = { model: 'ui.ob.model.problem.model', baseUrl: 'ui.ob.model.problem.baseUrl', context: 'ui.ob.model.problem.context', key: 'ui.ob.model.problem.key', runtimeModel: 'ui.ob.model.problem.runtimeModel' } as const;
const STYLE_TEXT = {
  calm: ['ui.ob.style.calm', 'ui.ob.style.calm.example'], friendly: ['ui.ob.style.friendly', 'ui.ob.style.friendly.example'],
  direct: ['ui.ob.style.direct', 'ui.ob.style.direct.example'], none: ['ui.ob.style.none', 'ui.ob.style.none.example'],
} as const;

export interface OnboardingProps { profile: Profile | null; replay: boolean; start: number; onProfile: () => void; onDone: () => void; onSkip: () => void }

export function Onboarding({ profile, replay, start, onProfile, onDone, onSkip }: OnboardingProps) {
  const t = useT();
  const [index, setIndex] = useState(start);
  const step = ONBOARD_STEPS[index]!;
  const [name, setName] = useState('');
  const [agent, setAgent] = useState(profile?.name ?? 'beat');
  const [color, setColor] = useState(profile?.color && HEX.test(profile.color) ? profile.color : '#61B8A5');
  const [preview, setPreview] = useState<AgentState>('idle');
  const [style, setStyle] = useState<StyleId | null>(null);
  const [form, setForm] = useState<ConnectForm>(emptyConnect());
  const [keySet, setKeySet] = useState(false);
  const [modelId, setModelId] = useState<string | null>(null);
  const [result, setResult] = useState<Probe | null>(null);
  const [runtimeKind, setRuntimeKind] = useState<RuntimeKindId>('claude-code');
  const [runtimeView, setRuntimeView] = useState<RuntimeView | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [problem, setProblem] = useState<keyof typeof PROBLEM_TEXT | null>(null);
  const [widen, setWiden] = useState<{ items: Access[]; key: string; list?: boolean } | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [listNote, setListNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const listed = useRef(new Set<string>());
  const keyed = useRef(new Set<string>());

  async function saveTidy(latest: Config, next: Config) {
    if (deepEqual(next, latest)) return;
    const edits = diffConfig(latest, next);
    const merged = async (): Promise<Config> => {
      const { config, conflicts } = applyEdits((await api.settings()).config, edits);
      if (conflicts.length > 0) throw new Error('settings changed elsewhere');
      return config;
    };
    let target = await merged();
    const gone = (latest.providers as Json[]).filter(p => !(target.providers as Json[]).some(q => q.id === p.id));
    const stillRead = (p: Json): boolean => { const env = keyEnvOf(p); return env !== undefined && (target.providers as Json[]).some(q => keyEnvOf(q) === env); };
    const owed = gone.filter(p => keyed.current.has(p.id) && !stillRead(p));
    if (owed.length > 0) {
      for (const p of owed) await api.deleteProviderKey(p.id).catch(() => undefined);
      target = await merged();
    }
    await api.saveSettings(target);
    for (const p of gone) { listed.current.delete(p.id); keyed.current.delete(p.id); }
  }

  useEffect(() => { box.current?.querySelector<HTMLElement>('.bt-onboard__step.is-current input, .bt-onboard__step.is-current button, [data-next]')?.focus(); }, [index]);
  useEffect(() => {
    if (step !== 'model') return;
    let live = true;
    void Promise.all([api.settings(), api.models()]).then(([s, m]) => {
      if (!live) return;
      const planned = form.provider === 'custom' || form.provider === 'runtime' ? null : plannedProviderId(s.config, modelFormOf(form), modelId);
      if (planned) api.providerKey(planned).then(k => { if (live) setKeySet(k.set); }).catch(() => undefined);
      else setKeySet(false);
      const ok = m.models.find(x => x.probe && REACHABLE.has(x.probe.status));
      setExisting(ok ? (ok.label || ok.id) : null);
    }).catch(() => undefined);
    return () => { live = false; };
  }, [step, form.provider]);

  useEffect(() => () => {
    if (listed.current.size === 0) return;
    void api.settings().then(s => saveTidy(s.config, dropListed(s.config, listed.current, null))).catch(() => undefined);
  }, []);

  useEffect(() => {
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const action = escapeAction({ busy, confirming: widen !== null });
      if (action !== 'close') e.preventDefault();
      if (action === 'cancelConfirm') setWiden(null);
    };
    addEventListener('keydown', onEscape, true);
    return () => removeEventListener('keydown', onEscape, true);
  }, [busy, widen]);

  const runtimePassed = form.provider === 'runtime' && runtimeView !== null && runtimeView.kind === runtimeKind && runtimeView.enabled && runtimeView.check?.usable === true;
  const passed = runtimePassed || (form.provider !== 'runtime' && ((result !== null && REACHABLE.has(result.status)) || (existing !== null && result === null)));
  const ready = canContinue(step, { name, agent, style, passed });

  async function next() {
    if (!ready || busy) return;
    setBusy(true); setError(null);
    try {
      if (step === 'name') await api.onboardingPersona(nameInput(name));
      if (step === 'agent') {
        const input = agentInput(agent, profile?.name ?? '');
        if (Object.keys(input).length) await api.onboardingPersona(input);
        if (color.toUpperCase() !== (profile?.color ?? '').toUpperCase()) await api.saveProfile({ color: color.toUpperCase() });
        onProfile();
      }
      if (step === 'style') { const input = styleInput(style); if (Object.keys(input).length) await api.onboardingPersona(input); }
      if (step === 'hello') { await api.onboardingDone(); onDone(); return; }
      setIndex(index + 1);
    } catch (failure) { setError(errorText(failure, t('ui.ob.failed'))); }
    finally { setBusy(false); }
  }

  // 実行役: 入れる・モデルを足す・会話の順番の先頭に置く（提供元のモデルが無いとき）を保存してから、持ち主が押した確かめを 1 回だけ起こす
  async function testRuntime() {
    const found = connectProblem(form, keySet);
    setProblem(found); setRuntimeView(null);
    if (found) return;
    if (names.length > 0 && !names.includes(form.model.trim())) { setProblem('runtimeModel'); return; }
    setBusy(true); setError(null);
    try {
      const latest = (await api.settings()).config;
      const built = setupRuntimeConfig(latest, { kind: runtimeKind, model: form.model });
      await saveTidy(latest, built.config);
      setRuntimeView(await api.checkRuntime(built.runtimeId));
    } catch (failure) { setError(errorText(failure, t('ui.ob.model.failed'))); }
    finally { setBusy(false); }
  }

  async function listRuntime() {
    setBusy(true); setError(null); setListNote(null);
    try {
      const latest = (await api.settings()).config;
      await saveTidy(latest, turnOnRuntime(latest, runtimeKind));
      const view = await api.loadRuntimeModels(runtimeIdOf(latest, runtimeKind));
      const got = view.models ?? [];
      setNames(got.map(m => m.id)); setListNote(t('ui.set.model.listed', got.length));
    } catch (failure) { setNames([]); setListNote(errorText(failure, t('ui.set.model.listFailed'))); }
    finally { setBusy(false); }
  }

  async function test(confirmed: string | null = null) {
    if (form.provider === 'runtime') return testRuntime();
    const found = connectProblem(form, keySet);
    setProblem(found); setResult(null);
    if (found) return;
    setBusy(true); setError(null); setWiden(null);
    try {
      const latest = (await api.settings()).config;
      const built = setupModelConfig(latest, modelFormOf(form), modelId);
      const providerId = ((built.config.models as Json[]).find(m => m.id === built.modelId)?.provider ?? '') as string;
      const provider = (built.config.providers as Json[]).find(p => p.id === providerId);
      const items = [...accessWidening(latest, built.config), ...(form.key.trim() && provider ? keyEntryAccess(provider) : [])];
      if (items.length > 0 && accessKey(items) !== confirmed) { setWiden({ items, key: accessKey(items) }); return; }
      await saveTidy(latest, dropListed(built.config, listed.current, providerId));
      setModelId(built.modelId);
      if (form.key.trim()) {
        await api.setProviderKey(providerId, form.key.trim());
        keyed.current.add(providerId);
        setForm(old => ({ ...old, key: '' }));
        setKeySet(true);
      }
      const probed = await api.probe();
      setResult(probed.models.find(m => m.id === built.modelId)?.probe ?? { modelId: built.modelId, status: 'unknown', server: '', required: 0, message: '', checkedAt: Date.now() });
    } catch (failure) { setError(errorText(failure, t('ui.ob.model.failed'))); }
    finally { setBusy(false); }
  }

  async function list(confirmed: string | null = null) {
    if (form.provider === 'runtime') return listRuntime();
    const found = connectProblem({ ...form, model: '-', context: '32768' }, keySet);
    setProblem(found);
    if (found) return;
    setBusy(true); setError(null); setWiden(null); setListNote(null);
    try {
      const latest = (await api.settings()).config;
      const built = listPlan(latest, form, modelId);
      const items = built.items;
      if (items.length > 0 && accessKey(items) !== confirmed) { setWiden({ items, key: accessKey(items), list: true }); return; }
      await saveTidy(latest, dropListed(built.config, listed.current, built.providerId));
      if (!(latest.providers as Json[]).some(p => p.id === built.providerId)) listed.current.add(built.providerId);
      if (form.key.trim()) {
        await api.setProviderKey(built.providerId, form.key.trim());
        keyed.current.add(built.providerId);
        setForm(old => ({ ...old, key: '' }));
        setKeySet(true);
      }
      const got = await api.providerModels(built.providerId);
      setNames(got.models); setListNote(t(got.truncated ? 'ui.set.model.listedFirst' : 'ui.set.model.listed', got.models.length));
    } catch (failure) { setNames([]); setListNote(errorText(failure, t('ui.set.model.listFailed'))); }
    finally { setBusy(false); }
  }

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) return;
    const target = e.target as HTMLElement;
    if (target.closest('button, textarea, .ui-confirm')) return;
    if (step === 'model' && !passed) { e.preventDefault(); void test(); return; }
    e.preventDefault();
    void next();
  };

  const pill = result && (REACHABLE.has(result.status)
    ? <Pill tone="ok">{t('ui.set.reach.ok')}</Pill>
    : <Pill tone={result.status === 'unreachable' ? 'warn' : 'danger'}>{result.status === 'unreachable' ? t('ui.set.reach.offline') : result.status === 'no_api_key' ? t('ui.ob.model.rejectedKey') : t('ui.set.reach.rejected')}</Pill>);

  const runtimeShown = runtimeView ? pillOf(runtimeView) : null;
  const runtimePill = runtimeShown && <Pill {...(RUNTIME_PILL_TONE[runtimeShown] ? { tone: RUNTIME_PILL_TONE[runtimeShown] } : {})}>{t(RUNTIME_PILL[runtimeShown])}</Pill>;

  const stepClass = (id: typeof ONBOARD_STEPS[number]) => `bt-onboard__step${id === step ? ' is-current' : ''}`;
  return (
    <div className="ui-onboard" role="dialog" aria-modal="true" aria-label={t('ui.ob.title')} onKeyDown={onKey}>
      <main className="bt-onboard">
        <div className="bt-onboard__inner" ref={box}>
          <div className="bt-steps" aria-hidden="true">
            {ONBOARD_STEPS.map((id, i) => <span key={id} className={`bt-steps__seg${i < index ? ' is-done' : i === index ? ' is-current' : ''}`} />)}
          </div>
          <span className="bt-label">{t('ui.ob.step', index + 1, ONBOARD_STEPS.length)}</span>

          {step === 'name' && (
            <section className={stepClass('name')}>
              <h1 className="bt-screen__title bt-screen__title--xl">{t('ui.ob.name.title')}</h1>
              <label className="bt-form-row"><span className="bt-label">{t('ui.ob.name.label')}</span>
                <input className="bt-field" value={name} maxLength={80} autoComplete="off" onChange={e => setName(e.target.value)} /></label>
              <p className="bt-meta ui-ob__meta">{t('ui.ob.name.note')}</p>
            </section>
          )}

          {step === 'agent' && (
            <section className={stepClass('agent')}>
              <div className="ui-ob__agent">
                <Avatar state={preview} size="lg" color={color} />
                <h1 className="bt-screen__title bt-screen__title--xl">{t('ui.ob.agent.title')}</h1>
              </div>
              <label className="bt-form-row"><span className="bt-label">{t('ui.ob.agent.label')}</span>
                <input className="bt-field" value={agent} maxLength={40} autoComplete="off" onChange={e => setAgent(e.target.value)} /></label>
              <div className="bt-form-row"><span className="bt-label">{t('ui.ob.agent.preview')}</span>
                <div><div className="bt-seg" role="group" aria-label={t('ui.ob.agent.preview')}>
                  {(['idle', 'working', 'waiting'] as const).map(s => <button key={s} type="button" className="bt-seg__opt" aria-pressed={preview === s} onClick={() => setPreview(s)}>{t(PREVIEW_LABEL[s])}</button>)}
                </div></div></div>
              <label className="bt-form-row"><span className="bt-label">{t('ui.ob.agent.color')}</span>
                <input type="color" className="ui-set__color" value={color} onChange={e => setColor(e.target.value)} /></label>
              <p className="bt-meta ui-ob__meta">{t('ui.ob.noProduct')}</p>
            </section>
          )}

          {step === 'style' && (
            <section className={stepClass('style')}>
              <h1 className="bt-screen__title bt-screen__title--xl">{t('ui.ob.style.title')}</h1>
              <fieldset className="bt-choices">
                {STYLES.map(id => (
                  <label key={id} className="bt-choice"><input type="radio" name="ui-ob-style" checked={style === id} onChange={() => setStyle(id)} />
                    <span>{t(STYLE_TEXT[id][0])}</span><span className="bt-meta bt-choice__tag">{t(STYLE_TEXT[id][1])}</span></label>
                ))}
              </fieldset>
              <p className="bt-meta ui-ob__meta">{t('ui.ob.noProduct')}</p>
            </section>
          )}

          {step === 'model' && (
            <section className={stepClass('model')}>
              <h1 className="bt-screen__title bt-screen__title--xl">{t('ui.ob.model.title')}</h1>
              <div className="bt-form-row"><span className="bt-label">{t('ui.ob.model.provider')}</span>
                <div><div className="bt-seg" role="group" aria-label={t('ui.ob.model.provider')}>
                  {PROVIDERS.map(p => <button key={p} type="button" className="bt-seg__opt" aria-pressed={form.provider === p}
                    onClick={() => { setForm(emptyConnect(p)); setModelId(null); setResult(null); setRuntimeView(null); setProblem(null); setWiden(null); setNames([]); setListNote(null); }}>{t(PROVIDER_LABEL[p])}</button>)}
                </div></div></div>
              {form.provider === 'runtime' && (
                <div className="bt-form-row"><span className="bt-label">{t('ui.ob.model.runtimeKind')}</span>
                  <div><div className="bt-seg" role="group" aria-label={t('ui.ob.model.runtimeKind')}>
                    {RUNTIME_KINDS.map(kind => <button key={kind} type="button" className="bt-seg__opt" aria-pressed={runtimeKind === kind}
                      onClick={() => { setRuntimeKind(kind); setRuntimeView(null); setNames([]); setListNote(null); }}>{t(RUNTIME_NAME[kind])}</button>)}
                  </div></div></div>
              )}
              <label className="bt-form-row"><span className="bt-label">{t('ui.ob.model.name')}</span>
                <input className="bt-field bt-field--mono" value={form.model} placeholder={t('ui.ob.model.namePh')} spellCheck={false} autoComplete="off" aria-invalid={problem === 'model' || problem === 'runtimeModel' || undefined} list="ui-ob-model-names"
                  onChange={e => { setForm({ ...form, model: e.target.value }); setResult(null); setRuntimeView(null); }} /></label>
              <datalist id="ui-ob-model-names">{names.map(n => <option key={n} value={n} />)}</datalist>
              {form.provider === 'custom' && (
                <label className="bt-form-row"><span className="bt-label">{t('ui.ob.model.url')}</span>
                  <input className="bt-field bt-field--mono" value={form.baseUrl} spellCheck={false} autoComplete="off" aria-invalid={problem === 'baseUrl' || undefined}
                    onChange={e => { setForm({ ...form, baseUrl: e.target.value }); setResult(null); setNames([]); setListNote(null); }} /></label>
              )}
              {form.provider !== 'anthropic' && form.provider !== 'runtime' && (
                <label className="bt-form-row"><span className="bt-label">{t('ui.ob.model.context')}</span>
                  <input className="bt-field bt-field--mono bt-field--short" inputMode="numeric" value={form.context} spellCheck={false} autoComplete="off" aria-invalid={problem === 'context' || undefined}
                    onChange={e => { setForm({ ...form, context: e.target.value }); setResult(null); }} /></label>
              )}
              {form.provider !== 'runtime' && <label className="bt-form-row"><span className="bt-label">{form.provider === 'custom' ? t('ui.ob.model.keyOptional') : t('ui.ob.model.key')}</span>
                <input className="bt-field bt-field--mono" type="password" value={form.key} placeholder={keySet ? t('ui.ob.model.keySet') : t('ui.set.key.paste')} autoComplete="new-password" spellCheck={false} aria-invalid={problem === 'key' || undefined}
                  onChange={e => { setForm({ ...form, key: e.target.value }); setResult(null); }} /></label>}
              {form.provider === 'runtime' && <p className="bt-meta" data-runtime-onboarding>{t('ui.ob.model.runtimeNote')}</p>}
              {problem && <p className="bt-meta bt-del" role="alert">{t(PROBLEM_TEXT[problem])}</p>}
              <div className="ui-ob__test">
                <Button disabled={busy} onClick={() => void test()}>{t('ui.ob.model.test')}</Button>
                <Button variant="ghost" disabled={busy} onClick={() => void list()}>{t('ui.ob.model.list')}</Button>
                {form.provider === 'runtime' ? runtimePill : pill}
                {form.provider !== 'runtime' && !result && existing && <span className="bt-meta">{t('ui.ob.model.existing', existing)}</span>}
              </div>
              {form.provider === 'runtime' && runtimeView && (
                <>
                  <p className="bt-meta" data-runtime-state>{stateLine(t, runtimeView)}</p>
                  {['missing', 'signedOut'].includes(pillOf(runtimeView)) && <p className="bt-meta" data-runtime-signin>{t(SIGN_IN[runtimeView.kind])}</p>}
                  {runtimePassed && names.length === 0 && <p className="bt-meta" data-runtime-untested>{t('ui.ob.model.runtimeUntested')}</p>}
                </>
              )}
              {result && !REACHABLE.has(result.status) && result.message && <p className="bt-meta">{result.message}</p>}
              {listNote && <p className="bt-meta" role="status">{listNote}</p>}
              {widen && <Widen pending={{ row: 'ob:model', items: widen.items, title: t('ui.ob.model.widen'), run: () => void (widen.list ? list(widen.key) : test(widen.key)) }} busy={busy} onCancel={() => setWiden(null)} />}
            </section>
          )}

          {step === 'hello' && (
            <section className={stepClass('hello')}>
              <div><Avatar state="waiting" size="lg" /></div>
              <h1 className="bt-screen__title bt-screen__title--xl">{t('ui.ob.hello.title', name.trim() || t('ui.ob.hello.there'))}</h1>
              <p className="bt-meta ui-ob__meta">{t('ui.ob.hello.meta')}</p>
            </section>
          )}

          {error && <p className="bt-meta bt-del" role="alert">{error}</p>}
          <div className="ui-ob__nav">
            <Button variant="ghost" disabled={index === 0 || busy} onClick={() => { setError(null); setIndex(index - 1); }}>{t('ui.ob.back')}</Button>
            <span className="ui-ob__fill" />
            {!replay && <Button variant="ghost" disabled={busy} onClick={onSkip}>{t('ui.ob.skip')}</Button>}
            <Button variant="primary" data-next disabled={!ready || busy} onClick={() => void next()}>{step === 'hello' ? t('ui.product.new') : t('ui.ob.continue')}</Button>
          </div>
          <p className="bt-meta ui-ob__meta">{t(replay ? 'ui.ob.replayNote' : 'ui.ob.skipNote')}</p>
        </div>
      </main>
    </div>
  );
}
