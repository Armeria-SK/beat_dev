import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyTheme, browserStorage, readReducedMotion, readTheme } from './theme.ts';
import './styles/tokens.css';
import './styles/bundle.css';
import './styles/markdown.css';
import './styles/frame.css';
import { variant } from './variants.ts';

if (import.meta.env.DEV) void import('./styles/variants-b.css');

const storage = browserStorage();
applyTheme(document.documentElement, readTheme(storage));
document.body.classList.add('bt-root');
document.body.classList.toggle(import.meta.env.DEV && variant('motion') === 'b' ? 'is-reduced-b' : 'is-reduced', readReducedMotion(storage));
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
