import pg from 'pg';
import { Kysely } from 'kysely';
import { createPool as _createPool, createDb as _createDb } from '@kici-dev/shared';
import type { Database } from './types.js';

/**
 * Create PostgreSQL connection pool.
 */
export const createPool = _createPool;

/**
 * Create Kysely database instance typed to the orchestrator schema.
 */
export function createDb(pool: pg.Pool): Kysely<Database> {
  return _createDb<Database>(pool);
}
