import { MIGRATION_HASH_TABLE } from './db-admin.js';

/** Tables the migration runner owns; never part of an application schema. */
export const MIGRATION_TOOLING_TABLES: readonly string[] = [
  'kysely_migration',
  'kysely_migration_lock',
  MIGRATION_HASH_TABLE,
];

export interface ColumnFingerprint {
  type: string;
  nullable: boolean;
  default: string | null;
}

/**
 * A normalized description of the `public` schema, read from `pg_catalog`.
 * Two databases with equal fingerprints have the same tables, columns,
 * constraints, indexes, functions, triggers, sequences and extensions.
 *
 * Extension-owned functions are left out, so a server-side extension version
 * does not register as drift. `NOT NULL` constraints are left out of
 * `constraints`: PostgreSQL names them after the table and column at the
 * moment the constraint is created (or the cluster is upgraded), so a renamed
 * column keeps a stale name on one database and not on another.
 * `columns[*].nullable` carries the same fact without the name.
 */
export interface SchemaFingerprint {
  /** `${table}.${column}` → its type, nullability and default. */
  columns: Record<string, ColumnFingerprint>;
  /** `${table}.${name}` → `${contype} ${definition}`. */
  constraints: Record<string, string>;
  /** Index name → `indexdef`. */
  indexes: Record<string, string>;
  /** `${name}(${identityArgs})` → function definition. */
  functions: Record<string, string>;
  /** `${table}.${name}` → trigger definition. */
  triggers: Record<string, string>;
  sequences: string[];
  extensions: string[];
}

/**
 * One difference between an expected and an actual fingerprint. `path` is
 * `${section}:${key}`, e.g. `columns:held_runs.status`. `missing` is present
 * only in the expected fingerprint, `extra` only in the actual one.
 */
export interface FingerprintDiffEntry {
  path: string;
  kind: 'missing' | 'extra' | 'changed';
  expected?: unknown;
  actual?: unknown;
}

/** The one call a fingerprint makes: a parameterless query returning rows. A `pg.Pool` or client satisfies it. */
export interface SqlQueryable {
  query<R>(text: string): Promise<{ rows: R[] }>;
}

/** Code-point order, so a snapshot renders identically under every locale. */
function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  return Object.fromEntries(entries.sort(([a], [b]) => byKey(a, b)));
}

/**
 * Fingerprint the `public` schema of the database behind `db`.
 * `excludeIndexes` names indexes built at runtime rather than by a migration,
 * so their presence never counts as drift. The migration tooling tables are
 * always excluded.
 */
export async function fingerprintSchema(
  db: SqlQueryable,
  opts: { excludeIndexes?: readonly string[] } = {},
): Promise<SchemaFingerprint> {
  const skipTable = new Set(MIGRATION_TOOLING_TABLES);
  const skipIndex = new Set(opts.excludeIndexes ?? []);

  const columns = await db.query<{
    table_name: string;
    column_name: string;
    type: string;
    nullable: boolean;
    column_default: string | null;
  }>(`
    SELECT cls.relname AS table_name, a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS type,
           NOT a.attnotnull AS nullable,
           pg_get_expr(d.adbin, d.adrelid) AS column_default
      FROM pg_attribute a
      JOIN pg_class cls ON cls.oid = a.attrelid AND cls.relkind IN ('r', 'p')
      JOIN pg_namespace n ON n.oid = cls.relnamespace AND n.nspname = 'public'
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attnum > 0 AND NOT a.attisdropped`);

  const constraints = await db.query<{
    table_name: string;
    name: string;
    contype: string;
    def: string;
  }>(`
    SELECT cls.relname AS table_name, con.conname AS name, con.contype::text AS contype,
           pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = cls.relnamespace AND n.nspname = 'public'
     WHERE con.contype <> 'n'`);

  const indexes = await db.query<{ table_name: string; name: string; def: string }>(`
    SELECT tablename AS table_name, indexname AS name, indexdef AS def
      FROM pg_indexes WHERE schemaname = 'public'`);

  const functions = await db.query<{ sig: string; def: string }>(`
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
           pg_get_functiondef(p.oid) AS def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE p.prokind = 'f'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`);

  const triggers = await db.query<{ table_name: string; name: string; def: string }>(`
    SELECT cls.relname AS table_name, t.tgname AS name, pg_get_triggerdef(t.oid) AS def
      FROM pg_trigger t
      JOIN pg_class cls ON cls.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = cls.relnamespace AND n.nspname = 'public'
     WHERE NOT t.tgisinternal`);

  const sequences = await db.query<{ name: string }>(`
    SELECT sequence_name AS name FROM information_schema.sequences WHERE sequence_schema = 'public'`);

  const extensions = await db.query<{ name: string }>(`SELECT extname AS name FROM pg_extension`);

  return {
    columns: sortedRecord(
      columns.rows
        .filter((r) => !skipTable.has(r.table_name))
        .map((r) => [
          `${r.table_name}.${r.column_name}`,
          { type: r.type, nullable: r.nullable, default: r.column_default },
        ]),
    ),
    constraints: sortedRecord(
      constraints.rows
        .filter((r) => !skipTable.has(r.table_name))
        .map((r) => [`${r.table_name}.${r.name}`, `${r.contype} ${r.def}`]),
    ),
    indexes: sortedRecord(
      indexes.rows
        .filter((r) => !skipTable.has(r.table_name) && !skipIndex.has(r.name))
        .map((r) => [r.name, r.def]),
    ),
    functions: sortedRecord(functions.rows.map((r) => [r.sig, r.def])),
    triggers: sortedRecord(
      triggers.rows
        .filter((r) => !skipTable.has(r.table_name))
        .map((r) => [`${r.table_name}.${r.name}`, r.def]),
    ),
    sequences: sequences.rows.map((r) => r.name).sort(byKey),
    extensions: extensions.rows.map((r) => r.name).sort(byKey),
  };
}

const RECORD_SECTIONS = ['columns', 'constraints', 'indexes', 'functions', 'triggers'] as const;
const SET_SECTIONS = ['sequences', 'extensions'] as const;

/**
 * Every difference between two fingerprints, ordered by section then key.
 * Record sections compare values; `sequences` and `extensions` compare as sets.
 *
 * An extension the actual database has and the expected one does not is not a
 * difference: the database host installs its own (Spilo adds
 * `pg_stat_statements`, `pg_stat_kcache` and `set_user` to every database
 * it bootstraps or restores, and managed services add theirs), and the
 * functions an extension owns are already left out. A missing extension is
 * still a difference.
 */
export function diffFingerprints(
  expected: SchemaFingerprint,
  actual: SchemaFingerprint,
): FingerprintDiffEntry[] {
  const out: FingerprintDiffEntry[] = [];
  for (const section of RECORD_SECTIONS) {
    const e: Record<string, unknown> = expected[section];
    const a: Record<string, unknown> = actual[section];
    for (const key of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort(byKey)) {
      const path = `${section}:${key}`;
      if (!Object.hasOwn(a, key)) out.push({ path, kind: 'missing', expected: e[key] });
      else if (!Object.hasOwn(e, key)) out.push({ path, kind: 'extra', actual: a[key] });
      else if (JSON.stringify(e[key]) !== JSON.stringify(a[key])) {
        out.push({ path, kind: 'changed', expected: e[key], actual: a[key] });
      }
    }
  }
  for (const section of SET_SECTIONS) {
    const e = new Set(expected[section]);
    const a = new Set(actual[section]);
    for (const name of [...new Set([...e, ...a])].sort(byKey)) {
      const path = `${section}:${name}`;
      if (!a.has(name)) out.push({ path, kind: 'missing', expected: name });
      else if (!e.has(name) && section !== 'extensions') {
        out.push({ path, kind: 'extra', actual: name });
      }
    }
  }
  return out;
}

/** One line per entry, for CLI output. */
export function formatDiffEntry(entry: FingerprintDiffEntry): string {
  const parts = [entry.kind.padEnd(7), entry.path];
  if (entry.expected !== undefined) parts.push(`expected=${JSON.stringify(entry.expected)}`);
  if (entry.actual !== undefined) parts.push(`actual=${JSON.stringify(entry.actual)}`);
  return parts.join('  ');
}

/** TypeScript source for a committed `schema-snapshot.generated.ts` module. */
export function renderSnapshotModule(fp: SchemaFingerprint, generator: string): string {
  return [
    `// Generated by ${generator}. Do not edit by hand.`,
    `import type { SchemaFingerprint } from '@kici-dev/shared';`,
    '',
    `export const SCHEMA_SNAPSHOT: SchemaFingerprint = ${JSON.stringify(fp, null, 2)};`,
    '',
  ].join('\n');
}
