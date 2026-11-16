import { createDb } from './index.js';
import { seedDatabase } from './seed.js';

// Entry point for `pnpm db:seed` / `prisma db seed`. Reads DATABASE_URL and NODE_ENV directly:
// it is a maintenance command, not part of the server, and needs none of the server's config.
// Never prints the connection URL.
const databaseUrl = process.env['DATABASE_URL'];
if (databaseUrl === undefined || databaseUrl === '') {
  console.error('seed: DATABASE_URL is not set');
  process.exit(1);
}

const includeDevCatalog = process.env['NODE_ENV'] !== 'production';
const db = createDb({ databaseUrl, maxConnections: 1 });
try {
  const summary = await seedDatabase(db.client, { includeDevCatalog });
  console.log(
    includeDevCatalog
      ? `seed: ensured ${summary.genres} genres, ${summary.titles} development titles and ${summary.relations} relations`
      : `seed: ensured ${summary.genres} genres (development catalog skipped: NODE_ENV=production)`,
  );
} catch (error) {
  console.error('seed: failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await db.close();
}
