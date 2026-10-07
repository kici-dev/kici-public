import { describe, expect, it } from 'vitest';
import {
  diffFingerprints,
  formatDiffEntry,
  renderSnapshotModule,
  type SchemaFingerprint,
} from './db-schema-fingerprint.js';

const BASE: SchemaFingerprint = {
  columns: { 'runs.id': { type: 'uuid', nullable: false, default: 'gen_random_uuid()' } },
  constraints: { 'runs.runs_pkey': 'p PRIMARY KEY (id)' },
  indexes: { runs_pkey: 'CREATE UNIQUE INDEX runs_pkey ON public.runs USING btree (id)' },
  functions: {},
  triggers: {},
  sequences: [],
  extensions: ['pg_trgm', 'plpgsql'],
};

describe('diffFingerprints', () => {
  it('is empty for identical fingerprints', () => {
    expect(diffFingerprints(BASE, structuredClone(BASE))).toEqual([]);
  });

  it('reports an extra column, a missing index and a changed default', () => {
    // fails-when: any of the three classes is not compared, or kinds are swapped.
    const actual = structuredClone(BASE);
    actual.columns['runs.extra'] = { type: 'text', nullable: true, default: null };
    delete actual.indexes.runs_pkey;
    actual.columns['runs.id'].default = null;
    expect(diffFingerprints(BASE, actual)).toEqual([
      {
        path: 'columns:runs.extra',
        kind: 'extra',
        actual: { type: 'text', nullable: true, default: null },
      },
      {
        path: 'columns:runs.id',
        kind: 'changed',
        expected: { type: 'uuid', nullable: false, default: 'gen_random_uuid()' },
        actual: { type: 'uuid', nullable: false, default: null },
      },
      {
        path: 'indexes:runs_pkey',
        kind: 'missing',
        expected: 'CREATE UNIQUE INDEX runs_pkey ON public.runs USING btree (id)',
      },
    ]);
  });

  it('compares constraints, functions and triggers by value', () => {
    // fails-when: a record section other than columns/indexes is skipped.
    const actual = structuredClone(BASE);
    actual.constraints['runs.runs_pkey'] = 'p PRIMARY KEY (id, name)';
    actual.functions['touch()'] = 'CREATE FUNCTION touch()';
    actual.triggers['runs.touch'] = 'CREATE TRIGGER touch';
    expect(diffFingerprints(BASE, actual).map((e) => `${e.kind} ${e.path}`)).toEqual([
      'changed constraints:runs.runs_pkey',
      'extra functions:touch()',
      'extra triggers:runs.touch',
    ]);
  });

  it('compares extensions and sequences as sets', () => {
    const reordered = { ...structuredClone(BASE), extensions: ['plpgsql', 'pg_trgm'] };
    expect(diffFingerprints(BASE, reordered)).toEqual([]);

    // fails-when: set sections are not compared at all.
    const changed = { ...structuredClone(BASE), extensions: ['plpgsql'], sequences: ['s1'] };
    expect(diffFingerprints(BASE, changed)).toEqual([
      { path: 'sequences:s1', kind: 'extra', actual: 's1' },
      { path: 'extensions:pg_trgm', kind: 'missing', expected: 'pg_trgm' },
    ]);
  });

  it('does not count an extension the database host installed', () => {
    // breaks-if-wrong: a Spilo-restored or managed database carries extensions no
    // migration created; reporting them fails the post-migrate deploy check.
    const hosted = {
      ...structuredClone(BASE),
      extensions: ['pg_stat_kcache', 'pg_stat_statements', 'pg_trgm', 'plpgsql', 'set_user'],
    };
    expect(diffFingerprints(BASE, hosted)).toEqual([]);
    // fails-when: an extra sequence is ignored along with the extra extension.
    hosted.sequences = ['s1'];
    expect(diffFingerprints(BASE, hosted)).toEqual([
      { path: 'sequences:s1', kind: 'extra', actual: 's1' },
    ]);
  });

  it('formats an entry as one line', () => {
    expect(
      formatDiffEntry({
        path: 'columns:x.y',
        kind: 'extra',
        actual: { type: 'text', nullable: true, default: null },
      }),
    ).toBe('extra    columns:x.y  actual={"type":"text","nullable":true,"default":null}');
  });

  it('renders a module that exports the fingerprint', () => {
    const src = renderSnapshotModule(BASE, 'src/db/schema-snapshot.test.ts');
    expect(src).toContain('export const SCHEMA_SNAPSHOT: SchemaFingerprint =');
    expect(src).toContain('"runs.id"');
    // fails-when: the rendered literal does not round-trip to the fingerprint.
    const literal = src.slice(src.indexOf('= ') + 2, src.lastIndexOf(';'));
    expect(JSON.parse(literal)).toEqual(BASE);
  });
});
