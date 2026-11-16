import { describe, expect, it } from 'vitest';
import { LogSink } from '../testing/harness.js';
import { BackgroundTasks } from './backgroundTasks.js';
import { createLogger } from './logger.js';

function setup() {
  const logs = new LogSink();
  return { logs, tasks: new BackgroundTasks(createLogger({ level: 'debug', destination: logs })) };
}

describe('BackgroundTasks', () => {
  it('runs work without blocking the caller and idle() waits for it, including work started meanwhile', async () => {
    const { tasks } = setup();
    const done: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    tasks.run('first', async () => {
      await gate;
      done.push('first');
      tasks.run('second', async () => {
        await Promise.resolve();
        done.push('second');
      });
    });
    expect(done).toEqual([]);
    expect(tasks.pending).toBe(1);

    release();
    expect(await tasks.idle()).toBe(true);
    expect(done).toEqual(['first', 'second']);
    expect(tasks.pending).toBe(0);
    await tasks.idle();
  });

  it('S-AUTH-10: a failing task is logged by name only; its error text never reaches the log', async () => {
    const { logs, tasks } = setup();
    tasks.run('email:reset_password', () =>
      Promise.reject(new Error('550 rejected: https://app/reset-password#token=SECRET')),
    );
    tasks.run('sync-throw', () => {
      throw new TypeError('boom SECRET');
    });
    await tasks.idle();

    expect(logs.lines).toHaveLength(2);
    const byTask = (task: string) => logs.lines.find((line) => line['task'] === task);
    expect(byTask('email:reset_password')).toMatchObject({
      level: 50,
      event: 'background_task_failed',
      errorName: 'Error',
    });
    expect(byTask('sync-throw')).toMatchObject({ level: 50, errorName: 'TypeError' });
    expect(logs.text).not.toContain('SECRET');
  });

  it('idle(timeout) gives up on work that never finishes and reports it', async () => {
    const { tasks } = setup();
    expect(await tasks.idle(10)).toBe(true);
    tasks.run('hangs', () => new Promise<void>(() => undefined));
    const started = Date.now();
    expect(await tasks.idle(30)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(tasks.pending).toBe(1);
  });
});
