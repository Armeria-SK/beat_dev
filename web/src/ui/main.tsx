import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyTheme, browserStorage, followExplainLanguage, readReducedMotion, readTheme } from './theme.ts';
import './styles/tokens.css';
import './styles/bundle.css';
import './styles/markdown.css';
import './styles/frame.css';
import './styles/library.css';
import './styles/settings.css';
import './styles/product-nav.css';

const storage = browserStorage();
applyTheme(document.documentElement, readTheme(storage));
document.body.classList.add('bt-root');
document.body.classList.toggle('is-reduced', readReducedMotion(storage));
followExplainLanguage(document.documentElement);
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
