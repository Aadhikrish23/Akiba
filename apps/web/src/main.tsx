import './zodConfig';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// Self-hosted webfonts (doc 08 §2): no request leaves for a font CDN.
import '@fontsource-variable/big-shoulders-display/wght';
import '@fontsource/zen-kaku-gothic-new/400.css';
import '@fontsource/zen-kaku-gothic-new/500.css';
import '@fontsource/zen-kaku-gothic-new/700.css';
import '@fontsource/yomogi/400.css';
import './index.css';
import { createBrowserClient } from './lib/api';
import { applyTheme, readTheme } from './lib/theme';

// Before the first paint, so a saved dark choice does not flash light.
applyTheme(readTheme());

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App client={createBrowserClient()} />
  </StrictMode>,
);
