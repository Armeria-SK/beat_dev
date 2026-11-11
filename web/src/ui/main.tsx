import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useT } from '../i18n/index.ts';
import { Avatar } from './parts.tsx';
import { applyTheme, browserStorage, readReducedMotion, readTheme } from './theme.ts';
import './styles/tokens.css';
import './styles/bundle.css';
import './styles/markdown.css';

function Shell() {
  const t = useT();
  return (
    <div className="bt-app" style={{ height: '100dvh', gridTemplateColumns: '248px minmax(0, 1fr)' }}>
      <nav className="bt-sidebar is-idle" aria-label={t('ui.sidebar')}>
        <div className="bt-sidebar__head">
          <a className="bt-wordmark" href="#/">{t('ui.wordmark')}</a>
          <Avatar state="idle" size="sm" />
        </div>
      </nav>
      <main className="bt-app__main" />
    </div>
  );
}

const storage = browserStorage();
applyTheme(document.documentElement, readTheme(storage));
document.body.classList.add('bt-root');
document.body.classList.toggle('is-reduced', readReducedMotion(storage));
createRoot(document.getElementById('root')!).render(<StrictMode><Shell /></StrictMode>);
