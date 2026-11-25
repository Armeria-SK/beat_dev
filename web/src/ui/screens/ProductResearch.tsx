import { useEffect, useState } from 'react';
import { api } from '../../api.ts';
import { useT } from '../../i18n/index.ts';

export function ResearchUsing({ id, revision }: { id: string; revision: number }) {
  const t = useT();
  const [using, setUsing] = useState<Array<{ id: number; name: string; url: string | null; memo: string | null }>>([]);
  useEffect(() => {
    let live = true;
    void api.research(id).then(view => {
      if (!live) return;
      const record = view.products;
      setUsing(record?.status === 'confirmed' ? record.items.filter(item => item.kind === 'similar' && item.decision === 'use').map(item => ({ id: item.id, name: item.name, url: item.url, memo: item.reason })) : []);
    }, () => { if (live) setUsing([]); });
    return () => { live = false; };
  }, [id, revision]);
  if (using.length === 0) return null;
  return (
    <section className="bt-section" aria-label={t('ui.home.rs.using')} data-home="using">
      <div className="bt-section__head"><span className="bt-label">{t('ui.home.rs.using')}</span></div>
      <ul className="bt-list">
        {using.map(item => (
          <li key={item.id} className="bt-row">
            <div className="bt-row__main">
              <span className="bt-row__title">{item.name}</span>
              {item.url && <a className="bt-meta ui-rs__url" href={item.url} target="_blank" rel="noopener noreferrer nofollow">{item.url}</a>}
              {item.memo && <span className="bt-row__sub bt-meta">{item.memo}</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
