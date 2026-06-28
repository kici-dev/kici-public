import { describe, expect, it } from 'vitest';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { Database } from '../db/types.js';
import { applyAttestationFilters, baseAttestationsQuery } from './attestation-filters.js';

// Offline Kysely instance: compiles SQL without a DB connection.
const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new PostgresIntrospector(d),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const base = () => baseAttestationsQuery(db);

describe('applyAttestationFilters', () => {
  it('digest filter is exact-match', () => {
    const sql = applyAttestationFilters(base(), { digest: 'sha256:x' }).selectAll().compile().sql;
    expect(sql).toContain('"subject_digest" =');
  });

  it('name filter is ILIKE substring', () => {
    const sql = applyAttestationFilters(base(), { name: 'app' })
      .selectAll()
      .compile()
      .sql.toLowerCase();
    expect(sql).toContain('ilike');
  });

  it('status / repository / workflow / job are equality filters', () => {
    const sql = applyAttestationFilters(base(), {
      status: 'verified',
      repository: 'owner/repo',
      workflow: 'build.ts',
      job: 'build',
    })
      .selectAll()
      .compile().sql;
    expect(sql).toContain('"verify_status" =');
    expect(sql).toContain('"repo_identifier" =');
    expect(sql).toContain('"workflow_name" =');
    expect(sql).toContain('"job_name" =');
  });

  it('date range adds created_at bounds', () => {
    const sql = applyAttestationFilters(base(), {
      createdAfter: '2026-01-01',
      createdBefore: '2026-02-01',
    })
      .selectAll()
      .compile().sql;
    expect(sql).toContain('"created_at" >=');
    expect(sql).toContain('"created_at" <=');
  });

  it('no filters compiles a bare joined query', () => {
    const sql = applyAttestationFilters(base(), {}).selectAll().compile().sql;
    expect(sql).toContain('from "attestations"');
    expect(sql).not.toContain('where');
  });
});
