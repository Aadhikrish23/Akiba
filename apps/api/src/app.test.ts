import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

let server: Server | undefined;

async function listen(): Promise<string> {
  const app = createApp();
  const started = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => {
      resolve(instance);
    });
  });
  server = started;
  const { port } = started.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current) {
    await new Promise<void>((resolve, reject) => {
      current.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

describe('createApp', () => {
  it('carries the shared app name', () => {
    expect(createApp().locals.name).toBe('Akiba');
  });

  it('serves no routes yet and does not advertise Express', async () => {
    const origin = await listen();
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(404);
    expect(response.headers.has('x-powered-by')).toBe(false);
  });
});
