/**
 * The direct-ingress `ProcessingDeps` assembly.
 *
 * This is a WIRING seam, and a wiring seam is where an approval defect hides:
 * a field the composition root forgets reads as `undefined`, every guard
 * downstream degrades rather than throws, and the whole feature is silently
 * inert. Two omissions of exactly that shape are what this file exists to
 * prevent from recurring — `trustPolicyStore` (so the fork switch always
 * applied `FAIL_CLOSED_POLICY` and DROPPED every fork PR) and `heldRunStore`
 * (so no hold could be raised on the one pipeline an independent orchestrator
 * has).
 *
 * The second block is the end-to-end proof, against a real database: the same
 * assembled bag, handed to the same `evaluateSecurityPolicy` the pipeline
 * calls, answers `ignore` for an org with no stored row and `hold` for one
 * whose operator chose `hold`. A stub store would prove the field was READ; it
 * would not prove an operator's `kici-admin trust-policy set` reaches the
 * verdict, which is the claim.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { ForkPolicy, OrchestratorMode } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import { createMigrationProvider } from '../db/migration-provider.js';
import { TrustDirectoryStore } from '../security/trust-directory-store.js';
import { TrustPolicyStore } from '../security/trust-policy-store.js';
import { SecurityHoldReason } from '../contexts/held-runs.js';
import {
  createDirectIngressProcessingDeps,
  type DirectIngressDepsSource,
} from './direct-ingress-deps.js';
import { evaluateSecurityPolicy } from './process-webhook.js';
import type { ProviderBundle } from '../provider-registry.js';

const NOOP_HOOKS = { onSourceLocationsExtracted: vi.fn() };

/**
 * The smallest source object the factory type-checks against. Every field the
 * assertions below read is set explicitly; the rest are left undefined, which
 * is exactly what a deployment without that subsystem hands over.
 */
function sourceWith(partial: Partial<DirectIngressDepsSource> = {}): DirectIngressDepsSource {
  return {
    db: {} as never,
    config: { mode: OrchestratorMode.enum.independent },
    dedup: {} as never,
    providerRegistry: { name: 'registry-a' } as never,
    lockFileCache: {} as never,
    dispatcher: {} as never,
    ...partial,
  } as DirectIngressDepsSource;
}

describe('createDirectIngressProcessingDeps', () => {
  it('hands the pipeline a trust-policy store, so the fork switch can read a stored row', () => {
    // Without this the switch resolves `stored = null` on every delivery and
    // applies the fail-closed `ignore` — the org's own choice unreachable.
    const { build } = createDirectIngressProcessingDeps(sourceWith(), NOOP_HOOKS);
    expect(build().trustPolicyStore).toBeInstanceOf(TrustPolicyStore);
  });

  it('hands the pipeline a trust-directory store, so `/kici approve` can resolve a commenter', () => {
    const { build } = createDirectIngressProcessingDeps(sourceWith(), NOOP_HOOKS);
    expect(build().trustDirectoryStore).toBeInstanceOf(TrustDirectoryStore);
  });

  it('supplies no in-memory directory, so the store is what gets read', () => {
    // `resolveApprovalDirectory` prefers an in-memory directory outright. If
    // this bag ever grew either field, the store read would stop happening and
    // an independent orchestrator would refuse every commenter forever.
    const bag = createDirectIngressProcessingDeps(sourceWith(), NOOP_HOOKS).build();
    expect(bag.identityLinks).toBeUndefined();
    expect(bag.orgMemberPermissions).toBeUndefined();
  });

  it.each(OrchestratorMode.options)('reports the configured mode verbatim (%s)', (mode) => {
    const { build } = createDirectIngressProcessingDeps(
      sourceWith({ config: { mode } }),
      NOOP_HOOKS,
    );
    expect(build().orchestratorMode).toBe(mode);
  });

  it('passes the held-run store through when the mode hook supplied one', () => {
    const heldRunStore = { marker: 'held' } as never;
    const { build } = createDirectIngressProcessingDeps(sourceWith({ heldRunStore }), NOOP_HOOKS);
    expect(build().heldRunStore).toBe(heldRunStore);
  });

  it('leaves the held-run store undefined when the mode hook supplied none', () => {
    // The degraded shape, asserted so its absence stays a deliberate state
    // rather than an accident: every hold site guards on this field.
    expect(
      createDirectIngressProcessingDeps(sourceWith(), NOOP_HOOKS).build().heldRunStore,
    ).toBeUndefined();
  });

  it('reassembles per call, so a swapped provider registry is picked up', () => {
    // The registry is replaced wholesale on a source reload. A bag captured
    // once would keep dispatching through the replaced one.
    const src = sourceWith();
    const { build } = createDirectIngressProcessingDeps(src, NOOP_HOOKS);
    expect((build().providerRegistry as unknown as { name: string }).name).toBe('registry-a');
    src.providerRegistry = { name: 'registry-b' } as never;
    expect((build().providerRegistry as unknown as { name: string }).name).toBe('registry-b');
  });

  it('constructs each store once for the process, not once per delivery', () => {
    const { build } = createDirectIngressProcessingDeps(sourceWith(), NOOP_HOOKS);
    const first = build();
    const second = build();
    expect(second.trustPolicyStore).toBe(first.trustPolicyStore);
    expect(second.trustDirectoryStore).toBe(first.trustDirectoryStore);
  });

  it('marks every delivery on this bag as direct, never relayed', () => {
    expect(createDirectIngressProcessingDeps(sourceWith(), NOOP_HOOKS).build().eventLogSource).toBe(
      'direct',
    );
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the assembled bag against a real stored policy.
// ---------------------------------------------------------------------------

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_directingress_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/** The one field `evaluateSecurityPolicy` reads off the bundle. */
const FORK_MODEL_BUNDLE = { hasForkModel: true } as unknown as ProviderBundle;

describeDb('the fork switch, driven through the assembled direct-ingress bag', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

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
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  beforeEach(async () => {
    await sql`DELETE FROM org_trust_policy`.execute(db);
  });

  const evaluate = (mode: OrchestratorMode) =>
    evaluateSecurityPolicy({
      deps: createDirectIngressProcessingDeps(
        sourceWith({ db: db as never, config: { mode } }),
        NOOP_HOOKS,
      ).build(),
      bundle: FORK_MODEL_BUNDLE,
      isPREvent: true,
      resolvedOrgId: 'org-1',
      mode,
      trustResolution: undefined,
      isForkPR: true,
    });

  it('drops a fork PR for an org that has chosen nothing', async () => {
    // The fail-closed default, unchanged: no row means no operator opted in,
    // and adding the store must not flip such a deployment to running forks.
    expect(await evaluate(OrchestratorMode.enum.independent)).toEqual({ action: 'ignore' });
  });

  it('HOLDS a fork PR once the operator stored `hold`', async () => {
    // This is the behaviour change. Before the store reached this bag the same
    // call answered `ignore` here too, so `kici-admin trust-policy set
    // --fork-policy hold` had no effect on the direct-ingress pipeline.
    await new TrustPolicyStore(db).upsertLocal('org-1', { forkPolicy: ForkPolicy.enum.hold });
    const outcome = await evaluate(OrchestratorMode.enum.independent);
    expect(outcome).toMatchObject({
      action: 'hold',
      reason: SecurityHoldReason.enum.fork_pr,
    });
  });

  it('RUNS a fork PR once the operator stored `allow`', async () => {
    await new TrustPolicyStore(db).upsertLocal('org-1', { forkPolicy: ForkPolicy.enum.allow });
    expect(await evaluate(OrchestratorMode.enum.independent)).toEqual({ action: 'pass' });
  });

  it('reads the same stored row in every mode, so no mode is quietly exempt', async () => {
    // The direct GitHub ingress is served in hybrid and observed as well as
    // independent, and all three were dropping fork PRs regardless of policy.
    await new TrustPolicyStore(db).upsertLocal('org-1', { forkPolicy: ForkPolicy.enum.hold });
    for (const mode of OrchestratorMode.options) {
      expect(await evaluate(mode)).toMatchObject({ action: 'hold' });
    }
  });
});
