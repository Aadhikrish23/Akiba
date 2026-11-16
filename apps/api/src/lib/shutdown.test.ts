import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { LogSink } from '../testing/harness.js';
import { createLogger } from './logger.js';
import { createShutdown } from './shutdown.js';

async function start(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: (server.address() as AddressInfo).port };
}

const logger = () => createLogger({ level: 'info', destination: new LogSink() });

describe('graceful shutdown', () => {
  it('stops listening, runs cleanup once and exits 0, even if signalled twice', async () => {
    const { server } = await start((_req, res) => res.end('ok'));
    const onClose = vi.fn(() => Promise.resolve());
    const shutdown = createShutdown({ server, logger: logger(), timeoutMs: 1_000, onClose });

    const [first, second] = await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(server.listening).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('lets an in-flight request finish before exiting', async () => {
    let arrived = false;
    let release: () => void = () => undefined;
    const { server, port } = await start((_req, res) => {
      arrived = true;
      release = () => res.end('done');
    });
    const shutdown = createShutdown({ server, logger: logger(), timeoutMs: 5_000 });

    const body = new Promise<string>((resolve, reject) => {
      request({ host: '127.0.0.1', port, agent: false }, (res) => {
        let text = '';
        res.on('data', (chunk: Buffer) => (text += chunk.toString()));
        res.on('end', () => {
          resolve(text);
        });
      })
        .on('error', reject)
        .end();
    });
    await vi.waitFor(() => {
      expect(arrived).toBe(true);
    });

    const exit = shutdown('SIGTERM');
    release();

    await expect(body).resolves.toBe('done');
    await expect(exit).resolves.toBe(0);
  });

  it('force-closes connections that outlive the timeout and exits 1', async () => {
    let seen = false;
    const { server, port } = await start(() => {
      seen = true; // never responds
    });
    const shutdown = createShutdown({ server, logger: logger(), timeoutMs: 50 });

    const client = request({ host: '127.0.0.1', port, agent: false });
    const clientClosed = new Promise<void>((resolve) => {
      client.on('error', () => {
        resolve();
      });
    });
    client.end();
    await vi.waitFor(() => {
      expect(seen).toBe(true);
    });

    await expect(shutdown('SIGTERM')).resolves.toBe(1);
    await clientClosed;
    expect(server.listening).toBe(false);
  });
});
