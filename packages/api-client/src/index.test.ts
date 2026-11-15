import { describe, expect, it } from 'vitest';
import { createApiClient } from './index.js';

describe('@akiba/api-client', () => {
  it('identifies itself using the shared app name', () => {
    const client = createApiClient({ baseUrl: 'https://api.example.test', platform: 'web' });
    expect(client.clientName).toBe('Akiba/web');
    expect(client.platform).toBe('web');
  });

  it.each([
    ['https://api.example.test', '/titles', 'https://api.example.test/titles'],
    ['https://api.example.test/', 'titles', 'https://api.example.test/titles'],
    ['https://api.example.test/v1/', '/titles', 'https://api.example.test/v1/titles'],
  ])('resolves %s + %s', (baseUrl, path, expected) => {
    expect(createApiClient({ baseUrl, platform: 'mobile' }).url(path)).toBe(expected);
  });

  it('rejects a base URL that is not absolute', () => {
    expect(() => createApiClient({ baseUrl: '/api', platform: 'web' })).toThrow(TypeError);
  });
});
