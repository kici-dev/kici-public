import { defineConfig } from 'kysely-ctl';
import { PostgresDialect } from 'kysely';
import pg from 'pg';

export default defineConfig({
  dialect: new PostgresDialect({
    pool: new pg.Pool({
      connectionString: process.env.KICI_DATABASE_URL || '',
    }),
  }),
  migrations: {
    migrationFolder: 'src/db/migrations',
  },
});
