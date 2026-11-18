import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout; components that call scrollIntoView or similar need these stubs later.
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});
