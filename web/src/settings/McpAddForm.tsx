import { useState } from 'react';
import { api } from '../api.ts';
import { useT } from '../i18n/index.ts';
import { accessWidening } from './access.ts';
import { SegField } from './fields.tsx';
import type { McpCtx } from './mcp-ctx.ts';
import { addBody, addProblem, addSpec, emptyAddForm, idFromName, previewAdd, scrubSecrets, type AddForm, type AddProblem } from './mcp-model.ts';

// サーバーを足すフォーム。引数は 1 行に 1 つ（シェルとしては読まない）。秘密の値は、送ったら（やめたときも）この画面の状態から消す
export function McpAddForm({ ctx, taken, onClose }: { ctx: McpCtx; taken: readonly string[]; onClose: () => void }) {
  const t = useT();
  const [form, setForm] = useState<AddForm>(emptyAddForm);
  const [shown, setShown] = useState(false);
  const problem: AddProblem | null = addProblem(form, taken);
  const set = (patch: Partial<AddForm>) => setForm(old => ({ ...old, ...patch }));
  const rows = form.rows;
  const setRow = (i: number, patch: Partial<{ name: string; value: string }>) => set({ rows: rows.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const full = taken.length >= ctx.limits.maxServers;

  const submit = () => {
    setShown(true);
    if (problem !== null || ctx.off || full) return;
    ctx.guarded(accessWidening(ctx.saved, previewAdd(ctx.saved, addSpec(form))), () =>
      void ctx.run('', () => api.addMcpServer(addBody(form)), t('settings.mcp.added')).then(ok => { if (ok) { setForm(scrubSecrets(form)); onClose(); } }));
  };
  const cancel = () => { setForm(scrubSecrets(form)); onClose(); };
  const secretKind = form.transport === 'stdio' ? 'env' : 'header';

  return (
    <section className="set-mcp-card" aria-label={t('settings.mcp.add')}>
      <label className="set-notify-field">
        <span>{t('settings.mcp.nameLabel')}</span>
        <input className="input set-text" value={form.name} spellCheck={false} disabled={ctx.busy} onChange={e => set({ name: e.target.value, ...(form.idTouched ? {} : { id: idFromName(e.target.value) }) })} />
      </label>
      <label className="set-notify-field">
        <span>{t('settings.mcp.idLabel')}</span>
        <input className="input set-text mono" value={form.id} spellCheck={false} disabled={ctx.busy} onChange={e => set({ id: e.target.value, idTouched: true })} />
      </label>
      <span className="set-row-desc">{t('settings.mcp.idNote')}</span>
      <SegField<'stdio' | 'http'> value={form.transport} label={t('settings.mcp.transport')} onChange={transport => set({ transport, rows: [] })} options={[{ value: 'stdio', label: t('settings.mcp.transport.stdio') }, { value: 'http', label: t('settings.mcp.transport.http') }]} />

      {form.transport === 'stdio' ? (
        <>
          <label className="set-notify-field">
            <span>{t('settings.mcp.program')}</span>
            <input className="input set-text mono" value={form.program} placeholder="npx" spellCheck={false} disabled={ctx.busy} onChange={e => set({ program: e.target.value })} />
          </label>
          <label className="set-notify-field">
            <span>{t('settings.mcp.args')}</span>
            <textarea className="input set-mcp-args" value={form.args} placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\work'} spellCheck={false} disabled={ctx.busy} onChange={e => set({ args: e.target.value })} />
          </label>
          <span className="set-row-desc">{t('settings.mcp.argsNote')}</span>
          <label className="set-notify-field">
            <span>{t('settings.mcp.cwd')}</span>
            <input className="input set-text mono" value={form.cwd} spellCheck={false} disabled={ctx.busy} onChange={e => set({ cwd: e.target.value })} />
          </label>
        </>
      ) : (
        <label className="set-notify-field">
          <span>{t('settings.mcp.url')}</span>
          <input className="input set-text mono" value={form.url} placeholder="https://mcp.example.com/mcp" spellCheck={false} disabled={ctx.busy} onChange={e => set({ url: e.target.value })} />
        </label>
      )}

      <strong>{secretKind === 'env' ? t('settings.mcp.envTitle') : t('settings.mcp.headersTitle')}</strong>
      <span className="set-row-desc">{t('settings.mcp.secretNote')}</span>
      {rows.map((row, i) => (
        <div key={i} className="set-mcp-secret-row">
          <input className="input set-text mono" value={row.name} placeholder={secretKind === 'env' ? 'API_TOKEN' : 'Authorization'} aria-label={t('settings.mcp.secretName')} spellCheck={false} disabled={ctx.busy} onChange={e => setRow(i, { name: e.target.value })} />
          <input type="password" className="input set-text mono" value={row.value} placeholder={t('settings.mcp.secretPlaceholder')} aria-label={t('settings.mcp.secretValue')} autoComplete="new-password" spellCheck={false} disabled={ctx.busy} onChange={e => setRow(i, { value: e.target.value })} />
          <button type="button" className="btn btn-ghost" disabled={ctx.busy} onClick={() => set({ rows: rows.filter((_, j) => j !== i) })}>{t('settings.mcp.rowRemove')}</button>
        </div>
      ))}
      <div className="set-keyrow set-notify-actions">
        <button type="button" className="btn btn-ghost" disabled={ctx.busy || rows.length >= 16} onClick={() => set({ rows: [...rows, { name: '', value: '' }] })}>{t('settings.mcp.rowAdd')}</button>
      </div>

      {shown && problem !== null && <span className="set-row-error" role="alert">{t(`settings.mcp.problem.${problem}`)}</span>}
      {full && <span className="set-row-error" role="alert">{t('settings.mcp.full', ctx.limits.maxServers)}</span>}
      <span className="set-row-desc">{t('settings.mcp.addNote')}</span>
      <div className="set-keyrow set-notify-actions">
        <button type="button" className="btn btn-primary" disabled={ctx.off || full} onClick={submit}>{ctx.busy ? t('settings.key.saving') : t('settings.mcp.addSubmit')}</button>
        <button type="button" className="btn btn-ghost" disabled={ctx.busy} onClick={cancel}>{t('settings.key.cancel')}</button>
      </div>
    </section>
  );
}
