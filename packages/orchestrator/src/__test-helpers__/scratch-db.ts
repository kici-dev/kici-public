/** Migration-ledger helper for the DB-gated tests. */
import { type Kysely, sql } from 'kysely';

/** The applied migration names, sorted. */
export async function ledgerNames(db: Kysely<any>): Promise<string[]> {
  const r = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(
    db,
  );
  return r.rows.map((x) => x.name);
}
