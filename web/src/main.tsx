import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/index.css';
import { App } from './App';
import './ui-kit.css';
import './ui/desk.css';

// The installed app loads from its own cache after the first visit (production builds only).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined));
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
