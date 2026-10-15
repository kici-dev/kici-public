import pg from 'pg';
import { Kysely } from 'kysely';
import { createPool, createDb } from '../../../db/client.js';

/** Runs `fn` on a connection to `databaseUrl` (default KICI_DATABASE_URL), then cleans up. */
export async function withDb<T>(
  fn: (db: Kysely<any>, pool: pg.Pool) => Promise<T>,
  databaseUrl: string | undefined = process.env.KICI_DATABASE_URL,
): Promise<T> {
  if (!databaseUrl) {
    throw new Error('Database URL not configured. Set KICI_DATABASE_URL environment variable.');
  }

  const pool = createPool(databaseUrl);
  const db = createDb(pool);

  try {
    return await fn(db, pool);
  } finally {
    await db.destroy();
  }
}
