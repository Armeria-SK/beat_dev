import { useEffect, useState } from 'react';
import { api, ApiError, type Project, type ProjectPatch } from '../../api.ts';
import { toast } from '../../feedback.ts';
import { useT } from '../../i18n/index.ts';
import { autoLabel, hasDocLanguage, LANGUAGES, languageName, languagePatch, languagePick, OTHER } from '../doc-language.ts';
import { Button } from '../parts.tsx';
import { RowConfirm } from '../RowConfirm.tsx';
import { routeHash } from '../routes.ts';
import { SCREEN_EDITS, setUnsaved } from '../unsaved.ts';

const EDITS = `${SCREEN_EDITS}product`;
const failText = (error: unknown): string => (error instanceof ApiError ? error.message : String(error));

export function ProductSettings({ project, onProject }: { project: Project; onProject: (project: Project) => void }) {
  const t = useT();
  const [name, setName] = useState(project.name);
  const [check, setCheck] = useState(project.check_command ?? '');
  const [lang, setLang] = useState(() => languagePick(project));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const savedCheck = project.check_command ?? '';
  const langShown = hasDocLanguage(project);
  const langChange = langShown ? languagePatch(project, lang.pick, lang.other) : null;
  const dirty = name !== project.name || check !== savedCheck || langChange !== null;

  useEffect(() => { setUnsaved(EDITS, dirty); }, [dirty]);
  useEffect(() => () => setUnsaved(EDITS, false), []);

  const patch = async (body: ProjectPatch, done?: (next: Project) => void) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.patchProject(project.id, body);
      done?.(result.project);
      onProject(result.project);
    } catch (e) { setError(t('ui.ps.failed', failText(e))); } finally { setBusy(false); }
  };

  const save = () => {
    const body: ProjectPatch = {};
    if (name.trim() !== project.name) body.name = name.trim();
    if (check.trim() !== savedCheck) body.checkCommand = check.trim() || null;
    if (langChange === 'invalid') return;
    if (langChange) body.docLanguage = langChange.docLanguage;
    if (Object.keys(body).length === 0) { setName(project.name); setCheck(savedCheck); setLang(languagePick(project)); return; }
    void patch(body, next => { setName(next.name); setCheck(next.check_command ?? ''); setLang(languagePick(next)); toast({ icon: 'check', title: t('ui.ps.saved') }); });
  };

  const archive = () => void patch({ archived: true }, next => {
    setUnsaved(EDITS, false);
    toast({ icon: 'archive', title: t('ui.ps.archivedToast', next.name) });
    location.replace(routeHash({ view: 'new' }));
  });

  return (
    <div className="bt-screen__inner ui-ps">
      <header className="bt-screen__head bt-rise">
        <h1 className="bt-screen__title">{t('ui.product.settings')}</h1>
        <div className="bt-screen__tools"><a className="bt-meta" href={routeHash({ view: 'product', id: project.id })}>{project.name}</a></div>
      </header>
      <form className="ui-np__form" onSubmit={e => { e.preventDefault(); save(); }}>
        <label className="bt-form-row">
          <span className="bt-label">{t('ui.ps.name')}</span>
          <input className="bt-field" type="text" value={name} maxLength={100} autoComplete="off" onChange={e => setName(e.target.value)} />
        </label>
        <div className="bt-form-row">
          <span className="bt-label">{t('ui.ps.folder')}</span>
          <span className="bt-meta ui-np__path">{project.root}</span>
          {project.folder_missing && <span className="bt-meta ui-danger">{t('ui.ps.folderMissing')}</span>}
        </div>
        <label className="bt-form-row">
          <span className="bt-label">{t('ui.np.check')}</span>
          <input className="bt-field bt-field--mono" type="text" value={check} spellCheck={false} autoComplete="off" onChange={e => setCheck(e.target.value)} />
          <span className="bt-meta">{t('ui.np.checkHint')}</span>
        </label>
        {langShown && (
          <div className="bt-form-row">
            <label className="bt-label" htmlFor="ui-ps-lang">{t('ui.ps.lang')}</label>
            <select id="ui-ps-lang" className="bt-field ui-ps__lang" aria-describedby="ui-ps-lang-hint" value={lang.pick} onChange={e => setLang({ pick: e.target.value, other: e.target.value === OTHER ? lang.other : '' })}>
              <option value="">{autoLabel(project)}</option>
              {LANGUAGES.map(tag => <option key={tag} value={tag}>{languageName(tag)}</option>)}
              <option value={OTHER}>{t('ui.ps.langOther')}</option>
            </select>
            {lang.pick === OTHER && (
              <input className="bt-field bt-field--mono ui-ps__lang" type="text" value={lang.other} aria-label={t('ui.ps.langTag')} placeholder="pt-BR" maxLength={12} spellCheck={false} autoComplete="off"
                aria-invalid={langChange === 'invalid' && lang.other !== ''} aria-describedby="ui-ps-lang-hint" onChange={e => setLang({ pick: OTHER, other: e.target.value })} />
            )}
            <span id="ui-ps-lang-hint" role="status" className={`bt-meta${langChange === 'invalid' && lang.other !== '' ? ' ui-danger' : ''}`}>{langChange === 'invalid' && lang.other !== '' ? t('ui.ps.langInvalid') : t('ui.ps.langHint')}</span>
          </div>
        )}
        <div className="ui-np__actions"><Button type="submit" variant="primary" disabled={!dirty || busy || !name.trim() || langChange === 'invalid'}>{t('ui.ps.save')}</Button></div>
      </form>

      <section className="bt-section">
        <div className="bt-section__head">
          <span className="bt-label">{t('ui.ps.remotes')}</span>
          <Button small variant="ghost" disabled={busy || project.folder_missing} onClick={() => void patch({ refreshRemotes: true })}>{t('ui.ps.refresh')}</Button>
        </div>
        {project.remotes.length === 0 ? <p className="bt-meta">{project.is_git ? t('ui.ps.remotesNone') : t('ui.np.note.notGit')}</p> : (
          <ul className="bt-list">
            {project.remotes.map(r => (
              <li key={r.name} className="bt-row">
                <div className="bt-row__main">
                  <span className="bt-row__title">{r.name}</span>
                  <span className="bt-row__sub bt-meta ui-np__path">{r.push_url && r.push_url !== r.url ? `${r.url} · ${r.push_url}` : r.url}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="bt-meta ui-danger" role="alert">{error}</p>}
      <section className="bt-section">
        {confirming
          ? <RowConfirm warn={t('ui.ps.archiveConfirm')} note={t('ui.ps.archiveNote')} action={t('ui.ps.archive')} busy={busy} onConfirm={archive} onKeep={() => setConfirming(false)} />
          : <div><Button variant="danger" small disabled={busy} onClick={() => setConfirming(true)}>{t('ui.ps.archive')}</Button></div>}
      </section>
    </div>
  );
}
