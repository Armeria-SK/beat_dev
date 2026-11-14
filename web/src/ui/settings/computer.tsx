import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type BrowserStatusView } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { useT } from '../../i18n/index.ts';
import { updateAt, type Config } from '../../settings/model.ts';
import { applyFailure, applyStep } from '../../settings/server-apply.ts';
import { addRoot, foldersFromConfig, removeRoot, setRootMode, type RootMode } from '../../skills-meta.ts';
import { Button } from '../parts.tsx';
import { RowConfirm } from '../RowConfirm.tsx';
import { CommitField, Group, ListField, NumberField, Row, Seg, Switch, useSet } from './controls.tsx';

type Json = Record<string, any>;
const errorText = (error: unknown, fallback: string): string => (error instanceof ApiError ? error.message : fallback);

export function FoldersPanel() {
  const t = useT();
  const ctx = useSet();
  const folders = foldersFromConfig(ctx.config);
  const [removing, setRemoving] = useState<string | null>(null);
  const setRoots = (row: string, make: (config: Config) => Json[]) => void ctx.commit(row, c => updateAt(c, 'tools', { roots: make(c) }));
  const modes = [{ value: 'read' as RootMode, label: t('ui.set.folders.read') }, { value: 'write' as RootMode, label: t('ui.set.folders.write') }];
  const busy = ctx.busy !== null;
  return (
    <>
      <Group title={t('ui.set.folders.allowed')}>
        {folders.roots.length === 0 && <p className="bt-meta">{t('ui.set.folders.none')}</p>}
        {folders.roots.map(root => {
          const k = `root:${root.path}`;
          return (
            <Row key={root.path} k={k} title={<code className="bt-meta">{root.path}</code>} desc={root.mode === 'write' ? t('ui.set.folders.write') : t('ui.set.folders.read')}
              below={removing === root.path && <RowConfirm warn={t('ui.set.folders.removeWarn')} action={t('ui.set.folders.remove')} busy={busy} onConfirm={() => { setRemoving(null); setRoots(k, c => removeRoot(foldersFromConfig(c), root.path).roots); }} onKeep={() => setRemoving(null)} />}>
              <Seg value={root.mode} options={modes} label={t('ui.set.folders.mode', root.path)} disabled={busy} onChange={mode => setRoots(k, c => setRootMode(foldersFromConfig(c), root.path, mode).roots)} />
              {removing !== root.path && <Button small variant="ghost" disabled={busy} onClick={() => setRemoving(root.path)}>{t('ui.set.folders.remove')}</Button>}
            </Row>
          );
        })}
        <Row k="root:add" title={t('ui.set.folders.add')} desc={t('ui.set.folders.addDesc')}>
          <CommitField value="" label={t('ui.set.folders.addField')} mono placeholder={t('ui.set.folders.addPh')} resetKey={folders.roots.map(r => r.path).join('\n')} onCommit={path => { if (path) setRoots('root:add', c => addRoot(foldersFromConfig(c), path, 'read').roots); }} />
        </Row>
        <p className="bt-meta">{t('ui.product.foldersNote')}</p>
      </Group>
      <Group title={t('ui.set.folders.limits')}>
        <Row k="folders:deny" title={t('ui.set.folders.deny')} desc={t('ui.set.folders.denyDesc')}
          below={<ListField items={folders.deny} label={t('ui.set.folders.deny')} placeholder="~/.ssh" disabled={busy} onChange={deny => void ctx.commit('folders:deny', c => updateAt(c, 'tools', { deny }))} />} />
        <Row k="folders:outside" title={t('ui.set.folders.outside')} desc={t('ui.set.folders.outsideDesc')}>
          <Seg value={(ctx.config.tools?.outsideRoots as string | undefined) ?? 'ask'} label={t('ui.set.folders.outside')} disabled={busy}
            options={[{ value: 'ask', label: t('ui.tools.ask') }, { value: 'deny', label: t('ui.tools.block') }]}
            onChange={outsideRoots => void ctx.commit('folders:outside', c => updateAt(c, 'tools', { outsideRoots }))} />
        </Row>
      </Group>
    </>
  );
}

type Stage = 'preToolUse' | 'postToolUse';
interface CommandHook { matcher: string; command: string[]; timeoutMs: number; onError: 'deny' | 'ask'; enabled?: boolean; builtin?: undefined }
interface BuiltinHook { matcher: string; builtin: string; always: string[]; afterOutside: string[]; enabled?: boolean; command?: undefined; timeoutMs?: undefined; onError?: undefined }
type Hook = CommandHook | BuiltinHook;

function hooksOf(config: Config, stage: Stage): Hook[] {
  const list = config.tools?.hooks?.[stage];
  return Array.isArray(list) ? list as Hook[] : [];
}

function setHooks(config: Config, stage: Stage, hooks: Hook[]): Config {
  return updateAt(config, 'tools', { hooks: { ...((config.tools as Config).hooks ?? {}), [stage]: hooks } });
}

function HookRow({ stage, index, hook }: { stage: Stage; index: number; hook: Hook }) {
  const t = useT();
  const name = hook.builtin !== undefined ? t('ui.set.hooks.protect') : hook.command.join(' ');
  const ctx = useSet();
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const k = `hook:${stage}:${index}`;
  const edit = (patch: Partial<Omit<CommandHook, 'builtin'>> | Partial<Pick<BuiltinHook, 'always' | 'afterOutside'>>) => void ctx.commit(k, c => setHooks(c, stage, hooksOf(c, stage).map((h, i) => (i === index ? { ...h, ...patch } as Hook : h))));
  const busy = ctx.busy !== null;
  const on = hook.enabled !== false;
  return (
    <Row k={k} title={hook.builtin !== undefined ? name : <code className="bt-meta">{name}</code>} desc={t(on ? 'ui.set.hooks.when' : 'ui.set.hooks.whenOff', hook.matcher)}
      below={(removing || open) && (
        <>
          {removing && <RowConfirm warn={t('ui.set.hooks.removeWarn')} action={t('ui.set.hooks.remove')} busy={busy} onConfirm={() => { setRemoving(false); void ctx.commit(k, c => setHooks(c, stage, hooksOf(c, stage).filter((_, i) => i !== index))); }} onKeep={() => setRemoving(false)} />}
          {open && hook.builtin !== undefined && (
            <div className="ui-set__detail">
              <Row k={`${k}:matcher`} title={t('ui.set.hooks.matcher')} desc={t('ui.set.hooks.matcherDesc')}>
                <CommitField value={hook.matcher} label={t('ui.set.hooks.matcher')} mono required onCommit={matcher => edit({ matcher })} />
              </Row>
              <Row k={`${k}:always`} title={t('ui.set.hooks.always')} desc={t('ui.set.hooks.alwaysDesc')}
                below={<ListField items={hook.always} label={t('ui.set.hooks.always')} placeholder=".github/workflows/**" disabled={busy} onChange={always => edit({ always })} />} />
              <Row k={`${k}:afterOutside`} title={t('ui.set.hooks.afterOutside')} desc={t('ui.set.hooks.afterOutsideDesc')}
                below={<ListField items={hook.afterOutside} label={t('ui.set.hooks.afterOutside')} placeholder="package.json" disabled={busy} onChange={afterOutside => edit({ afterOutside })} />} />
            </div>
          )}
          {open && hook.builtin === undefined && (
            <div className="ui-set__detail">
              <Row k={`${k}:matcher`} title={t('ui.set.hooks.matcher')} desc={t('ui.set.hooks.matcherDesc')}>
                <CommitField value={hook.matcher} label={t('ui.set.hooks.matcher')} mono required onCommit={matcher => edit({ matcher })} />
              </Row>
              <Row k={`${k}:command`} title={t('ui.set.hooks.command')} desc={t('ui.set.hooks.commandDesc')}
                below={<ListField items={hook.command} allowDuplicates label={t('ui.set.hooks.command')} placeholder="node" disabled={busy} onChange={command => { if (command.length) edit({ command }); }} />} />
              <Row k={`${k}:timeout`} title={t('ui.set.hooks.timeout')} desc={t('ui.set.unit.ms')}>
                <NumberField k={`${k}:timeout`} value={hook.timeoutMs} min={100} max={120_000} label={t('ui.set.hooks.timeout')} onCommit={v => { if (v !== undefined) edit({ timeoutMs: v }); }} />
              </Row>
              <Row k={`${k}:onError`} title={t('ui.set.hooks.onError')} desc={t('ui.set.hooks.onErrorDesc')}>
                <Seg value={hook.onError} label={t('ui.set.hooks.onError')} disabled={busy} options={[{ value: 'deny', label: t('ui.tools.block') }, { value: 'ask', label: t('ui.tools.ask') }]} onChange={onError => edit({ onError })} />
              </Row>
            </div>
          )}
        </>
      )}>
      <Switch checked={on} label={t('ui.set.hooks.on', name)} disabled={busy} onChange={enabled => edit({ enabled })} />
      <Button small variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('ui.set.less') : t('ui.set.edit')}</Button>
      {!removing && <Button small variant="ghost" disabled={busy} onClick={() => setRemoving(true)}>{t('ui.set.hooks.remove')}</Button>}
    </Row>
  );
}

function AddHook({ stage, onDone }: { stage: Stage; onDone: () => void }) {
  const t = useT();
  const ctx = useSet();
  const [matcher, setMatcher] = useState('.*');
  const [command, setCommand] = useState('');
  const args = command.split(/\r?\n/u).map(x => x.trim()).filter(Boolean);
  const add = async () => {
    const ok = await ctx.commit(`hooks:add:${stage}`, c => setHooks(c, stage, [...hooksOf(c, stage), { matcher: matcher.trim(), command: args, timeoutMs: 30_000, onError: 'deny' }]));
    if (ok) onDone();
  };
  return (
    <div className="ui-set__form ui-set__form--stack">
      <label className="bt-form-row"><span className="bt-label">{t('ui.set.hooks.matcher')}</span><input className="bt-field bt-field--mono" value={matcher} spellCheck={false} onChange={e => setMatcher(e.target.value)} /></label>
      <label className="bt-form-row"><span className="bt-label">{t('ui.set.hooks.commandLines')}</span><textarea className="bt-field bt-field--mono ui-set__args" value={command} spellCheck={false} placeholder={'node\nscripts/check.js'} onChange={e => setCommand(e.target.value)} /></label>
      <span className="ui-confirm__buttons">
        <Button small variant="primary" disabled={ctx.busy !== null || !matcher.trim() || args.length === 0} onClick={() => void add()}>{t('ui.set.add')}</Button>
        <Button small variant="ghost" onClick={() => { ctx.cancel(); onDone(); }}>{t('ui.cancel')}</Button>
      </span>
    </div>
  );
}

export function HooksPanel() {
  const t = useT();
  const ctx = useSet();
  const [adding, setAdding] = useState<Stage | null>(null);
  return (
    <>
      {(['preToolUse', 'postToolUse'] as const).map(stage => {
        const hooks = hooksOf(ctx.config, stage);
        return (
          <Group key={stage} title={t(stage === 'preToolUse' ? 'ui.set.hooks.pre' : 'ui.set.hooks.post')}>
            {hooks.length === 0 && <p className="bt-meta">{t('ui.set.hooks.none')}</p>}
            {hooks.map((hook, i) => <HookRow key={`${i}:${hook.matcher}:${hook.builtin ?? hook.command.join(' ')}`} stage={stage} index={i} hook={hook} />)}
            <Row k={`hooks:add:${stage}`} title={t('ui.set.hooks.add')} desc={t(stage === 'preToolUse' ? 'ui.set.hooks.preDesc' : 'ui.set.hooks.postDesc')}
              below={adding === stage && <AddHook stage={stage} onDone={() => setAdding(null)} />}>
              {adding !== stage && <Button small onClick={() => setAdding(stage)}>{t('ui.set.hooks.addShort')}</Button>}
            </Row>
          </Group>
        );
      })}
    </>
  );
}

const BROWSER_POLL_MS = 3000;

export function BrowserPanel() {
  const t = useT();
  const ctx = useSet();
  const browser = (ctx.config.tools?.browser ?? {}) as Json;
  const limits = (browser.limits ?? {}) as Record<string, number>;
  const [status, setStatus] = useState<BrowserStatusView | 'failed' | null>(null);
  const [clearing, setClearing] = useState(false);
  const acting = useRef(false);
  useEffect(() => {
    let live = true;
    const load = () => { if (!acting.current) api.browserStatus().then(next => { if (live && !acting.current) setStatus(next); }).catch(() => { if (live) setStatus(old => old ?? 'failed'); }); };
    load();
    const timer = setInterval(load, BROWSER_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const act = useCallback(async (run: () => Promise<BrowserStatusView>, done: string) => {
    acting.current = true; ctx.setBusy('browser:state'); ctx.clear('browser:state'); setClearing(false);
    try { setStatus(await run()); toast({ icon: 'check', title: done }); }
    catch (error) { ctx.fail('browser:state', errorText(error, t('ui.set.browser.failed'))); }
    finally { acting.current = false; ctx.setBusy(null); }
  }, [ctx, t]);
  const set = (row: string, patch: Json) => void ctx.commit(row, c => updateAt(c, 'tools', { browser: { ...((c.tools as Config).browser as Json), ...patch } }));
  const current = status !== null && status !== 'failed' ? status : null;
  const stateText = (s: BrowserStatusView): string => {
    if (!s.enabled) return t('ui.set.browser.state.off');
    if (s.loginOpen) return t('ui.set.browser.state.login');
    if (s.pausedMinutes > 0) return t('ui.set.browser.state.paused', s.pausedMinutes);
    if (s.running) return t('ui.set.browser.state.running', s.tabs);
    return t('ui.set.browser.state.idle');
  };
  const busy = ctx.busy !== null;
  const limitRow = (key: string, label: string, min: number, max: number, unit?: string) => (
    <Row k={`browser:${key}`} title={label} desc={unit}>
      <NumberField k={`browser:${key}`} value={limits[key]} min={min} max={max} label={label} onCommit={v => { if (v !== undefined) set(`browser:${key}`, { limits: { ...limits, [key]: v } }); }} />
    </Row>
  );
  return (
    <>
      <Group title={t('ui.set.browser.title')}>
        <Row k="browser:use" title={t('ui.set.browser.use')} desc={t('ui.set.browser.useDesc')}>
          <Switch checked={browser.enabled === true} label={t('ui.set.browser.use')} disabled={busy} onChange={enabled => set('browser:use', { enabled })} />
        </Row>
        <Row k="browser:sites" title={t('ui.set.browser.sites')} desc={t('ui.set.browser.sitesDesc')}
          below={<ListField items={(browser.sites ?? []) as string[]} label={t('ui.set.browser.sites')} placeholder="example.com" disabled={busy} onChange={sites => set('browser:sites', { sites })} />} />
        <Row k="browser:state" title={t('ui.set.browser.profile')} desc={current ? stateText(current) : status === 'failed' ? t('ui.set.loadFailed') : t('ui.set.loading')}
          below={clearing && <RowConfirm warn={t('ui.set.browser.clearWarn')} note={t('ui.set.browser.clearNote')} action={t('ui.set.browser.clear')} busy={busy} onConfirm={() => void act(api.browserProfileReset, t('ui.set.browser.cleared'))} onKeep={() => setClearing(false)} />}>
          <Button small disabled={busy || !current || !current.enabled || current.loginOpen || !current.canShowWindow} onClick={() => void act(api.browserLogin, t('ui.set.browser.opened'))}>{t('ui.set.browser.open')}</Button>
          <Button small variant="ghost" disabled={busy || !current || !(current.running || current.loginOpen)} onClick={() => void act(api.browserClose, t('ui.set.browser.closed'))}>{t('ui.set.browser.close')}</Button>
          {!clearing && <Button small variant="ghost" disabled={busy || !current} onClick={() => setClearing(true)}>{t('ui.set.browser.clear')}</Button>}
        </Row>
        <Row k="browser:show" title={t('ui.set.browser.show')} desc={current && !current.canShowWindow ? t('ui.set.browser.noDisplay') : t('ui.set.browser.showDesc')}>
          <Switch checked={browser.headless === false} label={t('ui.set.browser.show')} disabled={busy} onChange={show => set('browser:show', { headless: !show })} />
        </Row>
        <Row k="browser:channel" title={t('ui.set.browser.channel')}>
          <Seg value={(browser.channel as string | undefined) ?? 'auto'} label={t('ui.set.browser.channel')} disabled={busy}
            options={[{ value: 'auto', label: t('ui.set.browser.channel.auto') }, { value: 'chrome', label: 'Chrome' }, { value: 'path', label: t('ui.set.browser.channel.path') }]}
            onChange={channel => set('browser:channel', { channel })} />
        </Row>
        {browser.channel === 'path' && (
          <Row k="browser:path" title={t('ui.set.browser.path')} desc={t('ui.set.browser.pathDesc')}>
            <CommitField value={(browser.executablePath as string | undefined) ?? ''} label={t('ui.set.browser.path')} mono onCommit={executablePath => set('browser:path', { executablePath })} />
          </Row>
        )}
      </Group>
      <Group title={t('ui.set.browser.limits')}>
        {limitRow('maxTabs', t('ui.set.browser.maxTabs'), 1, 8)}
        {limitRow('navigationTimeoutSec', t('ui.set.browser.navTimeout'), 5, 120, t('ui.set.unit.seconds'))}
        {limitRow('actionTimeoutSec', t('ui.set.browser.actionTimeout'), 1, 60, t('ui.set.unit.seconds'))}
        {limitRow('idleCloseMinutes', t('ui.set.browser.idleClose'), 1, 120, t('ui.set.unit.minutes'))}
        {limitRow('pageChars', t('ui.set.browser.pageChars'), 2000, 100_000)}
        {limitRow('maxMbPerMinute', t('ui.set.browser.maxMb'), 1, 500, t('ui.set.unit.mbPerMinute'))}
      </Group>
    </>
  );
}

export function ServerPanel() {
  const t = useT();
  const ctx = useSet();
  const server = (ctx.config.server ?? {}) as Json;
  const [lockout, setLockout] = useState<string | null>(null);
  const [moved, setMoved] = useState<string | null>(null);
  const set = (row: string, patch: Json) => void ctx.commit(row, c => updateAt(c, 'server', patch));
  const busy = ctx.busy !== null;
  const apply = async (force: boolean) => {
    ctx.setBusy('server:restart'); ctx.clear('server:restart'); setLockout(null);
    try {
      const step = applyStep(await api.applyServer(force), location.hash);
      if (step.kind === 'moved') setMoved(step.url); else toast({ icon: 'check', title: t('ui.set.server.applied') });
      await ctx.reload();
    } catch (error) {
      const failure = applyFailure(error);
      if (failure.kind === 'lockout') setLockout(failure.message);
      else if (failure.kind === 'nothing') { toast({ icon: 'info', title: t('ui.set.server.nothing') }); await ctx.reload(); }
      else ctx.fail('server:restart', failure.message ?? t('ui.set.server.failed'));
    } finally { ctx.setBusy(null); }
  };
  return (
    <>
      <Group title={t('ui.set.server.title')}>
        <Row k="server:port" title={t('ui.set.server.port')} desc={t('ui.set.server.portDesc')}>
          <NumberField k="server:port" value={server.port as number} min={1} max={65535} label={t('ui.set.server.port')} onCommit={port => set('server:port', { port })} />
        </Row>
        <Row k="server:restart" title={t('ui.set.server.restart')} desc={ctx.view.restartRequired ? t('ui.set.server.restartNeeded') : t('ui.set.server.restartNone')}
          below={(lockout !== null || moved !== null) && (
            <>
              {lockout !== null && (
                <div className="ui-confirm ui-set__widen" role="alertdialog" aria-label={t('ui.set.server.lockout')}>
                  <span className="bt-label bt-del">{t('ui.set.server.lockout')}</span>
                  <span className="bt-meta ui-confirm__note">{lockout}</span>
                  <span className="ui-confirm__buttons">
                    <Button small variant="danger" disabled={busy} onClick={() => void apply(true)}>{t('ui.set.server.lockoutDo')}</Button>
                    <Button small variant="ghost" autoFocus onClick={() => setLockout(null)}>{t('ui.cancel')}</Button>
                  </span>
                </div>
              )}
              {moved !== null && <p className="bt-meta" role="status">{t('ui.set.server.moved')} <code>{moved}</code></p>}
            </>
          )}>
          <Button small disabled={busy || !ctx.view.restartRequired} onClick={() => void apply(false)}>{t('ui.set.server.apply')}</Button>
        </Row>
      </Group>
      <Group title={t('ui.set.server.remote')}>
        <Row k="server:origins" title={t('ui.set.server.origins')} desc={t('ui.set.server.originsDesc')}
          below={<ListField items={(server.origins ?? []) as string[]} label={t('ui.set.server.origins')} placeholder="https://…ts.net" disabled={busy} onChange={origins => set('server:origins', { origins })} />} />
        <Row k="server:logins" title={t('ui.set.server.logins')} desc={t('ui.set.server.loginsDesc')}
          below={<ListField items={(server.tailscaleLogins ?? []) as string[]} label={t('ui.set.server.logins')} placeholder="name@example.com" disabled={busy} onChange={tailscaleLogins => set('server:logins', { tailscaleLogins })} />} />
      </Group>
    </>
  );
}
