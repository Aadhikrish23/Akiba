import { readFile } from 'node:fs/promises';
import { createDb } from '../db/index.js';
import { importDataset, parseDataset } from './dataset.js';
import { MergeError, mergeTitles } from './merge.js';

// Entry point for `pnpm mapping:import <dataset.json>` and `pnpm mapping:merge <keepId> <mergedId>`.
// Maintenance commands, not part of the server: they read DATABASE_URL directly and never print it.
const USAGE = `usage:
  pnpm mapping:import <dataset.json>          import the community ID-mapping dataset
  pnpm mapping:merge <keepId> <mergedId>      merge a duplicate title into the one to keep`;

const [command, first, second] = process.argv.slice(2);
const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  console.error('mapping: DATABASE_URL is not set');
  process.exit(1);
}

const db = createDb({ databaseUrl, maxConnections: 2 });
try {
  if (command === 'import' && first !== undefined) {
    const parsed = parseDataset(JSON.parse(await readFile(first, 'utf8')) as unknown);
    const summary = await importDataset(db.client, parsed.rows);
    console.log(
      `mapping: ${parsed.rows.length} rows read (${parsed.skipped} skipped): ` +
        `${summary.added} added, ${summary.enriched} enriched, ${summary.unchanged} unchanged, ` +
        `${summary.linked} IDs linked to existing titles, ${summary.conflicts} conflicts queued`,
    );
  } else if (command === 'merge' && first !== undefined && second !== undefined) {
    const summary = await mergeTitles(db.client, first, second);
    console.log(
      `mapping: merged ${summary.mergedId} into ${summary.keepId}: ${summary.entriesMoved} entries moved, ` +
        `${summary.entriesCombined} combined, ${summary.eventsRepointed} events repointed, ` +
        `${summary.externalIdsMoved} IDs moved, ${summary.externalIdsOverridden} IDs pinned by override`,
    );
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
} catch (error) {
  console.error('mapping: failed:', error instanceof MergeError ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
