import { defineConfig } from 'prisma/config';

// Prisma CLI configuration (schema location, migrations, seed command, connection URL).
//
// DATABASE_URL is read from the process environment only; this file loads no `.env` file. It is
// optional here so that `prisma generate` (which never connects) works without a database; the
// commands that do connect (`migrate deploy`, `migrate status`, ...) fail with Prisma's own
// "datasource URL is missing" error when it is unset.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // Needs a build first; `pnpm db:seed` does both.
    seed: 'node apps/api/dist/db/seedCli.js',
  },
  ...(databaseUrl === undefined || databaseUrl === '' ? {} : { datasource: { url: databaseUrl } }),
});
