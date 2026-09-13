/**
 * Real-Postgres tests for how the registrations handler matches an
 * `execution_runs` row to the registration that owns it.
 *
 * An organization-wide workflow is DEFINED in one repository and dispatched
 * against another, so its run carries the acted-on repository in
 * `repo_identifier` and the defining one in `workflow_repo_identifier`. The
 * registration, however, only ever names the repository the workflow is
 * defined in — so matching a run to a registration on `repo_identifier` alone
 * both misses every global run and claims global runs that belong to another
 * repository's registration of the same name.
 *
 * Both halves are exercised with real SQL because the predicate IS the
 * behaviour: a mocked query builder would return whatever rows the test
 * handed it and prove nothing about which rows the database picks.
 *
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { ExecutionRunStatus, type LockWorkflow } from '@kici-dev/engine';
import { createMigrationProvider } from '../db/migration-provider.js';
import { DashboardRegistrationsHandler } from './dashboard-registrations-handler.js';
import type { RegistrationRow, RegistrationStore } from '../registration/registration-store.js';
import type { RegistrationIndex } from '../registration/registration-index.js';
import type { Database } from '../db/types.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_regruns_test_${process.pid}_${Date.now()}`;

/** The repository a global workflow is defined in. */
const WORKFLOW_REPO = 'acme/ci-defs';
/** The repository the global workflow is dispatched against. */
const SOURCE_REPO = 'acme/app';
/** Both repositories define a workflow under this name — two lock files, one name. */
const WORKFLOW = 'ci';

const ACTOR = { type: 'user' as const, sub: 'zsub-test' };

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

function makeRegistration(id: string, repoIdentifier: string): RegistrationRow {
  const lockEntry: LockWorkflow = {
    name: WORKFLOW,
    contentHash: 'abc123',
    compileSchemaVersion: 1,
    triggers: [{ _type: 'push', branches: ['main'] } as never],
    jobs: [],
  };
  return {
    id,
    repo_identifier: repoIdentifier,
    workflow_name: WORKFLOW,
    lock_entry: lockEntry,
    trigger_types: ['push'],
    routing_key: 'github:42',
    provider_context: {},
    disabled: false,
    commitSha: null,
    sourceFile: null,
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-02'),
  };
}

describeDb('registration ↔ run matching for a cross-repository global workflow', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  /** run label → run_id, so assertions read by name rather than by uuid. */
  const runIds = new Map<string, string>();

  const seedRun = async (args: {
    label: string;
    repoIdentifier: string;
    workflowRepoIdentifier: string | null;
    status: string;
    startedAt: Date;
  }): Promise<void> => {
    const runId = randomUUID();
    runIds.set(args.label, runId);
    await db
      .insertInto('execution_runs')
      .values({
        run_id: runId,
        workflow_name: WORKFLOW,
        provider: 'github',
        repo_identifier: args.repoIdentifier,
        workflow_repo_identifier: args.workflowRepoIdentifier,
        ref: 'main',
        sha: 'deadbeef',
        status: args.status,
        started_at: args.startedAt,
      })
      .execute();
  };

  const statusOf = async (label: string): Promise<string> => {
    const row = await db
      .selectFrom('execution_runs')
      .select('status')
      .where('run_id', '=', runIds.get(label)!)
      .executeTakeFirstOrThrow();
    return row.status;
  };

  const makeHandler = (
    registrations: RegistrationRow[],
    send: (msg: unknown) => void,
  ): DashboardRegistrationsHandler =>
    new DashboardRegistrationsHandler({
      db,
      registrationStore: {
        getAll: vi.fn().mockResolvedValue(registrations),
        getById: vi.fn(async (id: string) => registrations.find((r) => r.id === id) ?? null),
        deleteById: vi.fn().mockResolvedValue(true),
        bumpVersion: vi.fn().mockResolvedValue(undefined),
      } as unknown as RegistrationStore,
      registrationIndex: {
        getVersion: vi.fn().mockReturnValue(1),
        loadFromDb: vi.fn().mockResolvedValue(undefined),
      } as unknown as RegistrationIndex,
      send,
      orgId: 'org-1',
    });

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const migrator = new Migrator({ db, provider: createMigrationProvider() });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [TEST_DB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  beforeEach(async () => {
    runIds.clear();
    await db.deleteFrom('execution_runs').execute();
  });

  describe('last triggered', () => {
    beforeEach(async () => {
      await seedRun({
        label: 'per-repo',
        repoIdentifier: SOURCE_REPO,
        workflowRepoIdentifier: null,
        status: ExecutionRunStatus.enum.success,
        startedAt: new Date('2026-02-01T00:00:00Z'),
      });
      await seedRun({
        label: 'global',
        repoIdentifier: SOURCE_REPO,
        workflowRepoIdentifier: WORKFLOW_REPO,
        status: ExecutionRunStatus.enum.success,
        startedAt: new Date('2026-02-02T00:00:00Z'),
      });
    });

    it('reports the global run against the registration that defines the workflow', async () => {
      const send = vi.fn();
      const handler = makeHandler([makeRegistration('reg-global', WORKFLOW_REPO)], send);

      await handler.handle({ type: 'dashboard.registrations.list', requestId: 'req-1' } as never);

      const response = send.mock.calls[0][0] as {
        registrations: Array<{ id: string; lastTriggeredAt: string | null }>;
      };
      expect(response.registrations[0].id).toBe('reg-global');
      expect(response.registrations[0].lastTriggeredAt).toBe('2026-02-02T00:00:00.000Z');
    });

    it('does not report the global run against the acted-on repository registration', async () => {
      // `acme/app` also defines a `ci`. The global run acted on `acme/app` but
      // is not a trigger of ITS `ci`, so the timestamp must stay that of the
      // per-repository run.
      const send = vi.fn();
      const handler = makeHandler([makeRegistration('reg-per-repo', SOURCE_REPO)], send);

      await handler.handle({ type: 'dashboard.registrations.list', requestId: 'req-2' } as never);

      const response = send.mock.calls[0][0] as {
        registrations: Array<{ id: string; lastTriggeredAt: string | null }>;
      };
      expect(response.registrations[0].id).toBe('reg-per-repo');
      expect(response.registrations[0].lastTriggeredAt).toBe('2026-02-01T00:00:00.000Z');
    });
  });

  describe('delete with cancelActiveRuns', () => {
    beforeEach(async () => {
      await seedRun({
        label: 'per-repo',
        repoIdentifier: SOURCE_REPO,
        workflowRepoIdentifier: null,
        status: ExecutionRunStatus.enum.running,
        startedAt: new Date('2026-02-01T00:00:00Z'),
      });
      await seedRun({
        label: 'global',
        repoIdentifier: SOURCE_REPO,
        workflowRepoIdentifier: WORKFLOW_REPO,
        status: ExecutionRunStatus.enum.running,
        startedAt: new Date('2026-02-02T00:00:00Z'),
      });
    });

    it('cancels the global registration in-flight runs', async () => {
      const send = vi.fn();
      const handler = makeHandler([makeRegistration('reg-global', WORKFLOW_REPO)], send);

      await handler.handle({
        type: 'dashboard.registration.delete',
        requestId: 'req-3',
        actor: ACTOR,
        registrationId: 'reg-global',
        cancelActiveRuns: true,
      } as never);

      expect(await statusOf('global')).toBe(ExecutionRunStatus.enum.cancelled);
      expect(await statusOf('per-repo')).toBe(ExecutionRunStatus.enum.running);
    });

    it('leaves the global run alone when the acted-on repository registration is deleted', async () => {
      const send = vi.fn();
      const handler = makeHandler([makeRegistration('reg-per-repo', SOURCE_REPO)], send);

      await handler.handle({
        type: 'dashboard.registration.delete',
        requestId: 'req-4',
        actor: ACTOR,
        registrationId: 'reg-per-repo',
        cancelActiveRuns: true,
      } as never);

      expect(await statusOf('per-repo')).toBe(ExecutionRunStatus.enum.cancelled);
      expect(await statusOf('global')).toBe(ExecutionRunStatus.enum.running);
    });
  });
});
