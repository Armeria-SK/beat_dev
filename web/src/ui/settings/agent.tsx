import { useEffect, useState } from 'react';
import { api, ApiError, type ProviderKeyState } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatNumber, formatRelative, getLanguage, useT } from '../../i18n/index.ts';
import { isComposing } from '../../keys.ts';
import { probeMessage, serverText } from '../../server-text.ts';
import type { Access } from '../../settings/access.ts';
import { slugId, uniqueSlug } from '../../settings/ids.ts';
import {
  addModel, keyEnvEdit, keyEnvUnsafe, newAnthropicProvider, openAfterRename, providerInUse, removeModel, removeProvider, renameModel, renameProvider, secondsOf, trimKey, uniqueId, updateAt, updateListItem, type Config,
} from '../../settings/model.ts';
import { toolCounts } from '../library.ts';
import { Button, Pill, type PillTone } from '../parts.tsx';
import { RowConfirm } from '../RowConfirm.tsx';
import { OPENAI_URL } from '../onboarding-steps.ts';
import { planKeyFor } from './commit.ts';
import { CommitField, Group, ListField, NumberField, Row, Seg, Select, Switch, useSet, type Option } from './controls.tsx';
import { JUDGE_OFF, judgeBackups, judgeChoice, judgeIsOff, keyLine, lastChecked, modelReach, moveItem, providerReach, rolesOf, setConversation, setFallback, setJudge, type ModelReach } from './view.ts';

type Json = Record<string, any>;
type T = ReturnType<typeof useT>;

const REACH: Record<ModelReach, { tone: PillTone; key: 'ui.set.reach.ok' | 'ui.set.reach.offline' | 'ui.set.reach.rejected' | 'ui.set.reach.small' }> = {
  ok: { tone: 'ok', key: 'ui.set.reach.ok' }, warn: { tone: 'warn', key: 'ui.set.reach.offline' }, danger: { tone: 'danger', key: 'ui.set.reach.rejected' },
  small: { tone: 'warn', key: 'ui.set.reach.small' },
};

const KEY_LINE = { set: 'ui.set.key.set', os: 'ui.set.key.os', none: 'ui.set.key.none', loading: 'ui.set.key.loading', failed: 'ui.set.key.failed' } as const;

const SERVER_KINDS =['generic', 'lmstudio', 'llamacpp', 'vllm', 'tabbyapi', 'openrouter', 'openai'] as const;

const errorText = (error: unknown, fallback: string): string => (error instanceof ApiError ? error.message : fallback);

function kindLabel(t: T, kind: string): string {
  if (kind === 'anthropic') return t('ui.set.kind.anthropic');
  if (kind === 'openai_compatible') return t('ui.set.kind.openai');
  return kind;
}

function OrderList({ k, ids, label, models, onChange }: { k: string; ids: readonly string[]; label: string; models: readonly Json[]; onChange: (ids: string[]) => void }) {
  const t = useT();
  const ctx = useSet();
  const name = (id: string) => models.find(m => m.id === id)?.label || id;
  const free: Option<string>[] = models.filter(m => !ids.includes(m.id as string)).map(m => ({ value: m.id as string, label: name(m.id as string) }));
  return (
    <div className="ui-set__list" data-order={k}>
      {ids.length > 0 && (
        <ol className="ui-set__chips" aria-label={label}>
          {ids.map((id, i) => (
            <li key={id} className="ui-set__chip">
              <code>{name(id)}</code>
              <Button variant="ghost" small icon="arrowUp" aria-label={t('ui.set.order.up', name(id))} disabled={i === 0 || ctx.busy !== null} onClick={() => onChange(moveItem(ids, i, -1))} />
              <Button variant="ghost" small icon="x" aria-label={t('ui.set.list.remove', name(id))} disabled={ctx.busy !== null} onClick={() => onChange(ids.filter(x => x !== id))} />
            </li>
          ))}
        </ol>
      )}
      {free.length > 0 && <Select value={null} options={free} label={t('ui.set.order.add', label)} placeholder={t('ui.set.order.addShort')} onChange={id => onChange([...ids, id])} />}
    </div>
  );
}

function ProviderRow({ provider, open, onToggle, onRenamed }: { provider: Json; open: boolean; onToggle: () => void; onRenamed: (id: string) => void }) {
  const t = useT();
  const ctx = useSet();
  const id = provider.id as string;
  const k = `provider:${id}`;
  const unsafeEnv = keyEnvUnsafe(ctx.config, id);
  const [state, setState] = useState<ProviderKeyState | 'failed' | null>(null);
  const [entering, setEntering] = useState(false);
  const [key, setKey] = useState('');
  const [removingKey, setRemovingKey] = useState(false);
  const [removing, setRemoving] = useState(false);

  const loadKey = () => {
    setState(null);
    if (unsafeEnv) return;
    api.providerKey(id).then(setState).catch(() => setState('failed'));
  };
  useEffect(loadKey, [id, unsafeEnv, provider.apiKeyEnv]);

  const line = keyLine(state, Boolean(unsafeEnv));
  const reach = providerReach(id, ctx.models);
  const checked = lastChecked(id, ctx.models);
  const desc = [
    line === 'unsafe' ? t('ui.set.key.unsafe', unsafeEnv ?? '') : t(KEY_LINE[line]),
    checked && line !== 'none' ? t('ui.set.key.checked', formatRelative(checked)) : null,
  ].filter(Boolean).join(' · ');

  async function send(confirmed: string | null): Promise<boolean> {
    const value = trimKey(key);
    if (!value) return false;
    ctx.setBusy(k); ctx.clear(k);
    let confirm: { items: Access[]; key: string };
    try {
      const plan = planKeyFor((await api.settings()).config, id, confirmed);
      if (plan.kind === 'none') { ctx.fail(k, t('ui.set.key.failed')); return false; }
      if (plan.kind === 'send') {
        setState(await api.setProviderKey(id, value));
        setKey(''); setEntering(false);
        toast({ icon: 'check', title: t('ui.set.key.saved') });
        await ctx.reload();
        return true;
      }
      confirm = plan;
    } catch (error) { ctx.fail(k, errorText(error, t('ui.set.key.failed'))); return false; }
    finally { ctx.setBusy(null); }
    return ctx.ask({ row: k, items: confirm.items, title: t('ui.set.key.confirmTitle'), ok: t('ui.set.key.confirmOk') }, () => send(confirm.key));
  }

  async function removeKey() {
    ctx.setBusy(k); ctx.clear(k);
    try {
      const next = await api.deleteProviderKey(id);
      setState(next); setRemovingKey(false);
      toast(next.set ? { icon: 'info', title: t('ui.set.key.stillOs') } : { icon: 'check', title: t('ui.set.key.removed') });
      await ctx.reload();
    } catch (error) { ctx.fail(k, errorText(error, t('ui.set.key.failed'))); }
    finally { ctx.setBusy(null); }
  }

  const edit = (patch: Json) => void ctx.commit(k, c => updateListItem(c, 'providers', id, patch));
  const rename = (text: string) => {
    const slug = slugId(text, 'provider');
    if (!slug) { ctx.fail(k, t('ui.set.id.none')); return; }
    const next = uniqueSlug(slug, (ctx.config.providers as Json[]).map(p => p.id as string).filter(x => x !== id), 'provider');
    if (next !== id) void ctx.commit(k, c => renameProvider(c, id, next)).then(ok => { if (ok) onRenamed(next); });
  };
  const inUse = providerInUse(ctx.config, id);
  const canKey = line === 'none' || line === 'set' || line === 'failed';
  const busy = ctx.busy !== null;

  const below = (
    <>
      {entering && (
        <div className="ui-set__form">
          <input className="bt-field bt-field--mono" type="password" placeholder={t('ui.set.key.paste')} aria-label={t('ui.set.key.label', id)} value={key}
            autoComplete="new-password" spellCheck={false} autoFocus disabled={busy}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) { e.preventDefault(); void send(null); } }} />
          <Button small variant="primary" disabled={busy || trimKey(key) === ''} onClick={() => void send(null)}>{t('ui.set.save')}</Button>
          <Button small variant="ghost" disabled={busy} onClick={() => { setEntering(false); setKey(''); ctx.cancel(); }}>{t('ui.cancel')}</Button>
        </div>
      )}
      {open && (
        <div className="ui-set__detail">
          <Row k={`${k}:id`} title={t('ui.set.provider.id')} desc={t('ui.set.provider.idDesc')}><CommitField value={id} label={t('ui.set.provider.id')} mono onCommit={rename} /></Row>
          <Row k={`${k}:kind`} title={t('ui.set.provider.kind')}>
            <Seg value={provider.kind as string} label={t('ui.set.provider.kind')} disabled={busy}
              options={[...new Set(['anthropic', 'openai_compatible', provider.kind as string])].map(kind => ({ value: kind, label: kindLabel(t, kind) }))}
              onChange={kind => edit({ kind })} />
          </Row>
          <Row k={`${k}:url`} title={t('ui.set.provider.url')} desc={t('ui.set.provider.urlDesc')}>
            <CommitField value={(provider.baseUrl as string | undefined) ?? ''} label={t('ui.set.provider.url')} mono type="url" placeholder="https://…" onCommit={v => edit({ baseUrl: v || undefined })} />
          </Row>
          <Row k={`${k}:env`} title={t('ui.set.provider.env')} desc={t('ui.set.provider.envDesc')}>
            <CommitField value={(provider.apiKeyEnv as string | undefined) ?? ''} label={t('ui.set.provider.env')} mono placeholder={t('ui.set.provider.envAuto')} onCommit={v => {
              const result = keyEnvEdit(v);
              if ('fail' in result) { ctx.fail(`${k}:env`, 'key' in result.fail ? t(result.fail.key) : serverText(result.fail.code, null, getLanguage()) ?? ''); return; }
              ctx.clear(`${k}:env`);
              edit(result.patch);
            }} />
          </Row>
          {provider.kind === 'openai_compatible' && (
            <Row k={`${k}:server`} title={t('ui.set.provider.server')}>
              <Select value={(provider.server as string | undefined) ?? 'generic'} label={t('ui.set.provider.server')} options={SERVER_KINDS.map(s => ({ value: s as string, label: s }))} onChange={server => edit({ server })} />
            </Row>
          )}
          <Row k={`${k}:parallel`} title={t('ui.set.provider.parallel')}>
            <NumberField k={`${k}:parallel`} value={provider.maxParallel as number} label={t('ui.set.provider.parallel')} min={1} max={8} onCommit={v => edit({ maxParallel: v })} />
          </Row>
          <Row k={`${k}:timeout`} title={t('ui.set.provider.timeout')} desc={t('ui.set.unit.seconds')}>
            <NumberField k={`${k}:timeout`} value={secondsOf(provider.timeoutMs)} label={t('ui.set.provider.timeout')} min={1} max={3600} onCommit={v => { if (v !== undefined) edit({ timeoutMs: v * 1000 }); }} />
          </Row>
          {line === 'set' && (
            <Row k={`${k}:removekey`} title={t('ui.set.key.remove')} desc={t('ui.set.key.removeDesc')}
              below={removingKey && <RowConfirm warn={t('ui.set.key.removeWarn')} action={t('ui.set.key.remove')} busy={busy} onConfirm={() => void removeKey()} onKeep={() => setRemovingKey(false)} />}>
              {!removingKey && <Button small variant="ghost" disabled={busy} onClick={() => setRemovingKey(true)}>{t('ui.set.key.remove')}</Button>}
            </Row>
          )}
          <Row k={`${k}:remove`} title={t('ui.set.provider.remove')} desc={inUse ? t('ui.set.provider.inUse') : undefined}
            below={removing && <RowConfirm warn={t('ui.lib.deleteWarn')} action={t('ui.set.provider.remove')} busy={busy} onConfirm={() => { setRemoving(false); void ctx.commit(k, c => removeProvider(c, id)); }} onKeep={() => setRemoving(false)} />}>
            {!removing && <Button small variant="ghost" disabled={busy || inUse} onClick={() => setRemoving(true)}>{t('ui.set.provider.remove')}</Button>}
          </Row>
        </div>
      )}
    </>
  );

  return (
    <Row k={k} title={<>{id} <span className="bt-meta">· {kindLabel(t, provider.kind as string)}</span></>} desc={desc} below={(entering || open) && below}>
      {reach && <Pill tone={REACH[reach].tone}>{t(REACH[reach].key)}</Pill>}
      {provider.kind === 'openai_compatible' && !open && (
        <CommitField value={(provider.baseUrl as string | undefined) ?? ''} label={t('ui.set.provider.urlOf', id)} mono type="url" onCommit={v => edit({ baseUrl: v || undefined })} />
      )}
      {canKey && !entering && <Button small disabled={busy} onClick={() => { setEntering(true); ctx.clear(k); }}>{line === 'set' ? t('ui.set.key.replace') : t('ui.set.key.add')}</Button>}
      <Button small variant="ghost" aria-expanded={open} onClick={onToggle}>{open ? t('ui.set.less') : t('ui.set.edit')}</Button>
    </Row>
  );
}

function AddProvider({ onDone }: { onDone: () => void }) {
  const t = useT();
  const ctx = useSet();
  const [kind, setKind] = useState<'anthropic' | 'openai' | 'custom'>('custom');
  const [url, setUrl] = useState('http://127.0.0.1:8000/v1');
  const add = async () => {
    const ok = await ctx.commit('provider:add', c => {
      const taken = (c.providers as Json[]).map(p => p.id as string);
      const entry: Json = kind === 'anthropic'
        ? newAnthropicProvider(c)
        : kind === 'openai'
          ? { id: uniqueId('openai', taken), kind: 'openai_compatible', baseUrl: OPENAI_URL, server: 'openai', maxParallel: 2, timeoutMs: 600_000 }
          : { id: uniqueId('local', taken), kind: 'openai_compatible', baseUrl: url.trim(), server: 'generic', maxParallel: 1, timeoutMs: 600_000 };
      return { ...c, providers: [...(c.providers as Json[]), entry] };
    });
    if (ok) onDone();
  };
  return (
    <div className="ui-set__form">
      <Seg value={kind} label={t('ui.set.provider.kind')} options={[{ value: 'anthropic', label: t('ui.set.kind.anthropic') }, { value: 'openai', label: 'OpenAI' }, { value: 'custom', label: t('ui.set.kind.custom') }]} onChange={setKind} />
      {kind === 'custom' && <input className="bt-field bt-field--mono" aria-label={t('ui.set.provider.url')} value={url} spellCheck={false} onChange={e => setUrl(e.target.value)} />}
      <Button small variant="primary" disabled={ctx.busy !== null || (kind === 'custom' && !/^https?:\/\/\S+$/iu.test(url.trim()))} onClick={() => void add()}>{t('ui.set.add')}</Button>
      <Button small variant="ghost" onClick={() => { ctx.cancel(); onDone(); }}>{t('ui.cancel')}</Button>
    </div>
  );
}

function ModelRow({ model, open, onToggle, onRenamed, probing }: { model: Json; open: boolean; onToggle: () => void; onRenamed: (id: string) => void; probing: boolean }) {
  const t = useT();
  const ctx = useSet();
  const id = model.id as string;
  const k = `model:${id}`;
  const [removing, setRemoving] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const view = ctx.models.find(m => m.id === id);
  const probe = view?.probe ?? null;
  const limits = view?.limits ?? null;
  const reach: ModelReach | null = probe ? modelReach(probe.status) : null;
  const edit = (patch: Json) => void ctx.commit(k, c => updateListItem(c, 'models', id, patch));
  const busy = ctx.busy !== null;
  const askContext = probe?.status === 'unknown' && model.contextLength === undefined;
  const autoText = (n: number | null | undefined) => (n === null || n === undefined ? undefined : t('ui.set.model.auto', formatNumber(n)));
  const sourceOf = (value: number | undefined, current: number | null | undefined, clear: () => void) => value !== undefined
    ? <>{t('ui.set.model.setByYou')} · <Button small variant="ghost" disabled={busy} onClick={clear}>{t('ui.set.model.useAuto')}</Button></>
    : autoText(current);
  const summary = [
    limits?.context != null ? t('ui.set.model.sumContext', formatNumber(limits.context)) : null,
    limits?.maxOutput != null ? t('ui.set.model.sumReply', formatNumber(limits.maxOutput)) : null,
    limits?.required != null ? t('ui.set.model.sumNeeds', formatNumber(limits.required)) : null,
  ].filter(part => part !== null).join(' · ');
  const contextRow = (
    <Row k={`${k}:ctx`} title={t('ui.set.model.context')} desc={askContext ? t('ui.set.model.contextNeeded') : sourceOf(model.contextLength as number | undefined, limits?.context, () => edit({ contextLength: undefined }))}>
      <NumberField k={`${k}:ctx`} value={model.contextLength as number | undefined} optional min={1024} max={10_000_000} label={t('ui.set.model.context')} placeholder={autoText(limits?.context)} onCommit={v => edit({ contextLength: v })} />
    </Row>
  );
  const rename = (text: string) => {
    const slug = slugId(text, 'model');
    if (!slug) { ctx.fail(k, t('ui.set.id.none')); return; }
    const next = uniqueSlug(slug, (ctx.config.models as Json[]).map(m => m.id as string).filter(x => x !== id), 'model');
    if (next !== id) void ctx.commit(k, c => renameModel(c, id, next)).then(ok => { if (ok) onRenamed(next); });
  };
  const providers: Option<string>[] = (ctx.config.providers as Json[]).map(p => ({ value: p.id as string, label: p.id as string }));
  const name = (model.label as string) || id;
  const status = probing ? t('ui.set.models.checking') : probe ? probeMessage(probe, getLanguage()) || probe.status : t('ui.set.models.unchecked');
  return (
    <Row k={k} title={name} desc={<><code>{model.provider as string} · {model.model as string}</code> · {status}</>}
      below={(open || removing) && (
        <>
        {removing && <RowConfirm warn={t('ui.lib.deleteWarn')} action={t('ui.set.model.remove')} busy={busy} onConfirm={() => { setRemoving(false); void ctx.commit(k, c => removeModel(c, id)); }} onKeep={() => setRemoving(false)} />}
        {open && (
        <div className="ui-set__detail">
          <Row k={`${k}:label`} title={t('ui.set.model.label')}><CommitField value={(model.label as string | undefined) ?? ''} label={t('ui.set.model.label')} onCommit={v => edit({ label: v || undefined })} /></Row>
          <Row k={`${k}:id`} title={t('ui.set.model.id')}><CommitField value={id} label={t('ui.set.model.id')} mono onCommit={rename} /></Row>
          <Row k={`${k}:provider`} title={t('ui.set.model.provider')}><Select value={model.provider as string} options={providers} label={t('ui.set.model.provider')} onChange={provider => edit({ provider })} /></Row>
          <Row k={`${k}:model`} title={t('ui.set.model.name')} desc={t('ui.set.model.nameDesc')}><CommitField value={model.model as string} label={t('ui.set.model.name')} mono required onCommit={v => edit({ model: v })} /></Row>
          <Row k={`${k}:vision`} title={t('ui.set.model.vision')}><Switch checked={Boolean(model.vision)} label={t('ui.set.model.vision')} disabled={busy} onChange={vision => edit({ vision })} /></Row>
          {askContext && contextRow}
          <Row k={`${k}:advanced`} title={t('ui.set.model.advanced')} desc={summary || undefined}>
            <Button small variant="ghost" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{advanced ? t('ui.set.less') : t('ui.set.edit')}</Button>
          </Row>
          {advanced && (
            <>
              {!askContext && contextRow}
              <Row k={`${k}:out`} title={t('ui.set.model.maxOutput')} desc={sourceOf(model.maxOutputTokens as number | undefined, limits?.maxOutput, () => edit({ maxOutputTokens: undefined }))}>
                <NumberField k={`${k}:out`} value={model.maxOutputTokens as number | undefined} optional min={256} max={200_000} label={t('ui.set.model.maxOutput')} placeholder={autoText(limits?.maxOutput)} onCommit={v => edit({ maxOutputTokens: v })} />
              </Row>
              <Row k={`${k}:min`} title={t('ui.set.model.minContext')} desc={t('ui.set.model.minContextDesc')}>
                <span className="bt-meta">{autoText(limits?.required) ?? '—'}</span>
              </Row>
            </>
          )}
        </div>
        )}
        </>
      )}>
      {reach && <Pill tone={REACH[reach].tone}>{t(REACH[reach].key)}</Pill>}
      {!removing && <Button small variant="ghost" aria-label={t('ui.set.list.remove', name)} disabled={busy} onClick={() => setRemoving(true)}>{t('ui.set.model.removeShort')}</Button>}
      <Button small variant="ghost" aria-expanded={open} onClick={onToggle}>{open ? t('ui.set.less') : t('ui.set.edit')}</Button>
    </Row>
  );
}

function AddModel({ onDone }: { onDone: (id: string) => void }) {
  const t = useT();
  const ctx = useSet();
  const providers = (ctx.config.providers as Json[]).map(p => p.id as string);
  const [provider, setProvider] = useState<string | null>(providers[0] ?? null);
  const [name, setName] = useState('');
  const [names, setNames] = useState<string[]>([]);
  const [listFailed, setListFailed] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  useEffect(() => {
    setNames([]); setListFailed(null);
    if (!provider) return undefined;
    let live = true;
    api.providerModels(provider).then(list => { if (live) { setNames(list.models); setTruncated(list.truncated); } }).catch(error => { if (live) setListFailed(errorText(error, '')); });
    return () => { live = false; };
  }, [provider]);
  const add = async () => {
    let made = '';
    const ok = await ctx.commit('model:add', c => {
      const next = addModel(c);
      made = uniqueSlug(slugId(name, 'model') || next.id, (c.models as Json[]).map(m => m.id as string), 'model');
      const renamed = renameModel(next.config, next.id, made);
      return updateListItem(renamed, 'models', made, { provider: provider ?? '', model: name.trim() });
    });
    if (ok) onDone(made);
  };
  return (
    <>
      <div className="ui-set__form">
        <Select value={provider} options={providers.map(p => ({ value: p, label: p }))} label={t('ui.set.model.provider')} onChange={setProvider} />
        <input className="bt-field bt-field--mono" aria-label={t('ui.set.model.name')} placeholder={t('ui.set.model.namePh')} value={name} spellCheck={false} list="ui-set-model-names" onChange={e => setName(e.target.value)} />
        <datalist id="ui-set-model-names">{names.map(n => <option key={n} value={n} />)}</datalist>
        <Button small variant="primary" disabled={ctx.busy !== null || !provider || !name.trim()} onClick={() => void add()}>{t('ui.set.add')}</Button>
        <Button small variant="ghost" onClick={() => { ctx.cancel(); onDone(''); }}>{t('ui.cancel')}</Button>
      </div>
      {(listFailed !== null || names.length > 0) && <p className="bt-meta" role="status">{listFailed !== null ? listFailed || t('ui.set.model.listFailed') : t(truncated ? 'ui.set.model.listedFirst' : 'ui.set.model.listed', names.length)}</p>}
    </>
  );
}

export function ModelsPanel() {
  const t = useT();
  const ctx = useSet();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<'provider' | 'model' | null>(null);
  const [probing, setProbing] = useState(false);
  const providers = (ctx.config.providers ?? []) as Json[];
  const models = (ctx.config.models ?? []) as Json[];
  const roles = rolesOf(ctx.config);
  const toggle = (key: string) => setOpen(open === key ? null : key);
  const probe = async () => {
    setProbing(true); ctx.clear('models:check');
    try { await api.probe(); await ctx.reload(); } catch (error) { ctx.fail('models:check', errorText(error, t('ui.set.models.checkFailed'))); } finally { setProbing(false); }
  };
  const modelOptions: Option<string>[] = models.map(m => ({ value: m.id as string, label: (m.label as string) || (m.id as string) }));
  const backups = judgeBackups(ctx.config);
  const modelName = (id: string): string => modelOptions.find(o => o.value === id)?.label ?? id;
  return (
    <>
      <Group title={t('ui.set.models.providers')}>
        {providers.map(p => <ProviderRow key={p.id as string} provider={p} open={open === `p:${p.id}`} onToggle={() => toggle(`p:${p.id}`)} onRenamed={next => setOpen(now => openAfterRename(now, `p:${p.id}`, `p:${next}`))} />)}
        <Row k="provider:add" title={t('ui.set.provider.add')} desc={t('ui.set.provider.addDesc')} below={adding === 'provider' && <AddProvider onDone={() => setAdding(null)} />}>
          {adding !== 'provider' && <Button small onClick={() => setAdding('provider')}>{t('ui.set.provider.addShort')}</Button>}
        </Row>
      </Group>
      <Group title={t('ui.set.models.models')}>
        {models.length === 0 && <p className="bt-meta">{t('ui.set.models.none')}</p>}
        {models.map(m => <ModelRow key={m.id as string} model={m} probing={probing} open={open === `m:${m.id}`} onToggle={() => toggle(`m:${m.id}`)} onRenamed={next => setOpen(now => openAfterRename(now, `m:${m.id}`, `m:${next}`))} />)}
        <Row k="model:add" title={t('ui.set.model.add')} desc={t('ui.set.model.addDesc')} below={adding === 'model' && <AddModel onDone={id => { setAdding(null); if (id) setOpen(`m:${id}`); }} />}>
          {adding !== 'model' && <Button small disabled={providers.length === 0} onClick={() => setAdding('model')}>{t('ui.set.model.addShort')}</Button>}
        </Row>
        <Row k="models:check" title={t('ui.set.models.check')} desc={t('ui.set.models.checkDesc')}>
          <Button small disabled={probing || models.length === 0} onClick={() => void probe()}>{probing ? t('ui.set.models.checking') : t('ui.set.models.checkShort')}</Button>
        </Row>
      </Group>
      <Group title={t('ui.set.models.roles')}>
        <Row k="roles:conversation" title={t('ui.set.models.conversation')} desc={t('ui.set.models.conversationDesc')}>
          <Select value={roles.conversation} options={modelOptions} label={t('ui.set.models.conversation')} placeholder={t('ui.set.models.auto')} onChange={id => void ctx.commit('roles:conversation', c => setConversation(c, id))} />
        </Row>
        <Row k="roles:judge" title={t('ui.set.models.judge')} desc={judgeIsOff(ctx.config) ? t('ui.set.models.judgeOffDesc') : t('ui.set.models.judgeDesc')}
          below={backups.length > 0 && <span className="bt-meta">{t('ui.set.models.judgeBackups', backups.map(modelName).join(', '))}</span>}>
          <Select value={judgeChoice(ctx.config)} options={[{ value: '', label: t('ui.set.models.judgeSame') }, ...modelOptions, { value: JUDGE_OFF, label: t('ui.set.models.judgeOff') }]} label={t('ui.set.models.judge')} onChange={id => void ctx.commit('roles:judge', c => setJudge(c, id))} />
        </Row>
        <Row k="roles:fallback" title={t('ui.set.models.fallback')} desc={t('ui.set.models.fallbackDesc')}
          below={<OrderList k="fallback" ids={roles.fallback} label={t('ui.set.models.fallback')} models={models.filter(m => m.id !== roles.conversation)} onChange={ids => void ctx.commit('roles:fallback', c => setFallback(c, ids))} />} />
        <Row k="roles:background" title={t('ui.set.models.background')} desc={t('ui.set.models.backgroundDesc')}
          below={<OrderList k="background" ids={roles.background} label={t('ui.set.models.background')} models={models} onChange={ids => void ctx.commit('roles:background', c => ({ ...c, routing: { ...c.routing, background: ids } }))} />} />
      </Group>
    </>
  );
}

export function SkillsPanel() {
  const t = useT();
  const ctx = useSet();
  const [counts, setCounts] = useState<{ skills: number; drafts: number } | null>(null);
  const [tools, setTools] = useState<{ allow: number; ask: number; block: number } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([api.skills(), api.review()]).then(([s, r]) => { if (live) setCounts({ skills: s.skills.filter(x => x.registered).length, drafts: r.skillDrafts.length }); }).catch(() => undefined);
    void api.tools().then(r => { if (live) setTools(toolCounts(r.tools)); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const ask = (ctx.config.skills as Json | undefined)?.askBeforeRegister !== false;
  const grow = (ctx.config.skills as Json | undefined)?.grow !== false;
  const shell = (ctx.config.tools?.shell ?? {}) as Json;
  const setShell = (row: string, patch: Json) => void ctx.commit(row, c => updateAt(c, 'tools', { shell: { ...(c.tools as Config).shell, ...patch } }));
  const goSkills = () => location.replace('#/skills');
  const busy = ctx.busy !== null;
  return (
    <>
      <Group title={t('ui.set.skills.title')}>
        <Row k="skills:grow" title={t('ui.set.skills.grow')} desc={grow ? t('ui.set.skills.growOn') : t('ui.set.skills.growOff')}>
          <Switch checked={grow} label={t('ui.set.skills.grow')} disabled={busy} onChange={next => void ctx.commit('skills:grow', c => {
            const { grow: _drop, ...rest } = (c.skills ?? {}) as Json;
            const skills = next ? rest : { ...rest, grow: false };
            const { skills: _old, ...others } = c;
            return Object.keys(skills).length ? { ...others, skills } : others;
          })} />
        </Row>
        <Row k="skills:ask" title={t('ui.set.skills.ask')} desc={!grow ? t('ui.set.skills.askGrowOff') : ask ? t('ui.set.skills.askOn') : t('ui.set.skills.askOff')}>
          <span data-grow={grow ? 'on' : 'off'}><Switch checked={ask} label={t('ui.set.skills.ask')} disabled={busy || !grow} onChange={next => void ctx.commit('skills:ask', c => {
            const { askBeforeRegister: _drop, ...rest } = (c.skills ?? {}) as Json;
            const skills = next ? rest : { ...rest, askBeforeRegister: false };
            const { skills: _old, ...others } = c;
            return Object.keys(skills).length ? { ...others, skills } : others;
          })} /></span>
        </Row>
        <Row k="skills:registered" title={t('ui.set.skills.registered')} desc={counts ? t('ui.set.skills.counts', counts.skills, counts.drafts) : undefined}>
          <Button small onClick={goSkills}>{t('ui.set.skills.open')}</Button>
        </Row>
      </Group>
      <Group title={t('ui.set.skills.tools')}>
        <Row k="skills:tools" title={t('ui.set.skills.toolsRow')} desc={tools ? t('ui.tools.count', tools.allow, tools.ask, tools.block) : undefined}>
          <Button small onClick={goSkills}>{t('ui.set.skills.open')}</Button>
        </Row>
      </Group>
      <Group title={t('ui.set.shell.title')}>
        <Row k="shell:enabled" title={t('ui.set.shell.enabled')} desc={t('ui.set.shell.enabledDesc')}>
          <Switch checked={shell.enabled !== false} label={t('ui.set.shell.enabled')} disabled={busy} onChange={enabled => setShell('shell:enabled', { enabled })} />
        </Row>
        <Row k="shell:kind" title={t('ui.set.shell.kind')}>
          <Select value={(shell.shell as string | undefined) ?? 'auto'} label={t('ui.set.shell.kind')} options={['auto', 'pwsh', 'powershell', 'bash', 'sh'].map(s => ({ value: s, label: s === 'auto' ? t('ui.set.shell.auto') : s }))} onChange={kind => setShell('shell:kind', { shell: kind })} />
        </Row>
        <Row k="shell:timeout" title={t('ui.set.shell.timeout')} desc={t('ui.set.unit.seconds')}>
          <NumberField k="shell:timeout" value={shell.timeoutSec as number} min={1} max={3600} label={t('ui.set.shell.timeout')} onCommit={v => setShell('shell:timeout', { timeoutSec: v })} />
        </Row>
        <Row k="shell:allow" title={t('ui.set.shell.allow')} desc={t('ui.set.shell.allowDesc')}
          below={<ListField items={(shell.allow ?? []) as string[]} label={t('ui.set.shell.allow')} placeholder="git status" disabled={busy} onChange={allow => setShell('shell:allow', { allow })} />} />
        <Row k="shell:ask" title={t('ui.set.shell.ask')} desc={t('ui.set.shell.askDesc')}
          below={<ListField items={(shell.ask ?? []) as string[]} label={t('ui.set.shell.ask')} placeholder="npm publish" disabled={busy} onChange={list => setShell('shell:ask', { ask: list })} />} />
        <Row k="shell:deny" title={t('ui.set.shell.deny')} desc={t('ui.set.shell.denyDesc')}
          below={<ListField items={(shell.deny ?? []) as string[]} label={t('ui.set.shell.deny')} placeholder="rm -rf" disabled={busy} onChange={deny => setShell('shell:deny', { deny })} />} />
      </Group>
    </>
  );
}

export function BackgroundPanel() {
  const t = useT();
  const ctx = useSet();
  const worker = (ctx.config.worker ?? {}) as Json;
  const set = (row: string, patch: Json) => void ctx.commit(row, c => updateAt(c, 'worker', patch));
  return (
    <Group title={t('ui.set.bg.title')}>
      <Row k="bg:on" title={t('ui.set.bg.on')} desc={t('ui.set.bg.onDesc')}>
        <Switch checked={worker.enabled !== false} label={t('ui.set.bg.on')} disabled={ctx.busy !== null} onChange={enabled => set('bg:on', { enabled })} />
      </Row>
      <Row k="bg:perHour" title={t('ui.set.bg.perHour')} desc={t('ui.set.bg.perHourDesc')}>
        <NumberField k="bg:perHour" value={worker.maxRunsPerHour as number} min={1} max={120} label={t('ui.set.bg.perHour')} onCommit={v => set('bg:perHour', { maxRunsPerHour: v })} />
      </Row>
      <Row k="bg:parallel" title={t('ui.set.bg.parallel')} desc={t('ui.set.bg.parallelDesc')}>
        <NumberField k="bg:parallel" value={worker.maxParallel as number} min={1} max={4} label={t('ui.set.bg.parallel')} onCommit={v => set('bg:parallel', { maxParallel: v })} />
      </Row>
    </Group>
  );
}
