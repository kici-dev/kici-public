import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ScalerBackendType } from '@kici-dev/engine';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import pg from 'pg';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { ScalerStateStore, type SpawningAgentSnapshot } from './scaler-state-store.js';

/**
 * Real-Postgres correctness tests for the two scaler-state properties that only
 * a live database can decide.
 *
 * `withScalerCapLock` is an advisory-locked transaction and `redeemClaim` is a
 * conditional UPDATE; a mock records the predicates without evaluating them, so
 * neither the mutual exclusion nor the single-use guarantee is observable
 * without a real server. Both are load-bearing: the first is what makes an
 * event scaler's `maxAgents` a cluster-wide number rather than a per-instance
 * one, and the second is what stops two coordinators minting credentials from
 * one claim code.
 *
 * Gated on KICI_TEST_ADMIN_DATABASE_URL; the shared vitest globalSetup
 * (scripts/db-test-postgres.ts) supplies it by starting a throwaway container.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_scaler_cap_test_${process.pid}_${Date.now()}`;

const SCALER = 'github-actions';
const OTHER_SCALER = 'aws-fleet';

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describeDb('ScalerStateStore — cluster-wide cap and single-use claims (real Postgres)', () => {
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let store: ScalerStateStore;
  const adminUrl = ADMIN_URL!;

  const snapshot = (
    agentId: string,
    overrides: Partial<SpawningAgentSnapshot> = {},
  ): SpawningAgentSnapshot => ({
    agentId,
    scalerName: SCALER,
    labelSet: [SCALER],
    spawnedAt: new Date(),
    ownerInstanceId: 'orch-a',
    backendType: ScalerBackendType.enum.event,
    ...overrides,
  });

  const rowCount = async (): Promise<number> =>
    (await db.selectFrom('scaler_spawning_agents').selectAll().execute()).length;

  /**
   * Claim a slot against a cap of `maxAgents`, the way the manager does.
   * Returns whether the slot was admitted.
   */
  const claim = (agentId: string, maxAgents: number, scalerName = SCALER): Promise<boolean> =>
    store.withScalerCapLock(scalerName, async (slot) => {
      if (slot.clusterActiveCount >= maxAgents) return false;
      await slot.reserve(snapshot(agentId, { scalerName }));
      return true;
    });

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    // At least three connections: every test here runs two overlapping
    // transactions, and one of them deliberately blocks on the other.
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB), max: 5 });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
    store = new ScalerStateStore(db);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [TEST_DB],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  afterEach(async () => {
    await sql`TRUNCATE TABLE scaler_spawning_agents, scaler_pending_claims`.execute(db);
  });

  describe('withScalerCapLock', () => {
    it('serializes two concurrent sections on the same scaler', async () => {
      const order: string[] = [];

      await Promise.all([
        store.withScalerCapLock(SCALER, async () => {
          order.push('a-in');
          // Long enough that an unlocked second section would certainly
          // interleave here: without the advisory lock the order is
          // a-in,b-in,b-out,a-out.
          await delay(50);
          order.push('a-out');
        }),
        store.withScalerCapLock(SCALER, async () => {
          order.push('b-in');
          order.push('b-out');
        }),
      ]);

      expect(order.join(',')).toMatch(/^(a-in,a-out,b-in,b-out|b-in,b-out,a-in,a-out)$/);
    });

    it('admits exactly one of two concurrent claims against a one-slot cap', async () => {
      // The defect, stated deterministically. `a` holds the lock and does not
      // release it until told to, so `b` provably starts while the count `a`
      // read is still uncommitted — the exact window in which a count-only
      // check admits both.
      let aEntered!: () => void;
      let releaseA!: () => void;
      const aIsInside = new Promise<void>((resolve) => {
        aEntered = resolve;
      });
      const aMayFinish = new Promise<void>((resolve) => {
        releaseA = resolve;
      });

      const a = store.withScalerCapLock(SCALER, async (slot) => {
        aEntered();
        await aMayFinish;
        if (slot.clusterActiveCount >= 1) return false;
        await slot.reserve(snapshot('agent-a'));
        return true;
      });
      await aIsInside;

      const b = claim('agent-b', 1);
      // `b` cannot have got past the lock: proving it is still blocked is what
      // makes the assertions below evidence of mutual exclusion rather than of
      // two sections that happened to run in sequence.
      const raced = await Promise.race([
        b.then(() => 'b-settled'),
        delay(200).then(() => 'blocked'),
      ]);
      expect(raced).toBe('blocked');

      releaseA();
      expect(await a).toBe(true);
      expect(await b).toBe(false);
      expect(await rowCount()).toBe(1);
    });

    it("counts only this scaler's event rows", async () => {
      // A container row for the same scaler name, and an event row for another
      // scaler: neither is a cloud instance this cap governs.
      await store.upsertSpawningAgent(
        snapshot('agent-local', { backendType: ScalerBackendType.enum.container }),
      );
      await store.upsertSpawningAgent(snapshot('agent-other', { scalerName: OTHER_SCALER }));

      const counted = await store.withScalerCapLock(SCALER, (slot) => slot.clusterActiveCount);

      expect(counted).toBe(0);
      // And a matching row does count, so the zero above is a predicate result
      // rather than a query that matches nothing.
      await store.upsertSpawningAgent(snapshot('agent-event'));
      expect(await store.withScalerCapLock(SCALER, (slot) => slot.clusterActiveCount)).toBe(1);
    });

    it('does not block a different scaler', async () => {
      // The lock key carries the scaler name, so one busy scaler must not stall
      // every other scaler's cap check on the whole cluster.
      let aEntered!: () => void;
      let releaseA!: () => void;
      const aIsInside = new Promise<void>((resolve) => {
        aEntered = resolve;
      });
      const aMayFinish = new Promise<void>((resolve) => {
        releaseA = resolve;
      });

      const a = store.withScalerCapLock(SCALER, async () => {
        aEntered();
        await aMayFinish;
      });
      await aIsInside;

      const other = claim('agent-other', 10, OTHER_SCALER);
      const raced = await Promise.race([
        other.then(() => 'other-settled'),
        delay(200).then(() => 'blocked'),
      ]);

      expect(raced).toBe('other-settled');
      releaseA();
      await a;
      expect(await other).toBe(true);
    });

    // Both snapshot isolation levels, because they fail differently and the
    // quieter one is the more dangerous. Under `repeatable read` an unpinned
    // transaction simply over-admits, silently; under `serializable` it may
    // also raise 40001 on commit, which at least announces itself.
    it.each([
      // libpq splits `options` on whitespace, so the space inside the value has
      // to be backslash-escaped or the server sees `repeatable` on its own.
      ['repeatable read', '-c default_transaction_isolation=repeatable\\ read'],
      ['serializable', '-c default_transaction_isolation=serializable'],
    ])('still caps when the server default is %s', async (level, options) => {
      // The lock is taken first and the count read second, so the second holder
      // only sees the first one's row because each statement takes its own
      // snapshot. Under a snapshot isolation level the snapshot is taken at the
      // FIRST statement — before the lock is granted — so both coordinators
      // read the same pre-claim count and both admit: the exact defect this
      // whole file exists to close, reintroduced by a server-side
      // `default_transaction_isolation` change nobody here would see. This
      // connects with that bad default deliberately set and re-runs the
      // one-slot race over it.
      const skewedPool = new pg.Pool({
        connectionString: withDatabase(adminUrl, TEST_DB),
        options,
        max: 4,
      });
      const skewedDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: skewedPool }) });
      try {
        // The control: an ordinary transaction on this pool really does inherit
        // the bad default, so a pass below is about the pin and not about a
        // server that was READ COMMITTED all along.
        const inherited = await skewedDb
          .transaction()
          .execute(async (trx) =>
            sql<{ v: string }>`SELECT current_setting('transaction_isolation') AS v`.execute(trx),
          );
        expect(inherited.rows[0]?.v).toBe(level);

        const skewedStore = new ScalerStateStore(skewedDb);
        let aEntered!: () => void;
        let releaseA!: () => void;
        const aIsInside = new Promise<void>((resolve) => {
          aEntered = resolve;
        });
        const aMayFinish = new Promise<void>((resolve) => {
          releaseA = resolve;
        });

        const a = skewedStore.withScalerCapLock(SCALER, async (slot) => {
          aEntered();
          await aMayFinish;
          if (slot.clusterActiveCount >= 1) return false;
          await slot.reserve(snapshot('agent-a'));
          return true;
        });
        await aIsInside;
        const b = skewedStore.withScalerCapLock(SCALER, async (slot) => {
          if (slot.clusterActiveCount >= 1) return false;
          await slot.reserve(snapshot('agent-b'));
          return true;
        });
        // `b` must be provably inside its own transaction and blocked on the
        // lock before `a` commits. Released early, `b` would begin afterwards
        // and read the committed row under any isolation level — passing for a
        // reason that has nothing to do with the pin.
        expect(
          await Promise.race([b.then(() => 'b-settled'), delay(200).then(() => 'blocked')]),
        ).toBe('blocked');
        releaseA();

        expect(await a).toBe(true);
        expect(await b).toBe(false);
        expect(await rowCount()).toBe(1);
      } finally {
        await skewedDb.destroy();
        await skewedPool.end().catch(() => {});
      }
    });

    it('gives up on the lock rather than queuing past its wait budget', async () => {
      // The manager holds its process-wide reservation lock across this call,
      // so an unbounded wait behind a peer stalls every other backend's scale
      // request too. A store carrying a wait budget fails instead.
      const bounded = new ScalerStateStore(db, 100);
      let aEntered!: () => void;
      let releaseA!: () => void;
      const aIsInside = new Promise<void>((resolve) => {
        aEntered = resolve;
      });
      const aMayFinish = new Promise<void>((resolve) => {
        releaseA = resolve;
      });

      const a = store.withScalerCapLock(SCALER, async () => {
        aEntered();
        await aMayFinish;
      });
      await aIsInside;

      // 55P03 lock_not_available — the wait budget expired, not a crash.
      await expect(bounded.withScalerCapLock(SCALER, () => true)).rejects.toMatchObject({
        code: '55P03',
      });

      releaseA();
      await a;
      // And the budget is not a permanent refusal: with the lock free it takes it.
      expect(await bounded.withScalerCapLock(SCALER, () => 'acquired')).toBe('acquired');
    });

    it('claims nothing when the section throws', async () => {
      // The advisory lock is transaction-scoped and the claim rides the same
      // transaction, so a rollback releases the lock and drops the row together
      // — there is no unlock path that can leak.
      await expect(
        store.withScalerCapLock(SCALER, async (slot) => {
          await slot.reserve(snapshot('agent-doomed'));
          throw new Error('provisioning refused');
        }),
      ).rejects.toThrow('provisioning refused');

      expect(await rowCount()).toBe(0);
      // The lock really was released: a fresh section acquires it immediately.
      expect(await claim('agent-next', 1)).toBe(true);
    });
  });

  describe('adoptSpawningAgent', () => {
    // The mutual exclusion here rests on READ COMMITTED re-evaluating the
    // predicate against the updated row (EvalPlanQual) — exactly what a mock
    // cannot demonstrate, since it records the `where` callbacks without ever
    // invoking them. A double adoption means two coordinators each emitting a
    // teardown for one provision.
    it('admits exactly one of two concurrent adopters', async () => {
      await store.upsertSpawningAgent(snapshot('agent-race'));

      const [a, b] = await Promise.all([
        store.adoptSpawningAgent('agent-race', 'orch-a'),
        store.adoptSpawningAgent('agent-race', 'orch-b'),
      ]);

      const winners = [a, b].filter((row) => row !== null);
      expect(winners).toHaveLength(1);
      const row = await db
        .selectFrom('scaler_spawning_agents')
        .select(['adopted_by'])
        .where('agent_id', '=', 'agent-race')
        .executeTakeFirstOrThrow();
      expect(row.adopted_by).toBe(winners[0]!.adoptedBy);
    });

    it('re-adopts a row this same instance already holds', async () => {
      // Without this arm a restart is a silent leak: recovery rehydrates the
      // row, the prune drops the in-memory entry, and the still-live agent's
      // next registration finds neither — so it reads as static and no
      // `scale-down` is ever emitted.
      await store.upsertSpawningAgent(snapshot('agent-self'));

      expect(await store.adoptSpawningAgent('agent-self', 'orch-a')).not.toBeNull();
      expect(await store.adoptSpawningAgent('agent-self', 'orch-a')).not.toBeNull();
      // …and a different instance is still refused.
      expect(await store.adoptSpawningAgent('agent-self', 'orch-b')).toBeNull();
    });

    it('refuses a row belonging to a local backend', async () => {
      // A container agent's compute is pinned to another host, so adopting its
      // bookkeeping would be a lie — and would emit a `scale-down` for a
      // backend that consumes none.
      await store.upsertSpawningAgent(
        snapshot('agent-container', { backendType: ScalerBackendType.enum.container }),
      );

      expect(await store.adoptSpawningAgent('agent-container', 'orch-a')).toBeNull();
    });

    it('refuses a row whose backend type was never stamped', async () => {
      // A pre-migration row. `backend_type` is what every adoption and reap
      // predicate matches on, so such a row is adoptable by nobody — including
      // the instance that wrote it.
      await db
        .insertInto('scaler_spawning_agents')
        .values({
          agent_id: 'agent-legacy',
          scaler_name: SCALER,
          label_set: JSON.stringify([SCALER]),
          spawned_at: new Date(),
          owner_instance_id: 'orch-a',
        })
        .execute();

      expect(await store.adoptSpawningAgent('agent-legacy', 'orch-a')).toBeNull();
    });
  });

  describe('listReapCandidates', () => {
    // Both arms of the `OR` are expression-builder callbacks the mock db records
    // without invoking, and the reaper suite injects candidates directly — so
    // deleting either arm leaves every test green while the matching production
    // path becomes unreachable.
    it('returns adopted rows of any age and unadopted rows past the cutoff only', async () => {
      // `spawned_at` is the column default, never written by the upsert, so the
      // aged rows are backdated here rather than through the snapshot.
      const backdate = async (agentId: string): Promise<void> => {
        await db
          .updateTable('scaler_spawning_agents')
          .set({ spawned_at: new Date(Date.now() - 600_000) })
          .where('agent_id', '=', agentId)
          .execute();
      };

      await store.upsertSpawningAgent(snapshot('fresh-adopted'));
      await store.adoptSpawningAgent('fresh-adopted', 'orch-b');
      await store.upsertSpawningAgent(snapshot('fresh-unadopted'));
      await store.upsertSpawningAgent(snapshot('aged-unadopted'));
      await backdate('aged-unadopted');
      await store.upsertSpawningAgent(
        snapshot('aged-container', { backendType: ScalerBackendType.enum.container }),
      );
      await backdate('aged-container');

      const candidates = await store.listReapCandidates(new Date(Date.now() - 300_000));

      expect(candidates.map((c) => c.agentId).sort()).toEqual(['aged-unadopted', 'fresh-adopted']);
      // The adopted row carries its adopter through, which is what picks the
      // reaper's `heartbeat-timeout` arm over the `spawn-timeout` one.
      expect(candidates.find((c) => c.agentId === 'fresh-adopted')?.adoptedBy).toBe('orch-b');
      expect(candidates.find((c) => c.agentId === 'aged-unadopted')?.adoptedBy).toBeUndefined();
    });
  });

  describe('deleteUnadoptedSpawningAgent', () => {
    it('deletes an unclaimed row and spares one an instance adopted', async () => {
      await store.upsertSpawningAgent(snapshot('agent-unclaimed'));
      await store.upsertSpawningAgent(snapshot('agent-claimed'));
      await store.adoptSpawningAgent('agent-claimed', 'orch-b');

      await store.deleteUnadoptedSpawningAgent('agent-unclaimed');
      await store.deleteUnadoptedSpawningAgent('agent-claimed');

      const remaining = await db
        .selectFrom('scaler_spawning_agents')
        .select(['agent_id'])
        .execute();
      expect(remaining.map((r) => r.agent_id)).toEqual(['agent-claimed']);
    });
  });

  describe('redeemClaim', () => {
    const CLAIM_HASH = 'a'.repeat(64);

    const registerOne = async (): Promise<void> => {
      await store.registerClaim({
        claimHash: CLAIM_HASH,
        claimPrefix: 'kcc_abcd',
        agentId: 'agent-1',
        scalerName: SCALER,
        labels: [SCALER, 'kici:os:linux'],
        agentTokenTtlMs: 900_000,
        orchestratorUrl: 'https://orch.example/ws',
        expiresAt: new Date(Date.now() + 60_000),
      });
    };

    it('mints exactly once when several coordinators redeem the same code at once', async () => {
      await registerOne();

      const results = await Promise.all([
        store.redeemClaim(CLAIM_HASH),
        store.redeemClaim(CLAIM_HASH),
        store.redeemClaim(CLAIM_HASH),
        store.redeemClaim(CLAIM_HASH),
      ]);

      const winners = results.filter((result) => result !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]).toEqual({
        agentId: 'agent-1',
        labels: [SCALER, 'kici:os:linux'],
        // BIGINT arrives as a string from the driver; the store coerces it, and
        // a mock that hands back a number would never exercise that.
        agentTokenTtlMs: 900_000,
        orchestratorUrl: 'https://orch.example/ws',
      });
      expect(results.filter((result) => result === null)).toHaveLength(3);

      // The loser's reason is "already consumed", not "unknown code".
      expect(await store.describeClaim(CLAIM_HASH)).toEqual({ consumed: true, expired: false });
    });

    it('refuses an expired code even though it was never consumed', async () => {
      await store.registerClaim({
        claimHash: CLAIM_HASH,
        claimPrefix: 'kcc_abcd',
        agentId: 'agent-1',
        scalerName: SCALER,
        labels: [SCALER],
        agentTokenTtlMs: 900_000,
        orchestratorUrl: 'https://orch.example/ws',
        expiresAt: new Date(Date.now() - 1_000),
      });

      expect(await store.redeemClaim(CLAIM_HASH)).toBeNull();
      expect(await store.describeClaim(CLAIM_HASH)).toEqual({ consumed: false, expired: true });
    });
  });
});
