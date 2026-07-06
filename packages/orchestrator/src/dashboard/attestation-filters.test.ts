import { describe, expect, it } from 'vitest';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { Database } from '../db/types.js';
import {
  applyAttestationFilters,
  baseAttestationsQuery,
  basePendingAttestationsQuery,
} from './attestation-filters.js';

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

  it('base query casts execution_* uuid keys to text (uuid = text guard)', () => {
    // Regression: Postgres rejects `uuid = text`, so both attestations base
    // queries must cast the uuid side to text in every join predicate.
    const sql = base().selectAll().compile().sql;
    expect(sql).toContain('execution_jobs.job_id::text');
    expect(sql).toContain('execution_jobs.run_id::text');
    expect(sql).toContain('execution_runs.run_id::text');
  });
});

describe('basePendingAttestationsQuery', () => {
  it('joins execution_* with a ::text cast on every uuid key', () => {
    // Regression for the org-wide attestations 500: joining the TEXT-keyed
    // pending_attestations outbox to the uuid-keyed execution_runs /
    // execution_jobs without a cast raised `operator does not exist: uuid = text`
    // at runtime, returning a 500 from handleAttestationsListAll.
    const sql = basePendingAttestationsQuery(db).selectAll().compile().sql;
    expect(sql).toContain('from "pending_attestations"');
    expect(sql).toContain('execution_runs.run_id::text');
    expect(sql).toContain('execution_jobs.run_id::text');
    expect(sql).toContain('execution_jobs.job_id::text');
    // Both joins are LEFT joins (pending rows without a matching run/job still list).
    expect(sql.toLowerCase()).toContain('left join');
  });
});
