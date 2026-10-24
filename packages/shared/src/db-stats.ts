import pg from 'pg';
import { z } from 'zod';

/**
 * Planner-statistics health helpers shared by `kici-admin` (orchestrator DB)
 * and `kici-platform-admin` (Platform DB): `db stats-check` and `db analyze`.
 *
 * PostgreSQL 18.6 fixed a bug where a parallel GIN index build could write an
 * uninitialized row count into the table's `pg_class.reltuples`, "even
 * Infinity or NaN". Autovacuum and autoanalyze then never decide the table
 * needs processing, so the value does not heal by itself: a manual `ANALYZE`
 * (or another index build) resets it. The release notes ask every installation
 * with GIN indexes to check that their tables' `reltuples` look sane.
 *
 * A value is reported as invalid when it is:
 *
 * - `NaN`, `Infinity` or `-Infinity`;
 * - negative other than `-1` (PostgreSQL stores `-1` for "never vacuumed or
 *   analyzed", which autoanalyze handles);
 * - for a heap table or materialized view, larger than its pages can hold
 *   (`(relpages + 1) × MaxHeapTuplesPerPage`). An uninitialized count is more
 *   often a large finite number than NaN, and no real estimate can exceed the
 *   heap's physical capacity. Partitioned tables have no pages of their own,
 *   so only the first two rules apply to them.
 *
 * The helpers never own the connection lifecycle; the CLI layer creates and
 * ends it.
 */

/** Why a `reltuples` value is invalid. */
export const RelTuplesProblem = z.enum(['nan', 'infinite', 'negative', 'exceeds_page_capacity']);
export type RelTuplesProblem = z.infer<typeof RelTuplesProblem>;

/** `pg_class.relkind` values that hold planner row estimates and accept `ANALYZE`. */
const ANALYZABLE_RELKINDS = ['r', 'm', 'p'] as const;
/** The relkinds whose `relpages` bound the row count (partitioned tables have no pages). */
const HEAP_RELKINDS: ReadonlySet<string> = new Set(['r', 'm']);

/** Page header (24 bytes) and per-tuple cost: MAXALIGN'd tuple header (24) + line pointer (4). */
const PAGE_HEADER_BYTES = 24;
const MIN_TUPLE_BYTES = 24 + 4;

/** The minimum query surface: `pg.Pool`, `pg.PoolClient` and `pg.Client` all satisfy it. */
export interface StatsQueryable {
  query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export interface GinTableStats {
  /** `schema.table`, the form `db analyze --table` takes. */
  table: string;
  schema: string;
  name: string;
  relkind: string;
  /** `pg_class.reltuples` as PostgreSQL prints it (`NaN` and `Infinity` survive JSON). */
  reltuples: string;
  relpages: number;
  ginIndexes: string[];
  problem: RelTuplesProblem | null;
}

export interface StatsCheckReport {
  clean: boolean;
  /** Every table with at least one GIN index, healthy ones included. */
  tables: GinTableStats[];
  /** `schema.table` of every table whose `reltuples` is invalid. */
  needsAnalyze: string[];
}

export interface AnalyzeTarget {
  schema: string;
  name: string;
}

/** PostgreSQL's MaxHeapTuplesPerPage for a block size (291 for the default 8 kB). */
export function maxHeapTuplesPerPage(blockSize: number): number {
  return Math.floor((blockSize - PAGE_HEADER_BYTES) / MIN_TUPLE_BYTES);
}

/** Parse `reltuples::text`, keeping PostgreSQL's `NaN` / `Infinity` / `-Infinity` spellings. */
export function parseRelTuples(text: string): number {
  if (text === 'NaN') return Number.NaN;
  if (text === 'Infinity') return Number.POSITIVE_INFINITY;
  if (text === '-Infinity') return Number.NEGATIVE_INFINITY;
  const value = Number(text);
  if (text.trim() === '' || Number.isNaN(value)) {
    throw new Error(`parseRelTuples: unrecognised reltuples value "${text}"`);
  }
  return value;
}

/** Returns why `reltuples` is invalid, or `null` when it looks sane. */
export function classifyRelTuples(stats: {
  reltuples: number;
  relpages: number;
  relkind: string;
  maxTuplesPerPage: number;
}): RelTuplesProblem | null {
  const { reltuples, relpages, relkind, maxTuplesPerPage } = stats;
  if (Number.isNaN(reltuples)) return RelTuplesProblem.enum.nan;
  if (!Number.isFinite(reltuples)) return RelTuplesProblem.enum.infinite;
  if (reltuples < 0 && reltuples !== -1) return RelTuplesProblem.enum.negative;
  if (HEAP_RELKINDS.has(relkind) && reltuples > (relpages + 1) * maxTuplesPerPage) {
    return RelTuplesProblem.enum.exceeds_page_capacity;
  }
  return null;
}

interface GinTableRow {
  schema: string;
  name: string;
  relkind: string;
  reltuples: string;
  relpages: number;
  gin_indexes: string[];
}

/** Every user table with a GIN index, with its `reltuples` verdict. */
export async function getGinTableStatsReport(q: StatsQueryable): Promise<StatsCheckReport> {
  const blockSize = await q.query<{ block_size: number }>(
    `SELECT current_setting('block_size')::int AS block_size`,
  );
  const maxTuplesPerPage = maxHeapTuplesPerPage(blockSize.rows[0]!.block_size);
  const result = await q.query<GinTableRow>(
    `SELECT n.nspname::text AS schema,
            t.relname::text AS name,
            t.relkind::text AS relkind,
            t.reltuples::text AS reltuples,
            t.relpages::int AS relpages,
            array_agg(DISTINCT ic.relname::text ORDER BY ic.relname::text) AS gin_indexes
       FROM pg_class t
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_index i ON i.indrelid = t.oid
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_am am ON am.oid = ic.relam
      WHERE am.amname = 'gin'
        AND t.relkind = ANY($1::"char"[])
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg\\_toast%'
        AND n.nspname NOT LIKE 'pg\\_temp\\_%'
      GROUP BY n.nspname, t.relname, t.relkind, t.reltuples, t.relpages
      ORDER BY 1, 2`,
    [ANALYZABLE_RELKINDS],
  );
  const tables = result.rows.map((row): GinTableStats => {
    const problem = classifyRelTuples({
      reltuples: parseRelTuples(row.reltuples),
      relpages: row.relpages,
      relkind: row.relkind,
      maxTuplesPerPage,
    });
    return {
      table: `${row.schema}.${row.name}`,
      schema: row.schema,
      name: row.name,
      relkind: row.relkind,
      reltuples: row.reltuples,
      relpages: row.relpages,
      ginIndexes: row.gin_indexes,
      problem,
    };
  });
  const needsAnalyze = tables.filter((t) => t.problem !== null).map((t) => t.table);
  return { clean: needsAnalyze.length === 0, tables, needsAnalyze };
}

/**
 * Split a `--table` value at its first dot. A bare name is refused rather than
 * resolved through `search_path`, so the command acts on the table the
 * operator named and nothing else.
 */
export function parseQualifiedTableName(raw: string): AnalyzeTarget {
  const dot = raw.indexOf('.');
  const schema = dot > 0 ? raw.slice(0, dot) : '';
  const name = dot > 0 ? raw.slice(dot + 1) : '';
  if (!schema || !name) {
    throw new Error(
      `--table must be schema-qualified (for example public.audit_log), got "${raw}"`,
    );
  }
  return { schema, name };
}

/**
 * Resolve every `--table` value against `pg_class`. Throws, naming each one,
 * when any value is not an existing table, partitioned table or materialized
 * view, so a typo never runs a partial `ANALYZE`.
 */
export async function resolveAnalyzeTargets(
  q: StatsQueryable,
  rawNames: string[],
): Promise<AnalyzeTarget[]> {
  if (rawNames.length === 0) {
    throw new Error('Pass at least one --table <schema.table>.');
  }
  const unique = [...new Set(rawNames)];
  const targets: AnalyzeTarget[] = [];
  const unknown: string[] = [];
  for (const raw of unique) {
    const wanted = parseQualifiedTableName(raw);
    const found = await q.query<{ schema: string; name: string }>(
      `SELECT n.nspname::text AS schema, c.relname::text AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = ANY($3::"char"[])`,
      [wanted.schema, wanted.name, ANALYZABLE_RELKINDS],
    );
    const row = found.rows[0];
    if (row) targets.push({ schema: row.schema, name: row.name });
    else unknown.push(raw);
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown table(s): ${unknown.join(', ')}. No table, partitioned table or materialized view has that name; nothing was analyzed.`,
    );
  }
  return targets;
}

/** `ANALYZE "schema"."name"`, both identifiers quoted. */
export function analyzeStatement(target: AnalyzeTarget): string {
  return `ANALYZE ${pg.escapeIdentifier(target.schema)}.${pg.escapeIdentifier(target.name)}`;
}

/** Runs one `ANALYZE` per target, in order. */
export async function analyzeTables(q: StatsQueryable, targets: AnalyzeTarget[]): Promise<void> {
  for (const target of targets) {
    await q.query(analyzeStatement(target));
  }
}

/** The copy-pasteable fix line `stats-check` prints for invalid tables. */
export function statsCheckRemediation(cliName: string, tables: string[]): string {
  const flags = tables.map((t) => `--table ${t}`).join(' ');
  return `${cliName} db analyze ${flags} --reason '<why>'`;
}

/**
 * The full `db stats-check` stdout for both admin CLIs: one JSON line with
 * `json`, else a verdict line, one line per invalid table and the fix command.
 */
export function renderStatsCheckReport(
  cliName: string,
  database: string,
  report: StatsCheckReport,
  json: boolean,
): string {
  if (json) return JSON.stringify({ database, ...report }) + '\n';
  if (report.clean) {
    return `db stats-check: ${database} — clean (${report.tables.length} table(s) with GIN indexes checked)\n`;
  }
  const lines = [
    `db stats-check: ${database} — ${report.needsAnalyze.length} table(s) need ANALYZE`,
  ];
  for (const t of report.tables.filter((row) => row.problem)) {
    lines.push(`  ${t.table}  reltuples=${t.reltuples}  (${t.problem})`);
  }
  lines.push(`  Fix: ${statsCheckRemediation(cliName, report.needsAnalyze)}`);
  return lines.join('\n') + '\n';
}
