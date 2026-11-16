import { createServer, type Server } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createTcpDbCheck, dbNotConfigured } from './dbCheck.js';

let listener: Server | undefined;

async function listen(): Promise<number> {
  const server = createServer((socket) => {
    socket.end();
  });
  listener = server;
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(): Promise<void> {
  const server = listener;
  listener = undefined;
  if (server?.listening) {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

afterEach(close);

describe('database readiness probes', () => {
  it('dbNotConfigured reports not_configured', async () => {
    await expect(dbNotConfigured()).resolves.toBe('not_configured');
  });

  it('TCP probe resolves ok when the host accepts connections', async () => {
    const port = await listen();
    const check = createTcpDbCheck(`postgresql://user:pw@127.0.0.1:${port}/akiba`);
    await expect(check()).resolves.toBe('ok');
  });

  it('TCP probe rejects when nothing listens, without leaking the URL', async () => {
    const port = await listen();
    await close();
    const check = createTcpDbCheck(`postgresql://user:probe-secret@127.0.0.1:${port}/akiba`);
    const error = await check().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^database unreachable/);
    expect((error as Error).message).not.toContain('probe-secret');
  });
});
