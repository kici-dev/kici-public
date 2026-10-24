import { describe, expect, it, vi } from 'vitest';
import {
  analyzeStatement,
  analyzeTables,
  classifyRelTuples,
  getGinTableStatsReport,
  maxHeapTuplesPerPage,
  parseQualifiedTableName,
  parseRelTuples,
  RelTuplesProblem,
  renderStatsCheckReport,
  resolveAnalyzeTargets,
  statsCheckRemediation,
  type StatsQueryable,
} from './db-stats.js';

const HEAP = { relpages: 10, relkind: 'r', maxTuplesPerPage: 291 };

function makeQueryable(): { q: StatsQueryable; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn();
  return { q: { query } as unknown as StatsQueryable, query };
}

describe('maxHeapTuplesPerPage', () => {
  it('matches PostgreSQL MaxHeapTuplesPerPage for the default 8 kB block', () => {
    // fails-when: the per-tuple or page-header byte cost drifts from PostgreSQL's
    // (MAXALIGN(23) + sizeof(ItemIdData)) and SizeOfPageHeaderData.
    expect(maxHeapTuplesPerPage(8192)).toBe(291);
    expect(maxHeapTuplesPerPage(32768)).toBe(1169);
  });
});

describe('parseRelTuples', () => {
  it('keeps the PostgreSQL special-value spellings', () => {
    expect(parseRelTuples('NaN')).toBeNaN();
    expect(parseRelTuples('Infinity')).toBe(Number.POSITIVE_INFINITY);
    expect(parseRelTuples('-Infinity')).toBe(Number.NEGATIVE_INFINITY);
    expect(parseRelTuples('1234')).toBe(1234);
    expect(parseRelTuples('-1')).toBe(-1);
    expect(parseRelTuples('1.5e+06')).toBe(1_500_000);
  });

  it('refuses a value it cannot read rather than calling it healthy', () => {
    expect(() => parseRelTuples('')).toThrow(/unrecognised/);
    expect(() => parseRelTuples('bogus')).toThrow(/unrecognised/);
  });
});

describe('classifyRelTuples', () => {
  it.each([
    [Number.NaN, RelTuplesProblem.enum.nan],
    [Number.POSITIVE_INFINITY, RelTuplesProblem.enum.infinite],
    [Number.NEGATIVE_INFINITY, RelTuplesProblem.enum.infinite],
    [-2, RelTuplesProblem.enum.negative],
    [-0.5, RelTuplesProblem.enum.negative],
    [1e30, RelTuplesProblem.enum.exceeds_page_capacity],
  ])('reports reltuples=%s as %s', (reltuples, problem) => {
    expect(classifyRelTuples({ ...HEAP, reltuples })).toBe(problem);
  });

  it('accepts a normal estimate, zero, and the -1 never-analyzed sentinel', () => {
    // breaks-if-wrong: a healthy table (or one autoanalyze has not reached yet)
    // must not be reported, or stats-check exits 2 on every fresh database.
    expect(classifyRelTuples({ ...HEAP, reltuples: 1234 })).toBeNull();
    expect(classifyRelTuples({ ...HEAP, reltuples: 0 })).toBeNull();
    expect(classifyRelTuples({ ...HEAP, reltuples: -1 })).toBeNull();
    expect(classifyRelTuples({ ...HEAP, relpages: 0, reltuples: 291 })).toBeNull();
  });

  it('puts the page-capacity bound exactly at (relpages + 1) x tuples-per-page', () => {
    // fails-when: the bound is off by a page, or compares against relpages alone.
    expect(classifyRelTuples({ ...HEAP, reltuples: 11 * 291 })).toBeNull();
    expect(classifyRelTuples({ ...HEAP, reltuples: 11 * 291 + 1 })).toBe(
      RelTuplesProblem.enum.exceeds_page_capacity,
    );
  });

  it('applies no page bound to a partitioned table, which has no pages of its own', () => {
    expect(classifyRelTuples({ ...HEAP, relkind: 'p', relpages: 0, reltuples: 1e9 })).toBeNull();
    expect(classifyRelTuples({ ...HEAP, relkind: 'p', relpages: 0, reltuples: Number.NaN })).toBe(
      RelTuplesProblem.enum.nan,
    );
  });
});

describe('getGinTableStatsReport', () => {
  it('flags only the invalid rows and lists every checked table', async () => {
    const { q, query } = makeQueryable();
    query.mockResolvedValueOnce({ rows: [{ block_size: 8192 }] }).mockResolvedValueOnce({
      rows: [
        {
          schema: 'public',
          name: 'audit_log',
          relkind: 'r',
          reltuples: 'NaN',
          relpages: 4,
          gin_indexes: ['audit_log_details_trgm'],
        },
        {
          schema: 'public',
          name: 'access_log',
          relkind: 'r',
          reltuples: '100',
          relpages: 4,
          gin_indexes: ['access_log_trgm'],
        },
      ],
    });
    const report = await getGinTableStatsReport(q);
    expect(report.clean).toBe(false);
    expect(report.needsAnalyze).toEqual(['public.audit_log']);
    expect(report.tables.map((t) => [t.table, t.problem])).toEqual([
      ['public.audit_log', 'nan'],
      ['public.access_log', null],
    ]);
    // The catalog query selects GIN indexes by access-method name.
    expect(query.mock.calls[1][0]).toMatch(/am\.amname = 'gin'/);
  });

  it('is clean when every GIN table is healthy, and when there are none', async () => {
    const { q, query } = makeQueryable();
    query
      .mockResolvedValueOnce({ rows: [{ block_size: 8192 }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(await getGinTableStatsReport(q)).toEqual({ clean: true, tables: [], needsAnalyze: [] });
  });
});

describe('parseQualifiedTableName', () => {
  it('splits at the first dot', () => {
    expect(parseQualifiedTableName('public.audit_log')).toEqual({
      schema: 'public',
      name: 'audit_log',
    });
    expect(parseQualifiedTableName('s.t.with.dots')).toEqual({ schema: 's', name: 't.with.dots' });
  });

  it.each(['audit_log', '.audit_log', 'public.', ''])('refuses %j', (raw) => {
    expect(() => parseQualifiedTableName(raw)).toThrow(/schema-qualified/);
  });
});

describe('resolveAnalyzeTargets', () => {
  it('returns the catalog names, de-duplicated', async () => {
    const { q, query } = makeQueryable();
    query.mockResolvedValue({ rows: [{ schema: 'public', name: 'audit_log' }] });
    const targets = await resolveAnalyzeTargets(q, ['public.audit_log', 'public.audit_log']);
    expect(targets).toEqual([{ schema: 'public', name: 'audit_log' }]);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][1]).toEqual(['public', 'audit_log', ['r', 'm', 'p']]);
  });

  it('refuses every unknown table by name, so nothing partial runs', async () => {
    const { q, query } = makeQueryable();
    query
      .mockResolvedValueOnce({ rows: [{ schema: 'public', name: 'audit_log' }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(resolveAnalyzeTargets(q, ['public.audit_log', 'public.nope'])).rejects.toThrow(
      /Unknown table\(s\): public\.nope\./,
    );
  });

  it('refuses an empty list', async () => {
    const { q } = makeQueryable();
    await expect(resolveAnalyzeTargets(q, [])).rejects.toThrow(/at least one --table/);
  });
});

describe('analyzeStatement / analyzeTables', () => {
  it('quotes both identifiers, escaping embedded double quotes', () => {
    expect(analyzeStatement({ schema: 'public', name: 'audit_log' })).toBe(
      'ANALYZE "public"."audit_log"',
    );
    expect(analyzeStatement({ schema: 'we"ird', name: 'x"; DROP TABLE y; --' })).toBe(
      'ANALYZE "we""ird"."x""; DROP TABLE y; --"',
    );
  });

  it('runs one ANALYZE per target, in order', async () => {
    const { q, query } = makeQueryable();
    query.mockResolvedValue({ rows: [] });
    await analyzeTables(q, [
      { schema: 'public', name: 'a' },
      { schema: 'public', name: 'b' },
    ]);
    expect(query.mock.calls.map((c) => c[0])).toEqual([
      'ANALYZE "public"."a"',
      'ANALYZE "public"."b"',
    ]);
  });
});

describe('statsCheckRemediation', () => {
  it('names the CLI and every table', () => {
    expect(statsCheckRemediation('kici-admin', ['public.a', 'public.b'])).toBe(
      "kici-admin db analyze --table public.a --table public.b --reason '<why>'",
    );
  });
});

describe('renderStatsCheckReport', () => {
  const healthy = {
    table: 'public.a',
    schema: 'public',
    name: 'a',
    relkind: 'r',
    reltuples: '10',
    relpages: 1,
    ginIndexes: ['a_gin'],
    problem: null,
  };

  it('prints one JSON line that keeps NaN as the PostgreSQL string', () => {
    const report = {
      clean: false,
      tables: [{ ...healthy, reltuples: 'NaN', problem: RelTuplesProblem.enum.nan }],
      needsAnalyze: ['public.a'],
    };
    const out = renderStatsCheckReport('kici-admin', 'kici', report, true);
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out)).toEqual({ database: 'kici', ...report });
  });

  it('prints a clean verdict with the checked-table count', () => {
    const out = renderStatsCheckReport(
      'kici-admin',
      'kici',
      { clean: true, tables: [healthy], needsAnalyze: [] },
      false,
    );
    expect(out).toBe('db stats-check: kici — clean (1 table(s) with GIN indexes checked)\n');
  });

  it('lists only the invalid tables and the fix command for the named CLI', () => {
    const out = renderStatsCheckReport(
      'kici-platform-admin',
      'platform',
      {
        clean: false,
        tables: [
          healthy,
          { ...healthy, table: 'public.b', reltuples: 'Infinity', problem: 'infinite' },
        ],
        needsAnalyze: ['public.b'],
      },
      false,
    );
    expect(out.split('\n')).toEqual([
      'db stats-check: platform — 1 table(s) need ANALYZE',
      '  public.b  reltuples=Infinity  (infinite)',
      "  Fix: kici-platform-admin db analyze --table public.b --reason '<why>'",
      '',
    ]);
  });
});
