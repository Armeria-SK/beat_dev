import { redoChanges, useRedo } from '../changes-undo.ts';
import { useT } from '../i18n/index.ts';
import { refusalText } from './changes.ts';

export function RedoAction({ projectId, batch }: { projectId: string; batch: string }) {
  const t = useT();
  const redo = useRedo(batch);
  if (redo.state === 'done') {
    return <span className="ui-redo"> · {t('ui.notice.redone')}{redo.refused.length > 0 && ` · ${t('ui.notice.redoRefused', redo.refused.length)}`}</span>;
  }
  return (
    <>
      {redo.state === 'refused' && <span className="ui-redo" role="status"> · {t('ui.notice.redoRefused', redo.refused.length)}: {refusalText(t, redo.refused)}</span>}
      {redo.state === 'failed' && <span className="ui-redo" role="status"> · {t('ui.notice.redoFailed')}: {redo.message}</span>}
      {' '}<button type="button" className="bt-notice__action" disabled={redo.state === 'working'} onClick={() => void redoChanges(projectId, batch)}>{t('ui.notice.redo')}</button>
    </>
  );
}
