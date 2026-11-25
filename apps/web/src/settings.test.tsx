import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { USER, json, renderApp, signedInHandler } from './test/render';

/** Settings → Profile: the time zone is a list to pick from, and picking one saves it. */
describe('Settings: time zone', () => {
  it('is a dropdown of zones with their offsets, and saves the one you pick', async () => {
    const app = renderApp({
      route: '/settings',
      handler: signedInHandler({ timeZone: 'UTC' }, (call) =>
        call.method === 'PATCH' && call.path.endsWith('/me')
          ? json(200, { ...USER, ...(call.body as object) })
          : json(404, {}),
      ),
    });
    const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Time zone' });
    expect(select.value).toBe('UTC');
    const tokyo = [...select.options].find((option) => option.value === 'Asia/Tokyo');
    expect(tokyo?.textContent).toBe('Asia/Tokyo (GMT+9)');

    await app.user.selectOptions(select, 'Asia/Tokyo');
    await waitFor(() => {
      expect(app.to('/me').filter((call) => call.method === 'PATCH')).toHaveLength(1);
    });
    expect(app.to('/me').find((call) => call.method === 'PATCH')?.body).toEqual({
      timeZone: 'Asia/Tokyo',
    });
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('keeps a zone saved before the list existed selectable instead of dropping it', async () => {
    renderApp({ route: '/settings', handler: signedInHandler({ timeZone: 'Mars/Olympus' }) });
    const select = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Time zone' });
    expect(select.value).toBe('Mars/Olympus');
  });
});

/** Settings → Where I watch: the services a Watch button goes to, kept on this device. */
describe('Settings: where I watch', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('remembers the services you tick, and shows them ticked next time', async () => {
    const app = renderApp({ route: '/settings', handler: signedInHandler() });
    const netflix = await screen.findByRole<HTMLInputElement>('checkbox', { name: 'Netflix' });
    expect(netflix.checked).toBe(false);
    await app.user.click(netflix);
    await app.user.click(screen.getByRole('checkbox', { name: 'Hotstar' }));
    expect(JSON.parse(window.localStorage.getItem('akiba.services') ?? '[]')).toEqual([
      'Netflix',
      'Hotstar',
    ]);

    await app.user.click(netflix);
    expect(JSON.parse(window.localStorage.getItem('akiba.services') ?? '[]')).toEqual(['Hotstar']);
  });

  it('starts with the ones already saved', async () => {
    window.localStorage.setItem('akiba.services', JSON.stringify(['Hulu']));
    renderApp({ route: '/settings', handler: signedInHandler() });
    const hulu = await screen.findByRole<HTMLInputElement>('checkbox', { name: 'Hulu' });
    expect(hulu.checked).toBe(true);
  });
});
