import { useT } from '../../i18n/index.ts';
import { QuestionsList, type QuestionsListProps } from '../panes/QuestionsPane.tsx';

export function QuestionsScreen(props: Omit<QuestionsListProps, 'projectId'>) {
  const t = useT();
  return (
    <div className="bt-screen__inner ui-q-screen">
      <header className="bt-screen__head bt-rise">
        <div>
          <span className="bt-meta">{t('ui.q.everyProduct')}</span>
          <h1 className="bt-screen__title">{t('ui.nav.questions')}</h1>
        </div>
      </header>
      <QuestionsList projectId={null} {...props} />
    </div>
  );
}
