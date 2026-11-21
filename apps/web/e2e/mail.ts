import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';

const LOG = new URL('./.tmp/api.log', import.meta.url);

/**
 * The link of the latest email of `kind` to `address`, read from what the API printed. Polls: the
 * API sends mail after it has answered the request.
 */
export async function emailedLink(address: string, kind: 'verify' | 'reset'): Promise<string> {
  const path = kind === 'verify' ? 'verify-email' : 'reset-password';
  const pattern = new RegExp(`https?://[^\\s"<]*/${path}#token=[^\\s"<]+`);
  const find = (): string => {
    let text: string;
    try {
      text = readFileSync(LOG, 'utf8');
    } catch {
      return '';
    }
    const blocks = text.split('----- email').filter((block) => block.includes(`To: ${address}`));
    for (const block of blocks.reverse()) {
      const match = pattern.exec(block);
      if (match !== null) return match[0];
    }
    return '';
  };
  await expect
    .poll(find, { message: `no ${kind} email for ${address} in the API log`, timeout: 10_000 })
    .not.toBe('');
  return find();
}
