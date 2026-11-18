import './zodConfig';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
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
