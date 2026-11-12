import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type McpDiffView, type McpEffect, type McpSecretView, type McpServerView, type McpToolView, type McpView } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { useT } from '../../i18n/index.ts';
import { accessKey, accessWidening, mcpSecretAccess, type Access } from '../../settings/access.ts';
import {
  addBody, addProblem, addSpec, emptyAddForm, idFromName, previewAdd, previewServer, previewTool, reasonKey, revealHidden, sameShape, scrubSecrets, summarize, tone,
  type AddForm, type ToolPatch,
} from '../../settings/mcp-model.ts';
import type { Config } from '../../settings/model.ts';
import { Button, Pill, type PillTone } from '../parts.tsx';
import { RowConfirm } from '../RowConfirm.tsx';
import { Group, Row, Seg, Select, Switch, useSet } from './controls.tsx';

const POLL_MS = 3000;
const TONE: Record<ReturnType<typeof tone>, PillTone | undefined> = { ok: 'ok', busy: 'running', bad: 'danger', off: undefined };
const isView = (value: unknown): value is McpView => typeof value === 'object' && value !== null && Array.isArray((value as McpView).servers);

interface McpOps {
  run: (row: string, op: () => Promise<unknown>, done?: string) => Promise<boolean>;
  guarded: (row: string, items: (latest: Config) => Access[], op: () => Promise<unknown>, done?: string) => Promise<boolean>;
}

function useMcp(): { view: McpView | 'failed' | null; ops: McpOps } {
  const t = useT();
  const ctx = useSet();
  const [view, setView] = useState<McpView | 'failed' | null>(null);
  const acting = useRef(false);
  const seq = useRef(0);
  useEffect(() => {
    let live = true;
    const load = () => {
      if (acting.current) return;
      const mine = ++seq.current;
      api.mcp().then(next => { if (live && !acting.current && mine === seq.current) setView(next); }).catch(() => { if (live) setView(old => old ?? 'failed'); });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const run = useCallback(async (row: string, op: () => Promise<unknown>, done?: string): Promise<boolean> => {
    if (acting.current) return false;
    acting.current = true; seq.current += 1; ctx.cancel(); ctx.setBusy(row); ctx.clear(row);
    try {
      const next = await op();
      setView(isView(next) ? next : await api.mcp());
      if (done) toast({ icon: 'check', title: done });
      await ctx.reload();
      return true;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : t('ui.set.mcp.failed');
      ctx.fail(row, message);
      return false;
    } finally { acting.current = false; seq.current += 1; ctx.setBusy(null); }
  }, [ctx, t]);
  const guarded = useCallback(async function go(row: string, items: (latest: Config) => Access[], op: () => Promise<unknown>, done?: string, confirmed: string | null = null): Promise<boolean> {
    let latest: Config;
    try { latest = (await api.settings()).config; } catch (error) { ctx.fail(row, error instanceof ApiError ? error.message : t('ui.set.mcp.failed')); return false; }
    const list = items(latest);
    if (list.length > 0 && accessKey(list) !== confirmed) {
      ctx.ask({ row, items: list, run: () => void go(row, items, op, done, accessKey(list)) });
      return false;
    }
    return run(row, op, done);
  }, [ctx, run, t]);
  return { view, ops: { run, guarded } };
}

const EFFECTS: readonly McpEffect[] = ['read', 'write', 'network'];
const EFFECT_LABEL = { read: 'ui.set.mcp.effect.read', write: 'ui.set.mcp.effect.write', network: 'ui.set.mcp.effect.network' } as const;
const SENDS_LABEL = { unset: 'ui.set.mcp.sends.unset', yes: 'ui.set.mcp.sends.yes', no: 'ui.set.mcp.sends.no' } as const;
const REMOVES_LABEL = { unset: 'ui.set.mcp.removes.unset', yes: 'ui.set.mcp.removes.yes', no: 'ui.set.mcp.removes.no' } as const;
const REASON_LABEL = { not_found: 'ui.set.mcp.toolReason.not_found', duplicate_name: 'ui.set.mcp.toolReason.duplicate_name' } as const;
type Tri = 'unset' | 'yes' | 'no';
const triOf = (value: boolean | undefined): Tri => (value === undefined ? 'unset' : value ? 'yes' : 'no');
const fromTri = (value: Tri): boolean | null => (value === 'unset' ? null : value === 'yes');

function ToolRow({ server, tool, ops }: { server: McpServerView; tool: McpToolView; ops: McpOps }) {
  const t = useT();
  const ctx = useSet();
  const [diff, setDiff] = useState<McpDiffView | 'failed' | 'stale' | null>(null);
  const [shown, setShown] = useState<McpDiffView | null>(null);
  const [declaring, setDeclaring] = useState(false);
  const k = `mcp:${server.id}:${tool.name}`;
  const configured = ((ctx.config.mcp?.servers ?? []) as Array<Record<string, any>>).find(s => s.id === server.id)?.tools?.[tool.name] as { effect?: McpEffect; sends?: boolean; removes?: boolean } | undefined;
  const enabled = tool.state !== 'off' && tool.state !== 'unlisted';
  const patch = (change: ToolPatch) => void ops.guarded(k, latest => accessWidening(latest, previewTool(latest, server.id, tool.name, change)), () => api.patchMcpTool(server.id, tool.name, change));
  const busy = ctx.busy !== null;
  const openDiff = () => { setDiff(null); api.mcpToolDiff(server.id, tool.name).then(d => { setDiff(d); setShown(d); }).catch(() => setDiff('failed')); };
  const accept = async () => {
    if (!shown) return;
    try {
      const fresh = await api.mcpToolDiff(server.id, tool.name);
      if (!sameShape(fresh.after, shown.after)) { setShown(fresh); setDiff('stale'); return; }
    } catch { setDiff('failed'); return; }
    if (await ops.run(k, () => api.acceptMcpTool(server.id, tool.name), t('ui.set.mcp.accepted'))) { setDiff(null); setShown(null); }
  };
  const reason = tool.reason === 'not_found' || tool.reason === 'duplicate_name' ? t(REASON_LABEL[tool.reason]) : tool.reason ? tool.reason.slice(0, 160) : null;
  return (
    <Row k={k} title={<code>{tool.name}</code>} desc={[t(`settings.mcp.toolState.${tool.state}`), reason, tool.description ? revealHidden(tool.description).slice(0, 140) : null].filter(Boolean).join(' · ')}
      below={(tool.state === 'changed' || diff !== null || shown !== null || declaring) && (
        <>
          {tool.state === 'changed' && diff === null && shown === null && <p className="bt-meta">{t('ui.set.mcp.changed')} · <button type="button" className="bt-notice__action" onClick={openDiff}>{t('ui.set.mcp.review')}</button></p>}
          {(diff !== null || shown !== null) && (
            <div className="ui-set__diff" role="group" aria-label={t('ui.set.mcp.diffTitle', tool.name)}>
              {diff === 'failed' && <p className="bt-meta bt-del" role="alert">{t('ui.set.mcp.diffFailed')}</p>}
              {diff === 'stale' && <p className="bt-meta bt-del" role="alert">{t('ui.set.mcp.diffStale')}</p>}
              {shown && (
                <div className="ui-set__shapes">
                  {(['before', 'after'] as const).map(side => {
                    const shape = shown[side];
                    return (
                      <div key={side} className="ui-set__shape">
                        <span className="bt-label">{t(side === 'before' ? 'ui.set.mcp.before' : 'ui.set.mcp.after')}</span>
                        {shape ? (
                          <>
                            <pre className="bt-doc ui-set__pre">{revealHidden(shape.description) || '—'}</pre>
                            <pre className="bt-doc ui-set__pre">{revealHidden(shape.schema) || '—'}</pre>
                            <span className="bt-meta">{[shape.destructive ? t('ui.set.mcp.destructive') : null, shape.openWorld ? t('ui.set.mcp.openWorld') : null, shape.stripped > 0 ? t('ui.set.mcp.stripped', shape.stripped) : null].filter(Boolean).join(' · ') || '—'}</span>
                          </>
                        ) : <span className="bt-meta">—</span>}
                      </div>
                    );
                  })}
                </div>
              )}
              <span className="ui-confirm__buttons">
                <Button small variant="primary" disabled={busy || !shown} onClick={() => void accept()}>{t('ui.set.mcp.accept')}</Button>
                <Button small variant="ghost" onClick={() => { setDiff(null); setShown(null); }}>{t('ui.close')}</Button>
              </span>
            </div>
          )}
          {declaring && tool.state !== 'unlisted' && tool.state !== 'missing' && (
            <div className="ui-set__form">
              <Select value={configured?.effect ?? 'unset'} label={t('ui.set.mcp.effect')} options={[{ value: 'unset', label: t('ui.set.mcp.unset') }, ...EFFECTS.map(e => ({ value: e, label: t(EFFECT_LABEL[e]) }))]}
                onChange={v => patch({ effect: v === 'unset' ? null : v as McpEffect })} />
              <Select value={triOf(configured?.sends)} label={t('ui.set.mcp.sends')} options={(['unset', 'yes', 'no'] as const).map(v => ({ value: v, label: t(SENDS_LABEL[v]) }))} onChange={v => patch({ sends: fromTri(v) })} />
              <Select value={triOf(configured?.removes)} label={t('ui.set.mcp.removes')} options={(['unset', 'yes', 'no'] as const).map(v => ({ value: v, label: t(REMOVES_LABEL[v]) }))} onChange={v => patch({ removes: fromTri(v) })} />
            </div>
          )}
        </>
      )}>
      {tool.state !== 'unlisted' && tool.state !== 'missing' && <Button small variant="ghost" aria-expanded={declaring} onClick={() => setDeclaring(!declaring)}>{t('ui.set.mcp.declare')}</Button>}
      <Switch checked={enabled} label={t('ui.set.mcp.toolSwitch', tool.name)} disabled={busy} onChange={next => patch({ enabled: next })} />
    </Row>
  );
}

function SecretRow({ server, secret, ops }: { server: McpServerView; secret: McpSecretView; ops: McpOps }) {
  const t = useT();
  const ctx = useSet();
  const [value, setValue] = useState('');
  const [entering, setEntering] = useState(false);
  const [removing, setRemoving] = useState(false);
  const k = `mcp:${server.id}:secret:${secret.kind}:${secret.name}`;
  const busy = ctx.busy !== null;
  const send = async () => {
    const ok = await ops.guarded(k, latest => mcpSecretAccess({ id: server.id, kind: secret.kind, name: secret.name }, latest), () => api.setMcpSecret(server.id, secret.kind, secret.name, value), t('ui.set.mcp.secretSaved'));
    if (ok) { setValue(''); setEntering(false); }
  };
  const state = secret.set ? (secret.source === 'os' ? t('ui.set.mcp.secretOs') : t('ui.set.mcp.secretSet')) : t('ui.set.mcp.secretUnset');
  return (
    <Row k={k} title={<code>{secret.name}</code>} desc={state}
      below={(entering || removing) && (
        <>
          {entering && (
            <div className="ui-set__form">
              <input className="bt-field bt-field--mono" type="password" aria-label={t('ui.set.mcp.secretLabel', secret.name)} placeholder={t('ui.set.key.paste')} value={value} autoComplete="new-password" spellCheck={false} autoFocus
                onChange={e => setValue(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && value) { e.preventDefault(); void send(); } }} />
              <Button small variant="primary" disabled={busy || !value} onClick={() => void send()}>{t('ui.set.save')}</Button>
              <Button small variant="ghost" onClick={() => { setValue(''); setEntering(false); ctx.cancel(); }}>{t('ui.cancel')}</Button>
            </div>
          )}
          {removing && <RowConfirm warn={t('ui.set.mcp.secretRemoveWarn')} action={t('ui.set.mcp.secretRemove')} busy={busy} onConfirm={() => {
            setRemoving(false);
            void ops.run(k, async () => { const s = await api.deleteMcpSecret(server.id, secret.kind, secret.name); if (s.set) toast({ icon: 'info', title: t('ui.set.mcp.secretStillOs') }); });
          }} onKeep={() => setRemoving(false)} />}
        </>
      )}>
      {!entering && <Button small disabled={busy} onClick={() => setEntering(true)}>{secret.set ? t('ui.set.key.replace') : t('ui.set.mcp.secretEnter')}</Button>}
      {secret.set && secret.source !== 'os' && !removing && <Button small variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>{t('ui.set.mcp.secretRemove')}</Button>}
    </Row>
  );
}

function ServerRow({ server, ops, max }: { server: McpServerView; ops: McpOps; max: number }) {
  const t = useT();
  const ctx = useSet();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const k = `mcp:${server.id}`;
  const sum = summarize(server);
  const pillTone = TONE[tone(server.state)];
  const busy = ctx.busy !== null;
  const setServer = (patch: { enabled?: boolean; localOk?: boolean }) =>
    void ops.guarded(k, latest => accessWidening(latest, previewServer(latest, server.id, patch)), () => api.patchMcpServer(server.id, patch));
  const desc = [
    t('ui.set.mcp.tools', sum.registered, server.tools.length),
    sum.changed > 0 ? t('ui.set.mcp.changedCount', sum.changed) : null,
    sum.cut > 0 ? t('ui.set.mcp.cutCount', sum.cut, max) : null,
    server.state === 'failed' ? `${t(reasonKey(server.reason))}${server.detail ? ` — ${server.detail}` : ''}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <Row k={k} title={<>{server.id} <span className="bt-meta">· {server.transport === 'http' ? 'HTTP' : 'stdio'}</span></>} desc={desc}
      below={(removing || open) && (
        <>
          {removing && <RowConfirm warn={t('ui.lib.deleteWarn')} note={t('ui.set.mcp.deleteNote')} action={t('ui.lib.delete')} busy={busy} onConfirm={() => { setRemoving(false); void ops.run(k, () => api.deleteMcpServer(server.id), t('ui.set.mcp.deleted')); }} onKeep={() => setRemoving(false)} />}
          {open && (
            <div className="ui-set__detail">
              <Row k={`${k}:target`} title={t('ui.set.mcp.target')} desc={<code className="bt-meta">{server.target}</code>}>
                <Button small variant="ghost" disabled={busy || !server.enabled} onClick={() => void ops.run(k, () => api.restartMcpServer(server.id), t('ui.set.mcp.restarted'))}>{t('ui.set.mcp.restart')}</Button>
                {!removing && <Button small variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>{t('ui.lib.delete')}</Button>}
              </Row>
              <Row k={`${k}:local`} title={t('ui.set.mcp.local')} desc={t('ui.set.mcp.localDesc')}>
                <Switch checked={server.localOk} label={t('ui.set.mcp.local')} disabled={busy} onChange={localOk => setServer({ localOk })} />
              </Row>
              {server.secrets.map(secret => <SecretRow key={`${secret.kind}:${secret.name}`} server={server} secret={secret} ops={ops} />)}
              {server.tools.length === 0 && <p className="bt-meta">{server.state === 'ready' ? t('ui.set.mcp.noTools') : t('ui.set.mcp.notConnected')}</p>}
              {server.tools.map(tool => <ToolRow key={tool.name} server={server} tool={tool} ops={ops} />)}
              {server.stderr !== '' && <details className="bt-meta"><summary>{t('ui.set.mcp.stderr')}</summary><pre className="bt-doc ui-set__pre">{server.stderr}</pre></details>}
            </div>
          )}
        </>
      )}>
      <Pill {...(pillTone ? { tone: pillTone } : {})}>{t(`settings.mcp.state.${server.state}`)}</Pill>
      <Switch checked={server.enabled} label={t('ui.set.mcp.serverSwitch', server.id)} disabled={busy} onChange={enabled => setServer({ enabled })} />
      <Button small variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('ui.set.less') : t('ui.set.edit')}</Button>
    </Row>
  );
}

function AddServer({ taken, ops, onDone }: { taken: string[]; ops: McpOps; onDone: () => void }) {
  const t = useT();
  const ctx = useSet();
  const [form, setForm] = useState<AddForm>(emptyAddForm);
  const [shown, setShown] = useState(false);
  const set = (patch: Partial<AddForm>) => setForm(old => ({ ...old, ...patch }));
  const problem = addProblem(form, taken);
  const kind = form.transport === 'stdio' ? 'env' : 'header';
  const submit = async () => {
    setShown(true);
    if (problem !== null) return;
    const ok = await ops.guarded('mcp:add', latest => accessWidening(latest, previewAdd(latest, addSpec(form))), () => api.addMcpServer(addBody(form)), t('ui.set.mcp.added'));
    if (ok) { setForm(scrubSecrets(form)); onDone(); }
  };
  return (
    <div className="ui-set__form ui-set__form--stack">
      <label className="bt-form-row"><span className="bt-label">{t('ui.set.mcp.name')}</span>
        <input className="bt-field" value={form.name} spellCheck={false} onChange={e => set({ name: e.target.value, ...(form.idTouched ? {} : { id: idFromName(e.target.value) }) })} /></label>
      <label className="bt-form-row"><span className="bt-label">{t('ui.set.mcp.id')}</span>
        <input className="bt-field bt-field--mono" value={form.id} spellCheck={false} onChange={e => set({ id: e.target.value, idTouched: true })} /></label>
      <Seg value={form.transport} label={t('ui.set.mcp.transport')} options={[{ value: 'stdio', label: t('ui.set.mcp.stdio') }, { value: 'http', label: 'HTTP' }]} onChange={transport => set({ transport, rows: [] })} />
      {form.transport === 'stdio' ? (
        <>
          <label className="bt-form-row"><span className="bt-label">{t('ui.set.mcp.program')}</span><input className="bt-field bt-field--mono" value={form.program} placeholder="npx" spellCheck={false} onChange={e => set({ program: e.target.value })} /></label>
          <label className="bt-form-row"><span className="bt-label">{t('ui.set.mcp.args')}</span><textarea className="bt-field bt-field--mono ui-set__args" value={form.args} spellCheck={false} onChange={e => set({ args: e.target.value })} /></label>
          <label className="bt-form-row"><span className="bt-label">{t('ui.set.mcp.cwd')}</span><input className="bt-field bt-field--mono" value={form.cwd} spellCheck={false} onChange={e => set({ cwd: e.target.value })} /></label>
        </>
      ) : (
        <label className="bt-form-row"><span className="bt-label">{t('ui.set.mcp.url')}</span><input className="bt-field bt-field--mono" value={form.url} placeholder="https://mcp.example.com/mcp" spellCheck={false} onChange={e => set({ url: e.target.value })} /></label>
      )}
      <span className="bt-label">{kind === 'env' ? t('ui.set.mcp.envTitle') : t('ui.set.mcp.headersTitle')}</span>
      {form.rows.map((row, i) => (
        <div key={i} className="ui-set__form">
          <input className="bt-field bt-field--mono" aria-label={t('ui.set.mcp.secretName')} value={row.name} placeholder={kind === 'env' ? 'API_TOKEN' : 'Authorization'} spellCheck={false} onChange={e => set({ rows: form.rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)) })} />
          <input className="bt-field bt-field--mono" type="password" aria-label={t('ui.set.mcp.secretValue')} value={row.value} autoComplete="new-password" spellCheck={false} onChange={e => set({ rows: form.rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)) })} />
          <Button small variant="ghost" icon="x" aria-label={t('ui.set.list.remove', row.name)} onClick={() => set({ rows: form.rows.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <span><Button small variant="ghost" icon="plus" disabled={form.rows.length >= 16} onClick={() => set({ rows: [...form.rows, { name: '', value: '' }] })}>{t('ui.set.mcp.addSecret')}</Button></span>
      {shown && problem !== null && <p className="bt-meta bt-del" role="alert">{t(`settings.mcp.problem.${problem}`)}</p>}
      <span className="ui-confirm__buttons">
        <Button small variant="primary" disabled={ctx.busy !== null} onClick={() => void submit()}>{t('ui.set.add')}</Button>
        <Button small variant="ghost" onClick={() => { setForm(scrubSecrets(form)); ctx.cancel(); onDone(); }}>{t('ui.cancel')}</Button>
      </span>
    </div>
  );
}

export function McpPanel() {
  const t = useT();
  const { view, ops } = useMcp();
  const [adding, setAdding] = useState(false);
  if (view === null || view === 'failed') return <p className="bt-meta" role={view === 'failed' ? 'alert' : 'status'}>{view === 'failed' ? t('ui.set.loadFailed') : t('ui.set.loading')}</p>;
  const full = view.servers.length >= view.limits.maxServers;
  return (
    <Group title={t('ui.set.mcp.connected')}>
      {view.servers.length === 0 && <p className="bt-meta">{t('ui.set.mcp.none')}</p>}
      {view.servers.map(server => <ServerRow key={server.id} server={server} ops={ops} max={view.limits.maxToolsPerServer} />)}
      <Row k="mcp:add" title={t('ui.set.mcp.add')} desc={full ? t('ui.set.mcp.full', view.limits.maxServers) : t('ui.set.mcp.addDesc')}
        below={adding && <AddServer taken={view.servers.map(s => s.id)} ops={ops} onDone={() => setAdding(false)} />}>
        {!adding && <Button small disabled={full} onClick={() => setAdding(true)}>{t('ui.set.mcp.addShort')}</Button>}
      </Row>
    </Group>
  );
}
