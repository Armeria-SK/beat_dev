import { useState } from 'react';
import { api, ApiError, type Project, type ScoutMode } from '../api.ts';
import { toast } from '../feedback.ts';
import { useT } from '../i18n/index.ts';
import { useNoProvider } from '../provider-state.ts';
import { routeHash } from './routes.ts';
import { modeNeedsCheck, SCOUT_MODES } from './scout.ts';
import { reportOpError } from './task-ops.ts';

const MODE_KEY = { off: 'ui.scout.mode.off', research: 'ui.scout.mode.research', fix: 'ui.scout.mode.fix' } as const satisfies Record<ScoutMode, string>;

export function ScoutModeSwitch({ project, onProject }: { project: Project; onProject?: ((project: Project) => void) | undefined }) {
  const t = useT();
  const noProvider = useNoProvider();
  const [busy, setBusy] = useState(false);
  const pick = async (mode: ScoutMode) => {
    if (busy || mode === project.scout_mode) return;
    setBusy(true);
    try { onProject?.((await api.patchProject(project.id, { scoutMode: mode })).project); } catch (error) {
      if (error instanceof ApiError && error.body?.code === 'project.scout_fix_needs_check') {
        toast({ icon: 'alert', title: t('ui.scout.mode.needsCheck'), body: t('ui.scout.mode.needsCheckHint'), href: routeHash({ view: 'productSettings', id: project.id }) });
      } else reportOpError(error);
    } finally { setBusy(false); }
  };
  return (
    <>
      <div className="bt-seg ui-home__mode" role="group" aria-label={t('ui.scout.mode')}>
        {SCOUT_MODES.map(mode => {
          const noRun = noProvider && mode !== 'off';
          const blocked = modeNeedsCheck(mode, project) || noRun;
          return (
            <button key={mode} type="button" className="bt-seg__opt" data-mode={mode} aria-pressed={project.scout_mode === mode} disabled={busy || blocked}
              title={noRun ? t('ui.np.scout') : blocked ? t('ui.scout.mode.needsCheckHint') : undefined} onClick={() => void pick(mode)}>
              {t(MODE_KEY[mode])}{blocked && <span className="bt-meta ui-home__later"> · {noRun ? t('ui.np.short') : t('ui.scout.mode.needsCheck')}</span>}
            </button>
          );
        })}
      </div>
      {modeNeedsCheck('fix', project) && <span className="bt-meta ui-home__later" data-check-hint>{t('ui.scout.mode.needsCheckWhere')}</span>}
    </>
  );
}
