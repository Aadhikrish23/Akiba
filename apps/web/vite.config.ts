import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// In development the API runs on :3000; the browser talks to the web origin only, so cookies and
// the CSRF Origin check behave exactly as they will behind one host in production.
const API_TARGET = process.env['API_PROXY_TARGET'] ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/v1': API_TARGET },
  },
  preview: {
    port: 4173,
    proxy: { '/v1': API_TARGET },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
