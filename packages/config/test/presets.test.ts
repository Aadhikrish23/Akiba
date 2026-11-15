import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { createConfig } from '../eslint/index.js';
import prettierConfig from '../prettier/index.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function readTsconfig(name: string): {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
} {
  const url = new URL(`../tsconfig/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as ReturnType<typeof readTsconfig>;
}

async function lint(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    overrideConfig: createConfig({ tsconfigRootDir: repoRoot }),
  });
  const results = await eslint.lintText(code, { filePath });
  return results.flatMap((result) => result.messages.map((message) => message.ruleId ?? 'fatal'));
}

describe('tsconfig presets (NFR-MNT-001)', () => {
  it('NFR-MNT-001 base preset enables strict mode', () => {
    expect(readTsconfig('base').compilerOptions?.strict).toBe(true);
  });

  it.each(['node', 'library', 'react'])('NFR-MNT-001 %s preset extends base', (name) => {
    const preset = readTsconfig(name);
    expect(preset.extends).toBe('./base.json');
    expect(preset.compilerOptions).not.toHaveProperty('strict');
  });
});

describe('eslint preset (NFR-MNT-001)', () => {
  it('NFR-MNT-001 rejects explicit any in a shared package', async () => {
    const ruleIds = await lint('export const value: any = 1;\n', 'packages/shared/src/index.ts');
    expect(ruleIds).toContain('@typescript-eslint/no-explicit-any');
  });

  it('NFR-MNT-001 rejects any leaking in from untyped values in a shared package', async () => {
    const ruleIds = await lint(
      "export const value: string = JSON.parse('1');\n",
      'packages/shared/src/index.ts',
    );
    expect(ruleIds).toContain('@typescript-eslint/no-unsafe-assignment');
  });

  it('accepts the same module once it is properly typed', async () => {
    const ruleIds = await lint('export const value: number = 1;\n', 'packages/shared/src/index.ts');
    expect(ruleIds).toEqual([]);
  });

  it('rejects an app importing from another app (architecture §2)', async () => {
    const ruleIds = await lint(
      "import { createApp } from '@akiba/api';\nexport const app = createApp;\n",
      'apps/web/src/main.tsx',
    );
    expect(ruleIds).toContain('no-restricted-imports');
  });
});

describe('prettier preset', () => {
  it('exposes the agreed formatting options', () => {
    expect(prettierConfig).toMatchObject({ singleQuote: true, semi: true, printWidth: 100 });
  });
});
