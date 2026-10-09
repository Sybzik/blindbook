import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import './design/index.css';
import { App } from './App';
import './ui-kit.css';
import './ui/desk.css';

// The installed app loads from its own cache after the first visit (production builds only).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => void navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined));
}

/** Last line of defence: if the app itself fails to render, say so and offer a reload instead of
 *  a blank page. Windows have their own guard (ui/win.tsx), so this is rare. */
class AppGuard extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main style={{ padding: 32, maxWidth: 560 }}>
        <p className="bb-display-md bb-alarm">BLINDBOOK STOPPED</p>
        <p className="bb-text" style={{ marginTop: 12 }}>
          The app hit an error it couldn't show. Your slips are in your vault on this device and are untouched. Reload to start again.
        </p>
        <button type="button" className="bb-link" style={{ marginTop: 20 }} onClick={() => location.reload()}>
          RELOAD
        </button>
      </main>
    );
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <AppGuard>
      <App />
    </AppGuard>
  </StrictMode>,
);
