import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/index.css';
import { App } from './App';
import './ui-kit.css';
import './ui/desk.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
