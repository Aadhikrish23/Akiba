import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

// In development the API runs on :3000; the browser talks to the web origin only, so cookies and
// the CSRF Origin check behave exactly as they will behind one host in production.
const API_TARGET = process.env['API_PROXY_TARGET'] ?? 'http://localhost:3000';

/**
 * Content Security Policy for the production build (doc 09 §4). A meta tag cannot carry
 * frame-ancestors or report-only mode; the host that serves the app adds those as headers at
 * deployment. Cover art comes from the sources' image hosts, hence img-src https:. Applied to
 * the build only: Vite's development server injects inline scripts for hot reload.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' https: data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

const contentSecurityPolicy: Plugin = {
  name: 'akiba-content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
      injectTo: 'head-prepend',
    },
  ],
};

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicy],
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
