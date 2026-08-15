import { describe, expect, it } from 'vitest';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { Database } from '../db/types.js';
import { definingRepoOfRun, runsDefinedByRepos } from './registration-run-match.js';

// Offline Kysely instance: compiles SQL without a DB connection.
const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (d) => new PostgresIntrospector(d),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const compile = (repos: string[]) =>
  db
    .selectFrom('execution_runs')
    .select('run_id')
    .where((eb) => runsDefinedByRepos(eb, repos))
    .compile();

describe('runsDefinedByRepos', () => {
  it('matches the defining repository on both arms', () => {
    const { sql, parameters } = compile(['acme/ci-defs']);
    expect(sql).toContain('"workflow_repo_identifier" in (');
    expect(sql).toContain('"workflow_repo_identifier" is null');
    expect(sql).toContain('"repo_identifier" in (');
    // Both arms bind the same repository — the defining one.
    expect(parameters).toEqual(['acme/ci-defs', 'acme/ci-defs']);
  });

  it('compiles an empty list to a constant false, not the syntax error `in ()`', () => {
    // Postgres rejects `in ()` outright, so an empty list would fail the whole
    // query rather than match nothing. Both call sites guard today; this is a
    // shared leaf predicate and the next one may not.
    const { sql, parameters } = compile([]);
    expect(sql).not.toContain('in ()');
    expect(sql).toContain('false');
    expect(parameters).toEqual([]);
  });
});

describe('definingRepoOfRun', () => {
  it('prefers the workflow repository and falls back to the acted-on one', () => {
    expect(
      definingRepoOfRun({ repo_identifier: 'acme/app', workflow_repo_identifier: 'acme/ci-defs' }),
    ).toBe('acme/ci-defs');
    expect(definingRepoOfRun({ repo_identifier: 'acme/app', workflow_repo_identifier: null })).toBe(
      'acme/app',
    );
  });
});
