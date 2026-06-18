/**
 * Shared database helper for CLI commands that need direct DB access.
 *
 * Provides a withDb() wrapper that creates a database connection from
 * KICI_DATABASE_URL, runs a callback, and ensures cleanup.
 */

import pg from 'pg';
import { Kysely } from 'kysely';
import { createPool, createDb } from '../../../db/client.js';

/**
 * Execute a callback with a database connection, then clean up.
 *
 * Reads the database URL from KICI_DATABASE_URL.
 * Creates a connection pool, runs the callback, and destroys the pool.
 */
export async function withDb<T>(fn: (db: Kysely<any>, pool: pg.Pool) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.KICI_DATABASE_URL;
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
