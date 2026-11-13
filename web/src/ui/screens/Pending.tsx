import { useT } from '../../i18n/index.ts';
import { PendingList, type PendingListProps } from '../panes/PendingPane.tsx';

export function PendingScreen(props: Omit<PendingListProps, 'projectId'>) {
  const t = useT();
  return (
    <div className="bt-screen__inner ui-pending-screen">
      <header className="bt-screen__head bt-rise">
        <div>
          <span className="bt-meta">{t('ui.pending.everyProduct')}</span>
          <h1 className="bt-screen__title">{t('ui.nav.pending')}</h1>
        </div>
      </header>
      <PendingList projectId={null} {...props} />
    </div>
  );
}
