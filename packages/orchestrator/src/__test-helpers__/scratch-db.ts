/** Throwaway PostgreSQL databases for DB-gated tests, dropped by `cleanup`. */
import pg from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { terminateTestDbBackends } from './test-db.js';

export interface ScratchDb {
  url: string;
  pool: pg.Pool;
  db: Kysely<any>;
}

/** Creates databases on `adminUrl`; `cleanup` drops every one of them. */
export function scratchDbFactory(adminUrl: string) {
  const created: string[] = [];
  const open: ScratchDb[] = [];

  async function freshDb(tag: string): Promise<ScratchDb> {
    const name = `kici_scratch_${tag}_${process.pid}_${Date.now()}`;
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
    created.push(name);
    const u = new URL(adminUrl);
    u.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: u.toString() });
    const h = {
      url: u.toString(),
      pool,
      db: new Kysely<any>({ dialect: new PostgresDialect({ pool }) }),
    };
    open.push(h);
    return h;
  }

  async function cleanup(): Promise<void> {
    for (const h of open) await h.db.destroy().catch(() => undefined);
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      for (const name of created) {
        await terminateTestDbBackends(admin, name);
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      }
    } finally {
      await admin.end();
    }
  }

  return { freshDb, cleanup };
}

/** The applied migration names, sorted. */
export async function ledgerNames(db: Kysely<any>): Promise<string[]> {
  const r = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(
    db,
  );
  return r.rows.map((x) => x.name);
}
