import type { CSSProperties } from 'react';
import type { ChecklistItem } from '../api.ts';
import { useT } from '../i18n/index.ts';
import { checklistShape } from './thread.ts';

const CHECK = <svg viewBox="0 0 10 10" aria-hidden="true"><path pathLength="1" d="M2 5.2l2 2 4-4.4" /></svg>;

export function Checklist({ items, tainted, live, className }: { items: ChecklistItem[]; tainted: boolean; live: boolean; className?: string }) {
  const t = useT();
  const shape = checklistShape(items);
  const percent = shape.total ? Math.round((shape.done / shape.total) * 100) : 0;
  return (
    <section className={`bt-checklist${live ? '' : ' ui-checklist--still'}${className ? ` ${className}` : ''}`} aria-label={t('ui.checklist')}>
      <div className="bt-checklist__head"><span className="bt-label">{t('ui.checklist')}</span><span className="bt-meta">{t('ui.checklist.count', shape.done, shape.total)}</span></div>
      <div className="bt-progress" role="progressbar" aria-valuemin={0} aria-valuemax={shape.total} aria-valuenow={shape.done}>
        <span className="bt-progress__fill" style={{ '--bt-progress': `${percent}%` } as CSSProperties} />
      </div>
      <ul className="bt-checklist__list">
        {shape.doneHidden > 0 && <li className="bt-check bt-check--done"><span className="bt-check__box">{CHECK}</span><span>{t('ui.checklist.done', shape.doneHidden)}</span></li>}
        {shape.rows.map((item, i) => (
          <li key={i} className={`bt-check${item.status === 'done' ? ' bt-check--done' : item.status === 'in_progress' ? ' bt-check--doing' : ''}`}>
            <span className="bt-check__box">{item.status === 'done' ? CHECK : null}</span><span>{item.text}</span>
          </li>
        ))}
      </ul>
      {tainted && <p className="bt-meta ui-checklist__note">{t('ui.checklist.tainted')}</p>}
    </section>
  );
}
