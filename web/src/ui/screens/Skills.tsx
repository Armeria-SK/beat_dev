import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, ApiError, type SkillDraft, type SkillSummary, type SkillVersion, type ToolInfo } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { formatDateTime, formatRelative, useT } from '../../i18n/index.ts';
import { Markdown } from '../../Markdown.tsx';
import type { Access } from '../../settings/access.ts';
import { findDraft, orderTools, POLICY_LABEL, toolLook } from '../../skills-meta.ts';
import { lineDelta } from '../../../../src/shared/line-delta.ts';
import type { ToolPolicy } from '../../../../src/tools/tool-policy.ts';
import { DiscardConfirm, useDiscardAsk } from '../Discard.tsx';
import { useNow } from '../hooks.ts';
import { latestOnly } from '../latest.ts';
import { policyChoices, ROW_LEAVE_MS, skillHistory, toolCounts, toolDecision, type SkillChange } from '../library.ts';
import { Button, CountBadge, EmptyState, Icon, Notice } from '../parts.tsx';
import { routeHash, type SkillTarget } from '../routes.ts';
import { RowConfirm } from '../RowConfirm.tsx';
import { SCREEN_EDITS, setUnsaved } from '../unsaved.ts';

type T = ReturnType<typeof useT>;
type Skill = SkillSummary & { body: string };

const ASKS_KEY = { sends: 'tools.mcp.asks.sends', removes: 'tools.mcp.asks.removes', write: 'tools.mcp.asks.write' } as const;

const failText = (error: unknown, t: T): string => (error instanceof ApiError ? error.message : t('ui.skills.toast.failed'));
const skillHash = (name: string | null): string => routeHash(name ? { view: 'skills', target: { kind: 'skill', name } } : { view: 'skills' });
const draftHash = (name: string | null): string => routeHash(name ? { view: 'skills', target: { kind: 'draft', name } } : { view: 'skills' });

function Delta({ added, removed }: { added: number; removed: number }) {
  if (!added && !removed) return null;
  return <> · {added > 0 && <span className="bt-add">+{added}</span>}{added > 0 && removed > 0 && ' '}{removed > 0 && <span className="bt-del">−{removed}</span>}</>;
}

function changeLabel(t: T, change: SkillChange): string {
  if (change.oldest) return t(change.created ? 'ui.skills.change.beforeAuto' : 'ui.skills.change.oldest');
  if (change.auto) return t(change.created ? 'ui.skills.change.autoNew' : 'ui.skills.change.auto');
  return t(change.who === 'you' ? 'ui.skills.change.you' : 'ui.skills.change.beat');
}

function NewSkill({ existing, onSaved, onClose }: { existing: readonly string[]; onSaved: (name: string) => void; onClose: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = name.trim() && description.trim() && body.trim();
  const typed = name !== '' || description !== '' || body !== '';
  useEffect(() => { setUnsaved(`${SCREEN_EDITS}skill-new`, typed); return () => setUnsaved(`${SCREEN_EDITS}skill-new`, false); }, [typed]);
  const ask = useDiscardAsk(() => typed);
  const close = () => ask.attempt(onClose);
  const taken = existing.includes(name.trim());
  const save = async () => {
    if (busy || !ready) return;
    setBusy(true); setError('');
    try {
      await api.saveSkill(name.trim(), description.trim(), body);
      toast({ icon: 'check', title: t('ui.skills.toast.saved'), body: name.trim() });
      setUnsaved(`${SCREEN_EDITS}skill-new`, false);
      onSaved(name.trim());
    } catch (failure) { setError(failText(failure, t)); } finally { setBusy(false); }
  };
  return (
    <section className="bt-pane bt-rise ui-lib__pane" aria-label={t('ui.skills.new')}
      onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}>
      <div className="bt-pane__body ui-lib__form">
        <DiscardConfirm ask={ask} />
        <label className="ui-lib__label"><span className="bt-label">{t('ui.skills.field.name')}</span>
          <input className="bt-field bt-field--mono" autoFocus value={name} maxLength={63} spellCheck={false} placeholder={t('ui.skills.namePlaceholder')} onChange={e => setName(e.target.value)} />
        </label>
        {taken && <p className="bt-meta ui-danger" role="status">{t('ui.skills.exists')}</p>}
        <label className="ui-lib__label"><span className="bt-label">{t('ui.skills.field.description')}</span>
          <input className="bt-field" value={description} maxLength={300} onChange={e => setDescription(e.target.value)} />
        </label>
        <label className="ui-lib__label"><span className="bt-label">{t('ui.skills.field.body')}</span>
          <textarea className="bt-doc bt-doc--edit ui-lib__editor" rows={8} value={body} maxLength={20_000} spellCheck={false} onChange={e => setBody(e.target.value)} />
        </label>
        {error && <p className="bt-meta ui-danger" role="alert">{error}</p>}
        <span className="ui-lib__buttons">
          <Button variant="primary" small disabled={busy || !ready} onClick={() => void save()}>{t(taken ? 'ui.skills.replace' : 'ui.lib.save')}</Button>
          <Button variant="ghost" small onClick={close}>{t('ui.cancel')}</Button>
        </span>
      </div>
    </section>
  );
}

function SkillDetail({ name, revision, now, onChanged }: { name: string; revision: string; now: number; onChanged: () => void }) {
  const t = useT();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [versions, setVersions] = useState<SkillVersion[] | null>(null);
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const loads = useRef(latestOnly());
  const deleteButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const ticket = loads.current.begin();
    void Promise.all([api.skill(name), api.skillHistory(name)]).then(([one, history]) => {
      if (!loads.current.isCurrent(ticket)) return;
      setSkill(one.skill); setVersions(history.versions);
    }).catch(failure => {
      if (!loads.current.isCurrent(ticket)) return;
      if (failure instanceof ApiError && failure.status === 404) location.replace(skillHash(null));
      else setError(failText(failure, t));
    });
  }, [name, revision, tick, t]);
  useEffect(() => { if (skill && mode === 'read') { setDescription(skill.description); setBody(skill.body); } }, [skill, mode]);
  const edited = mode === 'edit' && skill !== null && (description !== skill.description || body !== skill.body);
  useEffect(() => { setUnsaved(`${SCREEN_EDITS}skill:${name}`, edited); return () => setUnsaved(`${SCREEN_EDITS}skill:${name}`, false); }, [name, edited]);
  const toRead = () => { if (edited) setDropping(true); else { setMode('read'); setError(''); } };

  const changes = useMemo(() => (skill && versions ? skillHistory(versions, { description: skill.description, body: skill.body }) : []), [skill, versions]);
  const reload = () => { setTick(n => n + 1); onChanged(); };
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); } catch (failure) { setError(failText(failure, t)); } finally { setBusy(false); }
  };
  const save = () => void run(async () => {
    if (!skill) return;
    if (description.trim() === skill.description && body === skill.body) { setMode('read'); return; }
    await api.saveSkill(name, description.trim(), body);
    setMode('read');
    reload();
    toast({ icon: 'check', title: t('ui.skills.toast.saved'), body: name });
  });
  const putBack = (change: SkillChange) => void run(async () => {
    if (change.action === 'delete') { setConfirming(true); return; }
    if (!change.target) return;
    await api.saveSkill(name, change.target.description, change.target.body);
    reload();
    toast({ icon: 'undo', title: t(change.action === 'undo' ? 'ui.skills.toast.undone' : 'ui.skills.toast.restored'), body: name });
  });
  const register = () => void run(async () => {
    await api.registerSkill(name);
    reload();
    toast({ icon: 'check', title: t('ui.skills.toast.registered'), body: name });
  });
  const remove = () => void run(async () => {
    await api.deleteSkill(name);
    setUnsaved(`${SCREEN_EDITS}skill:${name}`, false);
    setConfirming(false);
    onChanged();
    location.hash = skillHash(null);
    toast({ icon: 'x', title: t('ui.skills.toast.deleted'), body: name });
  });

  if (!skill) return <div className="ui-lib__detail">{error ? <p className="bt-meta ui-danger" role="alert">{error}</p> : null}</div>;
  return (
    <section className="bt-pane ui-lib__pane ui-lib__detail" aria-label={name}>
      <div className="bt-pane__body">
        <div className="bt-pane__bar">
          <span className="bt-meta">skills/{name}/SKILL.md</span>
          <div className="bt-seg" role="group" aria-label={t('ui.lib.mode')}>
            <button type="button" className="bt-seg__opt" aria-pressed={mode === 'read'} onClick={toRead}>{t('ui.lib.read')}</button>
            <button type="button" className="bt-seg__opt" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>{t('ui.lib.edit')}</button>
          </div>
          {mode === 'edit' && <Button small disabled={busy || !description.trim() || !body.trim()} onClick={save}>{t('ui.lib.save')}</Button>}
          {!skill.registered && mode === 'read' && <Button small variant="primary" disabled={busy} onClick={register}>{t('ui.skills.register')}</Button>}
          {!confirming && <Button ref={deleteButton} small variant="ghost" disabled={busy} onClick={() => setConfirming(true)}>{t('ui.lib.delete')}</Button>}
        </div>
        {confirming && (
          <RowConfirm warn={t('ui.lib.deleteWarn')} note={t('ui.skills.deleteNote')} action={t('ui.lib.delete')} busy={busy}
            onConfirm={remove} onKeep={refocus => { setConfirming(false); if (refocus) requestAnimationFrame(() => deleteButton.current?.focus()); }} />
        )}
        {dropping && (
          <RowConfirm warn={t('ui.set.leave.title')} action={t('ui.set.leave.discard')} busy={busy}
            onConfirm={() => { setDropping(false); setMode('read'); setError(''); }} onKeep={() => setDropping(false)} />
        )}
        {mode === 'edit' ? (
          <div className="ui-lib__form" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); toRead(); } }}>
            <label className="ui-lib__label"><span className="bt-label">{t('ui.skills.field.description')}</span>
              <input className="bt-field" autoFocus value={description} maxLength={300} onChange={e => setDescription(e.target.value)} />
            </label>
            <textarea className="bt-doc bt-doc--edit ui-lib__editor" rows={12} value={body} maxLength={20_000} spellCheck={false} aria-label={t('ui.skills.field.body')} onChange={e => setBody(e.target.value)} />
          </div>
        ) : (
          <article className="bt-doc">
            <p className="bt-meta">{skill.description}</p>
            <Markdown text={skill.body} />
          </article>
        )}
        {error && <p className="bt-meta ui-danger" role="alert">{error}</p>}
        <div className="bt-section ui-lib__history">
          <div className="bt-section__head"><span className="bt-label">{t('ui.lib.history')}</span><span className="bt-meta">{t('ui.lib.versions', changes.length)}</span></div>
          {versions && changes.length === 0 && <p className="bt-meta">{t('ui.skills.historyEmpty')}</p>}
          {changes.length > 0 && (
            <ul className="bt-list">
              {changes.map(change => (
                <li key={change.key} className="bt-row ui-lib__version">
                  <Icon name={change.oldest ? 'file' : change.created ? 'plus' : 'pencil'} />
                  <div className="bt-row__main">
                    <span className="bt-row__title">{changeLabel(t, change)}</span>
                    {change.version && (
                      <span className="bt-row__sub bt-meta" title={formatDateTime(change.version.at, 'full')}>
                        {t(change.who === 'you' ? 'ui.lib.you' : 'ui.lib.beat')} · {formatRelative(change.version.at, now)}{change.delta && <Delta {...change.delta} />}
                      </span>
                    )}
                  </div>
                  {change.action && (
                    <div className="bt-row__end">
                      {change.action === 'undo' && <Button small icon="undo" disabled={busy} onClick={() => putBack(change)}>{t('ui.lib.undo')}</Button>}
                      {change.action === 'restore' && <Button small variant="ghost" disabled={busy} onClick={() => putBack(change)}>{t('ui.lib.restore')}</Button>}
                      {change.action === 'delete' && <Button small variant="ghost" className="bt-btn--danger" disabled={busy || confirming} onClick={() => putBack(change)}>{t('ui.lib.delete')}</Button>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function DraftRow({ draft, open, now, onDone }: { draft: SkillDraft; open: boolean; now: number; onDone: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [leaving, setLeaving] = useState(false);
  const discardButton = useRef<HTMLButtonElement>(null);
  const delta = draft.current ? lineDelta(draft.current.body, draft.body) : null;
  const decide = async (register: boolean) => {
    if (busy || leaving) return;
    setBusy(true); setError('');
    try {
      if (register) await api.approveDraft(draft.id); else await api.rejectDraft(draft.id);
      setConfirming(false);
      setLeaving(true);
      toast({ icon: register ? 'check' : 'x', title: t(register ? 'ui.skills.toast.registered' : 'ui.skills.toast.discarded'), body: draft.name });
      if (open) location.replace(register ? skillHash(draft.name) : draftHash(null));
      setTimeout(onDone, ROW_LEAVE_MS);
    } catch (failure) { setError(failText(failure, t)); } finally { setBusy(false); }
  };
  const toggle = () => { location.hash = open ? draftHash(null) : draftHash(draft.name); };
  return (
    <>
      <li className={`bt-row bt-row--link ui-lib__draft${open ? ' is-active' : ''}${leaving ? ' is-leaving' : ''}`} onClick={toggle}>
        <div className="bt-row__main">
          <button type="button" className="bt-row__title ui-rowbtn" aria-expanded={open}><code>{draft.name}</code></button>
          <span className="bt-row__sub bt-meta" title={formatDateTime(draft.created_at, 'full')}>
            {draft.from_title ? t('ui.skills.draftedFrom', draft.from_title, formatRelative(draft.created_at, now)) : t('ui.skills.drafted', formatRelative(draft.created_at, now))} · {t(draft.current ? 'ui.skills.draftUpdate' : 'ui.skills.draftNew')}
            {delta && <Delta {...delta} />}
          </span>
        </div>
        {confirming ? (
          <div className="ui-lib__confirmcell" onClick={e => e.stopPropagation()}>
            <RowConfirm warn={t('ui.skills.discardWarn')} note={t('ui.skills.discardNote')} action={t('ui.skills.discard')} busy={busy}
              onConfirm={() => void decide(false)} onKeep={refocus => { setConfirming(false); if (refocus) requestAnimationFrame(() => discardButton.current?.focus()); }} />
          </div>
        ) : (
          <div className="bt-row__end" onClick={e => e.stopPropagation()}>
            <Button variant="primary" small disabled={busy || leaving} onClick={() => void decide(true)}>{t('ui.skills.register')}</Button>
            <Button ref={discardButton} variant="ghost" small disabled={busy || leaving} onClick={() => setConfirming(true)}>{t('ui.skills.discard')}</Button>
          </div>
        )}
      </li>
      {(open || error) && (
        <li className="bt-row ui-lib__open">
          <div className="bt-row__main">
            {error && <p className="bt-meta ui-danger" role="alert">{error}</p>}
            {open && <article className="bt-doc"><p className="bt-meta">{draft.description}</p>{draft.reason && <p className="bt-meta">{draft.reason}</p>}<Markdown text={draft.body} /></article>}
          </div>
        </li>
      )}
    </>
  );
}

function ToolRows({ tools, running, browserOff, onSaved, onFailed }: { tools: ToolInfo[]; running: boolean; browserOff: boolean; onSaved: (tool: ToolInfo) => void; onFailed: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ tool: ToolInfo; to: ToolPolicy; item: Access } | null>(null);
  const counts = toolCounts(tools);
  const focusPolicy = (name: string, to: ToolPolicy) => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-tool="${CSS.escape(name)}"] [data-policy="${to}"]`)?.focus());
  const cancel = (asking: { tool: ToolInfo; to: ToolPolicy }) => { setConfirm(null); focusPolicy(asking.tool.name, asking.to); };
  const apply = async (tool: ToolInfo, to: ToolPolicy, confirmed: Access | null) => {
    setConfirm(null);
    setBusy(tool.name);
    try {
      const fresh = (await api.tools()).tools.find(x => x.name === tool.name);
      if (!fresh) throw new Error(tool.name);
      if (fresh.policy !== tool.policy) onSaved(fresh);
      const decision = toolDecision(fresh, to, confirmed);
      if (decision.kind === 'confirm') { setConfirm({ tool: fresh, to, item: decision.item }); return; }
      if (decision.kind === 'none') return;
      const saved = (await api.setToolPolicy(tool.name, to)).tool;
      onSaved(saved);
      toast({ icon: 'check', title: t('ui.tools.toast.saved', saved.name, t(POLICY_LABEL[saved.policy])), ...(saved.policy === 'ask' && saved.allowedIn.includes('review') ? { body: t('tools.policy.reviewNote') } : {}) });
    } catch (failure) {
      toast({ icon: 'alert', title: t('ui.tools.toast.failed'), body: failText(failure, t) });
      onFailed();
    } finally { setBusy(null); if (confirmed) focusPolicy(tool.name, to); }
  };
  const choose = (tool: ToolInfo, to: ToolPolicy) => {
    if (busy || !tool.configurable) return;
    void apply(tool, to, null);
  };
  return (
    <section className="bt-section bt-rise" style={{ '--bt-i': 3 } as CSSProperties} aria-label={t('ui.skills.tools')}>
      <div className="bt-section__head"><span className="bt-label">{t('ui.skills.tools')}</span><span className="bt-meta">{t('ui.tools.count', counts.allow, counts.ask, counts.block)}</span></div>
      <ul className="bt-list">
        {orderTools(tools).map(tool => {
          const look = toolLook(tool.name);
          const notes = [
            look.desc ? t(look.desc) : null,
            tool.mcp ? t('ui.tools.mcp', tool.mcp.server) : null,
            tool.asks ? t(ASKS_KEY[tool.asks]) : null,
            !tool.configurable ? t('ui.tools.fixed') : null,
            tool.configurable && tool.policy === 'ask' ? t('tools.policy.askNote') : null,
            tool.configurable && tool.policy === 'block' ? t('tools.policy.blockNote') : null,
            tool.configurable && tool.policy === 'ask' && tool.allowedIn.includes('review') ? t('tools.policy.reviewNote') : null,
          ].filter(Boolean).join(' · ');
          const asking = confirm?.tool.name === tool.name ? confirm : null;
          return (
            <li key={tool.name} className="bt-row ui-lib__tool" data-tool={tool.name}>
              <div className="bt-row__main">
                <span className="bt-row__title"><code>{tool.name}</code></span>
                {notes && <span className="bt-row__sub bt-meta">{notes}</span>}
                {tool.askIsBlock && <span className="bt-row__sub bt-meta" role="note">{t('tools.policy.askIsBlock')}</span>}
                {browserOff && tool.name.startsWith('browser_') && <a className="bt-row__sub bt-meta bt-tool__link" href={routeHash({ view: 'settings', section: 'browser' })}>{t('ui.tools.browserOff')}</a>}
              </div>
              <div className="bt-row__end">
                <div className="bt-seg" role="group" aria-label={t('ui.tools.policy', tool.name)}>
                  {policyChoices(tool.name).map(policy => (
                    <button key={policy} type="button" className="bt-seg__opt" data-policy={policy} aria-pressed={tool.policy === policy}
                      disabled={!tool.configurable || busy !== null || asking !== null} onClick={() => choose(tool, policy)}>{t(POLICY_LABEL[policy])}</button>
                  ))}
                </div>
              </div>
              {asking && (
                <div className="ui-confirm ui-lib__widen" role="alertdialog" aria-label={t('ui.tools.confirm')}
                  onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(asking); } }}>
                  <span className="bt-label">{t('ui.tools.confirm')}</span>
                  <span className="bt-meta ui-confirm__note">{t('ui.tools.loosen', asking.tool.name, t(POLICY_LABEL[asking.tool.policy]), t(POLICY_LABEL[asking.to]))}</span>
                  <span className="ui-confirm__buttons">
                    <Button variant="primary" small disabled={busy !== null} onClick={() => void apply(asking.tool, asking.to, asking.item)}>{t('ui.tools.confirmOk')}</Button>
                    <Button variant="ghost" small autoFocus onClick={() => cancel(asking)}>{t('ui.cancel')}</Button>
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {running && <p className="bt-meta">{t('ui.tools.nextCall')}</p>}
    </section>
  );
}

export interface SkillsProps { target?: SkillTarget | undefined; revision: string; running: boolean; onDrafts: (count: number) => void }

export function Skills({ target, revision, running, onDrafts }: SkillsProps) {
  const t = useT();
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [drafts, setDrafts] = useState<SkillDraft[] | null>(null);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [browserOff, setBrowserOff] = useState(false);
  const [creating, setCreating] = useState(false);
  const [tick, setTick] = useState(0);
  const loads = useRef(latestOnly());
  const now = useNow(60_000);
  const report = useRef(onDrafts);
  report.current = onDrafts;

  const load = useCallback(async () => {
    const ticket = loads.current.begin();
    try {
      const [list, review, toolList] = await Promise.all([api.skills(), api.review(), api.tools()]);
      if (!loads.current.isCurrent(ticket)) return;
      setSkills(list.skills); setDrafts(review.skillDrafts); setTools(toolList.tools); setFailed(false);
      report.current(review.skillDrafts.length);
    } catch {
      if (loads.current.isCurrent(ticket)) setFailed(true);
    }
  }, []);
  useEffect(() => { const timer = setTimeout(() => void load(), 150); return () => clearTimeout(timer); }, [load, revision, tick]);
  const hasBrowser = tools?.some(tool => tool.name.startsWith('browser_')) === true;
  useEffect(() => {
    if (!hasBrowser) return undefined;
    let live = true;
    api.browserStatus().then(status => { if (live) setBrowserOff(!status.enabled); }).catch(() => undefined);
    return () => { live = false; };
  }, [hasBrowser]);

  const reload = () => setTick(n => n + 1);
  const pending = useMemo(() => (drafts ?? []).filter(d => d.status === 'pending').sort((a, b) => b.created_at - a.created_at), [drafts]);
  const openDraft = target?.kind === 'draft' ? findDraft(pending, target.name) : undefined;
  const openSkill = target?.kind === 'skill' ? target.name : null;
  const sorted = useMemo(() => [...(skills ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [skills]);

  return (
    <div className="bt-screen__inner">
      <header className="bt-screen__head bt-rise">
        <h1 className="bt-screen__title">{t('ui.nav.skills')}</h1>
        <div className="bt-screen__tools"><Button onClick={() => setCreating(true)}>{t('ui.skills.new')}</Button></div>
      </header>
      {failed && <Notice tone="warn" icon="alert" title={t('ui.kanban.loadFailed')} action={{ label: t('ui.fail.retry'), run: () => void load() }} />}
      <div className="bt-pane__stack ui-lib__stack">
        {creating && <NewSkill existing={sorted.map(s => s.name)} onClose={() => setCreating(false)} onSaved={name => { setCreating(false); reload(); location.hash = skillHash(name); }} />}
        {pending.length > 0 && (
          <section className="bt-section bt-rise" style={{ '--bt-i': 1 } as CSSProperties} aria-label={t('ui.skills.drafts')}>
            <div className="bt-section__head">
              <span className="bt-section__kind"><span className="bt-dot" aria-hidden="true" /><span className="bt-label">{t('ui.skills.drafts')}</span></span>
              <CountBadge n={pending.length} />
            </div>
            <ul className="bt-list">
              {pending.map(draft => <DraftRow key={draft.id} draft={draft} open={openDraft?.id === draft.id} now={now} onDone={reload} />)}
            </ul>
          </section>
        )}
        {skills && (
          <section className="bt-section bt-rise" style={{ '--bt-i': 2 } as CSSProperties} aria-label={t('ui.skills.registered')}>
            <div className="bt-section__head"><span className="bt-label">{t('ui.skills.registered')}</span><span className="bt-meta">{sorted.length}</span></div>
            {sorted.length === 0 ? <EmptyState title={t('ui.skills.empty')} /> : (
              <ul className="bt-list">
                {sorted.map(skill => {
                  const open = openSkill === skill.name;
                  const toggle = () => { location.hash = skillHash(open ? null : skill.name); };
                  return (
                    <Fragment key={skill.name}>
                      <li className={`bt-row bt-row--link${open ? ' is-active' : ''}`} onClick={toggle}>
                        <Icon name="file" />
                        <div className="bt-row__main">
                          <button type="button" className="bt-row__title ui-rowbtn" aria-expanded={open}><code>{skill.name}</code></button>
                          <span className="bt-row__sub bt-meta">
                            {skill.description} · {skill.uses > 0 ? t('ui.skills.used', skill.uses) : t('ui.skills.unused')}
                            {!skill.registered && <> · {t('ui.skills.unregisteredNote')}</>}
                          </span>
                        </div>
                        {!skill.registered && <div className="bt-row__end"><span className="bt-tag">{t('ui.skills.unregistered')}</span></div>}
                        <Icon name={open ? 'chevD' : 'chevR'} />
                      </li>
                      {open && <li className="bt-row ui-lib__open"><SkillDetail name={skill.name} revision={`${revision}:${tick}`} now={now} onChanged={reload} /></li>}
                    </Fragment>
                  );
                })}
              </ul>
            )}
          </section>
        )}
        {tools && <ToolRows tools={tools} running={running} browserOff={browserOff} onFailed={reload}
          onSaved={saved => setTools(current => current?.map(tool => (tool.name === saved.name ? saved : tool)) ?? current)} />}
      </div>
    </div>
  );
}
