import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (where prisma.config.ts, prisma/ and the Prisma CLI live). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

export interface PrismaCliResult {
  readonly code: number | null;
  /** stdout and stderr interleaved. */
  readonly output: string;
}

function prismaEntryPoint(): string {
  const require = createRequire(resolve(REPO_ROOT, 'package.json'));
  const manifestPath = require.resolve('prisma/package.json');
  const manifest = require(manifestPath) as { bin: Record<string, string> };
  const bin = manifest.bin['prisma'];
  if (bin === undefined) throw new Error('prisma package has no "prisma" bin entry');
  return resolve(dirname(manifestPath), bin);
}

/**
 * Run the real Prisma CLI from the repository root against `databaseUrl`, exactly as CI and a
 * deploy do (`prisma migrate deploy`, `migrate status`, `migrate diff`). Never throws on a
 * non-zero exit; callers assert on `code`.
 */
export function runPrisma(args: readonly string[], databaseUrl: string): Promise<PrismaCliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [prismaEntryPoint(), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolvePromise({ code, output });
    });
  });
}
