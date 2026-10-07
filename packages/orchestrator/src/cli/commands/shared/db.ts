/**
 * Shared database helper for CLI commands that need direct DB access.
 *
 * Provides a withDb() wrapper that creates a database connection from the
 * URL it is given (or KICI_DATABASE_URL when none is passed), runs a callback,
 * and ensures cleanup.
 */

import pg from 'pg';
import { Kysely } from 'kysely';
import { createPool, createDb } from '../../../db/client.js';

/**
 * Execute a callback with a database connection, then clean up.
 *
 * Connects to `databaseUrl`, or to KICI_DATABASE_URL when none is passed.
 */
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
