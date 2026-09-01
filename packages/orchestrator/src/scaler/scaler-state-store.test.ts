import { ScalerBackendType } from '@kici-dev/engine';
import { describe, it, expect } from 'vitest';

import { ScalerStateStore } from './scaler-state-store.js';
import { createMockDb, type MockDb } from '../__test-helpers__/mock-db.js';

/** One `eb(column, op, value)` comparison, as the stub builder below records it. */
interface RenderedComparison {
  column: string;
  op: string;
  value: unknown;
}

/**
 * Run the expression-builder callback an `updateTable().where(...)` was given
 * and return the predicate it builds.
 *
 * The mock db records the callback but never invokes it, so a `where` written
 * as `(eb) => eb.or([...])` is invisible to a `toHaveBeenCalledWith` assertion —
 * a test that only asserted the flat `where` arms would pass no matter what the
 * callback contains. Returns `null` when no callback arm was added at all.
 */
function renderUpdatePredicate(
  mocks: MockDb['mocks'],
): { or: RenderedComparison[] } | RenderedComparison | null {
  const callback = mocks.updateWhere.mock.calls
    .map((call) => call[0])
    .find((arg): arg is (eb: unknown) => unknown => typeof arg === 'function');
  if (!callback) return null;
  const eb = Object.assign(
    (column: string, op: string, value: unknown): RenderedComparison => ({ column, op, value }),
    { or: (parts: RenderedComparison[]) => ({ or: parts }) },
  );
  return callback(eb) as { or: RenderedComparison[] } | RenderedComparison;
}

/** The correlated subquery arm of a rendered `NOT EXISTS`, as recorded below. */
interface RenderedSubquery {
  from: string;
  refs?: [string, string, string];
}

/**
 * Run the expression-builder callback a `deleteFrom().where(...)` was given and
 * return the predicate it builds, whatever shape it has.
 *
 * Same blind spot as `renderUpdatePredicate`, with a sharper consequence: the
 * mock never invokes the callback, so asserting only that one was passed holds
 * just as well for `exists` as for `not exists` — and that inversion is the
 * difference between a purge that spares live rows and one that deletes exactly
 * them. The return type stays `unknown` so the caller matches the whole shape
 * and reports the wrong one, rather than dereferencing a `not` arm a bare
 * `exists` does not have. Returns `null` when no callback arm was added at all.
 */
function renderDeletePredicate(mocks: MockDb['mocks']): unknown {
  const callback = mocks.deleteWhere.mock.calls
    .map((call) => call[0])
    .find((arg): arg is (eb: unknown) => unknown => typeof arg === 'function');
  if (!callback) return null;
  const eb = {
    not: (operand: unknown) => ({ not: operand }),
    exists: (operand: unknown) => ({ exists: operand }),
    selectFrom: (from: string) => {
      const sub: RenderedSubquery & {
        select: (column: string) => typeof sub;
        whereRef: (left: string, op: string, right: string) => typeof sub;
      } = {
        from,
        // The SELECT list of an EXISTS is semantically inert, so it is accepted
        // for chaining and deliberately not recorded — pinning it would fail
        // the test on a rewrite that changes nothing.
        select: () => sub,
        whereRef: (left: string, op: string, right: string) => {
          sub.refs = [left, op, right];
          return sub;
        },
      };
      return sub;
    },
  };
  return callback(eb);
}

/**
 * Render a raw SQL fragment an `onConflict` payload carries.
 *
 * A `sql` template is a builder object, so a plain string coercion yields
 * `[object Object]` and an assertion on it passes for any fragment at all.
 */
function rawSql(value: unknown): string {
  const node = (
    value as { toOperationNode?: () => { sqlFragments?: readonly string[] } }
  ).toOperationNode?.();
  return node?.sqlFragments?.join('?') ?? '';
}

describe('ScalerStateStore', () => {
  describe('spawning agents', () => {
    it('upserts a spawning-agent row via insertInto + onConflict', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.upsertSpawningAgent({
        agentId: 'agent-001',
        scalerName: 'container',
        labelSet: ['kici:os:linux', 'kici:arch:x64'],
        boundJobId: 'job-001',
        spawnedAt: new Date(),
      });

      expect(mocks.insertInto).toHaveBeenCalledWith('scaler_spawning_agents');
      expect(mocks.onConflict).toHaveBeenCalled();
    });

    it('lists spawning agents with parsed labelSet (array form)', async () => {
      const spawnedAt = new Date('2026-05-18T10:00:00Z');
      const { db } = createMockDb({
        selectRows: [
          {
            agent_id: 'agent-001',
            scaler_name: 'container',
            label_set: ['kici:os:linux'],
            run_id: null,
            job_id: null,
            bound_job_id: 'job-001',
            spawned_at: spawnedAt,
          },
        ],
      });
      const store = new ScalerStateStore(db);

      const rows = await store.listSpawningAgents();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        agentId: 'agent-001',
        scalerName: 'container',
        labelSet: ['kici:os:linux'],
        boundJobId: 'job-001',
        spawnedAt,
      });
    });

    it('lists spawning agents with parsed labelSet (JSON-string form)', async () => {
      const spawnedAt = new Date('2026-05-18T10:00:00Z');
      const { db } = createMockDb({
        selectRows: [
          {
            agent_id: 'agent-002',
            scaler_name: 'container',
            label_set: '["kici:os:linux"]',
            run_id: 'run-001',
            job_id: 'job-002',
            bound_job_id: null,
            spawned_at: spawnedAt,
          },
        ],
      });
      const store = new ScalerStateStore(db);

      const rows = await store.listSpawningAgents();

      expect(rows[0]?.labelSet).toEqual(['kici:os:linux']);
      expect(rows[0]?.runId).toBe('run-001');
      expect(rows[0]?.jobId).toBe('job-002');
      expect(rows[0]?.boundJobId).toBeUndefined();
    });

    it('deletes a spawning agent by agent_id', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.deleteSpawningAgent('agent-001');

      expect(mocks.deleteFrom).toHaveBeenCalledWith('scaler_spawning_agents');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('agent_id', '=', 'agent-001');
      // Unconditional by design — this is the "the agent registered here" path,
      // where the row is genuinely finished.
      expect(mocks.deleteWhere).not.toHaveBeenCalledWith('adopted_by', 'is', null);
    });

    it('deletes a spawning agent only while it is unadopted', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.deleteUnadoptedSpawningAgent('agent-001');

      expect(mocks.deleteFrom).toHaveBeenCalledWith('scaler_spawning_agents');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('agent_id', '=', 'agent-001');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('adopted_by', 'is', null);
    });

    it('reads the adopter of one live spawning row', async () => {
      const { db, mocks } = createMockDb({ selectFirstRow: { adopted_by: 'orch-b' } });
      const store = new ScalerStateStore(db);

      expect(await store.provisionAdopter('agent-001')).toBe('orch-b');
      expect(mocks.selectFrom).toHaveBeenCalledWith('scaler_spawning_agents');
      expect(mocks.select).toHaveBeenCalledWith('adopted_by');
      expect(mocks.selectWhere).toHaveBeenCalledWith('agent_id', '=', 'agent-001');
      // The live row answered, so the durable table is never read.
      expect(mocks.selectFrom).not.toHaveBeenCalledWith('scaler_provision_outcomes');
    });

    it('reports an unadopted row and a missing row alike as null', async () => {
      // The caller acts on "nobody adopted this", and neither answer is one.
      const unadopted = new ScalerStateStore(
        createMockDb({ selectFirstRow: { adopted_by: null } }).db,
      );
      const missing = new ScalerStateStore(createMockDb().db);

      expect(await unadopted.provisionAdopter('agent-001')).toBeNull();
      expect(await missing.provisionAdopter('agent-001')).toBeNull();
    });
  });

  describe('provision outcomes', () => {
    it('writes the adoption outcome in the same transaction as the adopted_by stamp', async () => {
      const { db, mocks } = createMockDb({
        updatedRow: {
          agent_id: 'agent-001',
          scaler_name: 'github-actions',
          label_set: [],
          spawned_at: new Date('2026-08-29T10:00:00Z'),
          adopted_by: 'orch-b',
          backend_type: ScalerBackendType.enum.event,
        },
      });
      const store = new ScalerStateStore(db);

      const snapshot = await store.adoptSpawningAgent('agent-001', 'orch-b');

      expect(snapshot?.agentId).toBe('agent-001');
      // The stamp and the outcome must not be separable: a crash between them
      // would leave an adopted row whose adoption the prune cannot see.
      expect(mocks.transaction).toHaveBeenCalled();
      expect(mocks.insertInto).toHaveBeenCalledWith('scaler_provision_outcomes');
      const values = mocks.insertValues.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(values.agent_id).toBe('agent-001');
      expect(values.scaler_name).toBe('github-actions');
      expect(values.adopted_by).toBe('orch-b');
    });

    it('writes no outcome when the conditional adopt matched no row', async () => {
      const { db, mocks } = createMockDb({ updatedRow: undefined });
      const store = new ScalerStateStore(db);

      expect(await store.adoptSpawningAgent('agent-001', 'orch-b')).toBeNull();
      // Another instance already owns the provision; recording OUR adoption
      // would name the wrong coordinator on the durable record.
      expect(mocks.insertInto).not.toHaveBeenCalledWith('scaler_provision_outcomes');
    });

    it('keeps the first adopter when the same instance re-adopts', async () => {
      const { db, mocks } = createMockDb({
        updatedRow: {
          agent_id: 'agent-001',
          scaler_name: 'github-actions',
          label_set: [],
          spawned_at: new Date('2026-08-29T10:00:00Z'),
          adopted_by: 'orch-b',
          backend_type: ScalerBackendType.enum.event,
        },
      });
      await new ScalerStateStore(db).adoptSpawningAgent('agent-001', 'orch-b');

      // A restart re-adopts the same row, and `adopted_*` name who adopted the
      // provision FIRST and when — rewriting them there would make the durable
      // record name the wrong coordinator and the wrong moment.
      const updateSet = mocks.doUpdateSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(rawSql(updateSet.adopted_by)).toContain('COALESCE');
      expect(rawSql(updateSet.adopted_at)).toContain('COALESCE');
    });

    it('records a condemnation without touching the adoption columns', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.recordProvisionCondemned('agent-001', 'github-actions', 'heartbeat-timeout');

      expect(mocks.insertInto).toHaveBeenCalledWith('scaler_provision_outcomes');
      // The load-bearing assertion: a `heartbeat-timeout` condemns a provision
      // that WAS adopted, so an update clearing `adopted_by` here would put the
      // prune straight back to reporting it as a failed provision.
      const updateSet = mocks.doUpdateSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(Object.keys(updateSet)).not.toContain('adopted_by');
      expect(Object.keys(updateSet)).not.toContain('adopted_at');
      expect(updateSet.condemned_reason).toBe('heartbeat-timeout');
    });

    it('answers the adopter from the outcome row when the spawn row is gone', async () => {
      const { db, mocks } = createMockDb();
      // The spawn row is gone — the ambiguity the durable record resolves — so
      // the first read answers nothing and the second one has to.
      mocks.selectExecuteTakeFirst
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ adopted_by: 'orch-c' });
      const store = new ScalerStateStore(db);

      expect(await store.provisionAdopter('agent-001')).toBe('orch-c');
      expect(mocks.selectFrom).toHaveBeenCalledWith('scaler_provision_outcomes');
    });

    it('answers null when neither the spawn row nor an outcome names an adopter', async () => {
      const { db, mocks } = createMockDb();
      mocks.selectExecuteTakeFirst
        .mockResolvedValueOnce({ adopted_by: null })
        .mockResolvedValueOnce({ adopted_by: null });

      expect(await new ScalerStateStore(db).provisionAdopter('agent-001')).toBeNull();
    });

    it('purges only outcomes past the cutoff whose spawn row is gone', async () => {
      const { db, mocks } = createMockDb({ deleteResult: { numDeletedRows: 3n } });
      const store = new ScalerStateStore(db);
      const cutoff = new Date('2026-08-01T00:00:00Z');

      expect(await store.purgeProvisionOutcomes(cutoff)).toBe(3);
      expect(mocks.deleteFrom).toHaveBeenCalledWith('scaler_provision_outcomes');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('updated_at', '<', cutoff);
      // The second predicate is the load-bearing one: an outcome whose spawn row
      // still exists can still be asked about, however old it is. It is an
      // expression-builder arm, so a flat `toHaveBeenCalledWith` cannot see it —
      // render it and assert the negation, the table and the correlation, since
      // a bare `exists` would delete precisely the rows this guard must spare.
      expect(
        renderDeletePredicate(mocks),
        'the spawn-row existence guard is missing, or is not a NOT EXISTS',
      ).toMatchObject({
        not: {
          exists: {
            from: 'scaler_spawning_agents',
            refs: ['scaler_spawning_agents.agent_id', '=', 'scaler_provision_outcomes.agent_id'],
          },
        },
      });
    });
  });

  describe('agent-job correlation', () => {
    it('upserts via insertInto + onConflict', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.upsertAgentJob({ agentId: 'agent-001', runId: 'run-1', jobId: 'job-1' });

      expect(mocks.insertInto).toHaveBeenCalledWith('scaler_agent_jobs');
      expect(mocks.onConflict).toHaveBeenCalled();
    });

    it('lists agent-job correlations', async () => {
      const { db } = createMockDb({
        selectRows: [{ agent_id: 'agent-001', run_id: 'run-1', job_id: 'job-1' }],
      });
      const store = new ScalerStateStore(db);

      const rows = await store.listAgentJobs();

      expect(rows).toEqual([{ agentId: 'agent-001', runId: 'run-1', jobId: 'job-1' }]);
    });

    it('deletes by agent_id', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.deleteAgentJob('agent-001');

      expect(mocks.deleteFrom).toHaveBeenCalledWith('scaler_agent_jobs');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('agent_id', '=', 'agent-001');
    });
  });

  describe('reservations', () => {
    it('upserts a reservation row via insertInto + onConflict', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.upsertReservation({
        agentId: 'agent-001',
        scalerName: 'container',
        cpus: 2,
        memBytes: 4_294_967_296,
      });

      expect(mocks.insertInto).toHaveBeenCalledWith('scaler_reservations');
      expect(mocks.onConflict).toHaveBeenCalled();
    });

    it('lists reservations with BIGINT coercion', async () => {
      const { db } = createMockDb({
        selectRows: [
          {
            agent_id: 'agent-001',
            scaler_name: 'container',
            cpu_units: 2,
            mem_bytes: '4294967296',
          },
        ],
      });
      const store = new ScalerStateStore(db);

      const rows = await store.listReservations();

      expect(rows).toEqual([
        {
          agentId: 'agent-001',
          scalerName: 'container',
          cpus: 2,
          memBytes: 4_294_967_296,
        },
      ]);
    });

    it('passes numeric mem_bytes through unchanged when the driver returns a number', async () => {
      const { db } = createMockDb({
        selectRows: [
          { agent_id: 'agent-001', scaler_name: 'container', cpu_units: 1, mem_bytes: 1024 },
        ],
      });
      const store = new ScalerStateStore(db);

      const rows = await store.listReservations();

      expect(rows[0]?.memBytes).toBe(1024);
    });

    it('deletes a reservation by agent_id', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.deleteReservation('agent-001');

      expect(mocks.deleteFrom).toHaveBeenCalledWith('scaler_reservations');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('agent_id', '=', 'agent-001');
    });
  });

  describe('HA ownership', () => {
    it('redeems a claim with a conditional update and returns the spec', async () => {
      const { db, mocks } = createMockDb({
        updatedRow: {
          agent_id: 'agent-77',
          labels: ['github-actions'],
          agent_token_ttl_ms: 600000,
          orchestrator_url: 'wss://ci.example.com/ws',
        },
      });
      const store = new ScalerStateStore(db);

      const redeemed = await store.redeemClaim('hash-abc');

      expect(mocks.updateTable).toHaveBeenCalledWith('scaler_pending_claims');
      expect(redeemed).toEqual({
        agentId: 'agent-77',
        labels: ['github-actions'],
        agentTokenTtlMs: 600000,
        orchestratorUrl: 'wss://ci.example.com/ws',
      });
    });

    it('coerces the BIGINT agent_token_ttl_ms the driver returns as a string', async () => {
      const { db } = createMockDb({
        updatedRow: {
          agent_id: 'agent-77',
          labels: '["github-actions"]',
          agent_token_ttl_ms: '600000',
          orchestrator_url: 'wss://ci.example.com/ws',
        },
      });
      const store = new ScalerStateStore(db);

      const redeemed = await store.redeemClaim('hash-abc');

      expect(redeemed?.agentTokenTtlMs).toBe(600000);
      expect(redeemed?.labels).toEqual(['github-actions']);
    });

    it('returns null when the conditional claim update matches no row', async () => {
      const { db } = createMockDb({ updatedRow: undefined });
      const store = new ScalerStateStore(db);
      expect(await store.redeemClaim('hash-nope')).toBeNull();
    });

    it('consumes only an unconsumed, unexpired claim', async () => {
      const { db, mocks } = createMockDb({ updatedRow: undefined });
      const store = new ScalerStateStore(db);

      await store.redeemClaim('hash-abc');

      // The three predicates ARE the correctness argument: the UPDATE is the
      // consumption, so dropping any one of them lets a code be minted twice.
      expect(mocks.updateSet).toHaveBeenCalledWith({ consumed_at: expect.any(Date) });
      expect(mocks.updateWhere).toHaveBeenCalledWith('claim_hash', '=', 'hash-abc');
      expect(mocks.updateWhere).toHaveBeenCalledWith('consumed_at', 'is', null);
      expect(mocks.updateWhere).toHaveBeenCalledWith('expires_at', '>', expect.any(Date));
      expect(mocks.updateWhere).toHaveBeenCalledTimes(3);
    });

    it('registers a claim row against scaler_pending_claims', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.registerClaim({
        claimHash: 'hash-abc',
        claimPrefix: 'abcd',
        agentId: 'agent-77',
        scalerName: 'github-actions',
        labels: ['github-actions'],
        agentTokenTtlMs: 600000,
        orchestratorUrl: 'wss://ci.example.com/ws',
        expiresAt: new Date('2026-08-21T10:05:00Z'),
      });

      expect(mocks.insertInto).toHaveBeenCalledWith('scaler_pending_claims');
      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ claim_hash: 'hash-abc', consumed_at: null }),
      );
    });

    it('describes an unknown claim as null', async () => {
      const { db } = createMockDb({ selectFirstRow: undefined });
      const store = new ScalerStateStore(db);
      expect(await store.describeClaim('hash-nope')).toBeNull();
    });

    it('describes a consumed and expired claim', async () => {
      const { db } = createMockDb({
        selectFirstRow: {
          consumed_at: new Date('2026-08-21T10:00:00Z'),
          expires_at: new Date('2000-01-01T00:00:00Z'),
        },
      });
      const store = new ScalerStateStore(db);
      expect(await store.describeClaim('hash-abc')).toEqual({ consumed: true, expired: true });
    });

    it('invalidates every claim held by an agent', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.invalidateClaimsForAgent('agent-77');

      expect(mocks.deleteFrom).toHaveBeenCalledWith('scaler_pending_claims');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('agent_id', '=', 'agent-77');
    });

    it('purges claims that expired before the cutoff and reports the row count', async () => {
      const cutoff = new Date('2026-08-21T10:00:00Z');
      const { db, mocks } = createMockDb({ deleteResult: { numDeletedRows: 3n } });
      const store = new ScalerStateStore(db);

      const purged = await store.purgeExpiredClaims(cutoff);

      expect(mocks.deleteFrom).toHaveBeenCalledWith('scaler_pending_claims');
      expect(mocks.deleteWhere).toHaveBeenCalledWith('expires_at', '<', cutoff);
      // Consumed claims go too: the predicate is expiry alone, so nothing is
      // left behind by a claim that was redeemed and then expired.
      expect(mocks.deleteWhere).not.toHaveBeenCalledWith('consumed_at', 'is', null);
      // node-pg hands `numDeletedRows` back as a bigint, so the coercion is
      // load-bearing — a raw bigint fails every arithmetic comparison upstream.
      expect(purged).toBe(3);
    });

    it('adopts a spawning agent and returns its self-describing spec', async () => {
      const { db, mocks } = createMockDb({
        updatedRow: {
          agent_id: 'agent-77',
          scaler_name: 'github-actions',
          label_set: ['github-actions'],
          run_id: 'run-1',
          job_id: 'job-1',
          bound_job_id: 'job-1',
          spawned_at: new Date('2026-08-21T10:00:00Z'),
          owner_instance_id: 'orch-a',
          adopted_by: 'orch-b',
          adopted_at: new Date('2026-08-21T10:00:05Z'),
          mandatory_labels: ['kici:os:linux'],
          provisioning_targets: ['e2e/provision'],
          roles: ['build'],
          backend_type: 'event',
        },
      });
      const store = new ScalerStateStore(db);

      const adopted = await store.adoptSpawningAgent('agent-77', 'orch-b');

      expect(mocks.updateTable).toHaveBeenCalledWith('scaler_spawning_agents');
      expect(adopted?.boundJobId).toBe('job-1');
      expect(adopted?.mandatoryLabels).toEqual(['kici:os:linux']);
      expect(adopted?.provisioningTargets).toEqual(['e2e/provision']);
      expect(adopted?.backendType).toBe('event');
      expect(adopted?.ownerInstanceId).toBe('orch-a');
      expect(adopted?.adoptedBy).toBe('orch-b');
    });

    it('adopts only an event-backend row nobody else holds', async () => {
      const { db, mocks } = createMockDb({ updatedRow: undefined });
      const store = new ScalerStateStore(db);

      await store.adoptSpawningAgent('agent-77', 'orch-b');

      expect(mocks.updateSet).toHaveBeenCalledWith({
        adopted_by: 'orch-b',
        adopted_at: expect.any(Date),
      });
      expect(mocks.updateWhere).toHaveBeenCalledWith('agent_id', '=', 'agent-77');
      expect(mocks.updateWhere).toHaveBeenCalledWith(
        'backend_type',
        '=',
        ScalerBackendType.enum.event,
      );
      // The ownership arm is an expression-builder callback, so the flat
      // `toHaveBeenCalledWith` above cannot see it: run the callback and read
      // the predicate it builds. Both arms have to be there — the NULL arm
      // alone leaves an instance unable to re-adopt its own row after a restart
      // (silent leak), and the self arm alone would let anyone steal a peer's.
      expect(renderUpdatePredicate(mocks)).toEqual({
        or: [
          { column: 'adopted_by', op: 'is', value: null },
          { column: 'adopted_by', op: '=', value: 'orch-b' },
        ],
      });
    });

    it('returns null when another instance already adopted the agent', async () => {
      const { db } = createMockDb({ updatedRow: undefined });
      const store = new ScalerStateStore(db);
      expect(await store.adoptSpawningAgent('agent-77', 'orch-b')).toBeNull();
    });

    it('renders no predicate for an update built from flat where arms only', async () => {
      // The control for the assertion above: `renderUpdatePredicate` reports
      // `null` when nothing added an expression-builder arm, so the adopt test
      // genuinely fails on a flat `where('adopted_by', 'is', null)` rather than
      // passing on whatever the helper happens to return.
      const { db, mocks } = createMockDb({ updatedRow: undefined });
      await new ScalerStateStore(db).redeemClaim('hash-1');
      expect(mocks.updateWhere).toHaveBeenCalledWith('consumed_at', 'is', null);
      expect(renderUpdatePredicate(mocks)).toBeNull();
    });

    it('scopes spawning-agent recovery to the owning instance', async () => {
      const { db, mocks } = createMockDb({ selectRows: [] });
      const store = new ScalerStateStore(db);
      await store.listSpawningAgentsForOwner('orch-a');
      expect(mocks.selectFrom).toHaveBeenCalledWith('scaler_spawning_agents');
      expect(mocks.selectWhere).toHaveBeenCalledWith('owner_instance_id', '=', 'orch-a');
    });

    it('scopes reservation recovery to the owning instance', async () => {
      const { db, mocks } = createMockDb({
        selectRows: [
          {
            agent_id: 'agent-77',
            scaler_name: 'github-actions',
            cpu_units: 2,
            mem_bytes: '4294967296',
            owner_instance_id: 'orch-a',
          },
        ],
      });
      const store = new ScalerStateStore(db);

      const rows = await store.listReservationsForOwner('orch-a');

      expect(mocks.selectFrom).toHaveBeenCalledWith('scaler_reservations');
      expect(mocks.selectWhere).toHaveBeenCalledWith('owner_instance_id', '=', 'orch-a');
      expect(rows).toEqual([
        {
          agentId: 'agent-77',
          scalerName: 'github-actions',
          cpus: 2,
          memBytes: 4_294_967_296,
          ownerInstanceId: 'orch-a',
        },
      ]);
    });

    it('narrows reap candidates to event rows and maps their provisioning targets', async () => {
      const { db, mocks } = createMockDb({
        selectRows: [
          {
            agent_id: 'agent-77',
            scaler_name: 'github-actions',
            provisioning_targets: '["e2e/provision"]',
            owner_instance_id: null,
            adopted_by: 'orch-b',
            spawned_at: new Date('2026-08-21T10:00:00Z'),
          },
        ],
      });
      const store = new ScalerStateStore(db);

      const candidates = await store.listReapCandidates(new Date('2026-08-21T09:00:00Z'));

      expect(mocks.selectFrom).toHaveBeenCalledWith('scaler_spawning_agents');
      expect(mocks.selectWhere).toHaveBeenCalledWith(
        'backend_type',
        '=',
        ScalerBackendType.enum.event,
      );
      expect(candidates).toEqual([
        {
          agentId: 'agent-77',
          scalerName: 'github-actions',
          provisioningTargets: ['e2e/provision'],
          spawnedAt: new Date('2026-08-21T10:00:00Z'),
          adoptedBy: 'orch-b',
        },
      ]);
    });

    // The ownership columns are written only when the caller supplies them, so a
    // spawn-time upsert from a caller that knows nothing about instance ownership
    // cannot null out a value some other write already established. A refactor
    // back to `?? null` would reintroduce exactly that HA bug, so both branches of
    // the upsert are pinned here.

    it('omits ownership columns the caller did not supply', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.upsertSpawningAgent({
        agentId: 'agent-001',
        scalerName: 'container',
        labelSet: ['kici:os:linux'],
        spawnedAt: new Date(),
      });

      const inserted = mocks.insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
      const conflict = mocks.doUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
      for (const payload of [inserted, conflict]) {
        expect(payload).not.toHaveProperty('owner_instance_id');
        expect(payload).not.toHaveProperty('backend_type');
        expect(payload).not.toHaveProperty('mandatory_labels');
        expect(payload).not.toHaveProperty('provisioning_targets');
        expect(payload).not.toHaveProperty('roles');
      }
    });

    it('writes ownership columns on both branches when supplied', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.upsertSpawningAgent({
        agentId: 'agent-001',
        scalerName: 'github-actions',
        labelSet: [],
        spawnedAt: new Date(),
        ownerInstanceId: 'orch-a',
        backendType: ScalerBackendType.enum.event,
        mandatoryLabels: ['kici:os:linux'],
        provisioningTargets: ['e2e/provision'],
        roles: ['build'],
      });

      const expected = {
        owner_instance_id: 'orch-a',
        backend_type: ScalerBackendType.enum.event,
        mandatory_labels: JSON.stringify(['kici:os:linux']),
        provisioning_targets: JSON.stringify(['e2e/provision']),
        roles: JSON.stringify(['build']),
      };
      expect(mocks.insertValues).toHaveBeenCalledWith(expect.objectContaining(expected));
      expect(mocks.doUpdateSet).toHaveBeenCalledWith(expect.objectContaining(expected));
    });

    it('never writes the adoption columns from an upsert', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      // Supplied on purpose: a snapshot round-tripped through `toSpawningSnapshot`
      // carries them, and the upsert must still leave the adoption to
      // `adoptSpawningAgent` rather than clearing a race another instance won.
      await store.upsertSpawningAgent({
        agentId: 'agent-001',
        scalerName: 'github-actions',
        labelSet: [],
        spawnedAt: new Date(),
        adoptedBy: 'orch-b',
        adoptedAt: new Date('2026-08-21T10:00:05Z'),
      });

      const inserted = mocks.insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
      const conflict = mocks.doUpdateSet.mock.calls[0]?.[0] as Record<string, unknown>;
      for (const payload of [inserted, conflict]) {
        expect(payload).not.toHaveProperty('adopted_by');
        expect(payload).not.toHaveProperty('adopted_at');
      }
    });

    it('omits the reservation owner column the caller did not supply', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.upsertReservation({
        agentId: 'agent-001',
        scalerName: 'container',
        cpus: 2,
        memBytes: 1024,
      });

      expect(mocks.insertValues.mock.calls[0]?.[0]).not.toHaveProperty('owner_instance_id');
      expect(mocks.doUpdateSet.mock.calls[0]?.[0]).not.toHaveProperty('owner_instance_id');
    });

    it('writes the reservation owner column on both branches when supplied', async () => {
      const { db, mocks } = createMockDb();
      const store = new ScalerStateStore(db);

      await store.upsertReservation({
        agentId: 'agent-001',
        scalerName: 'container',
        cpus: 2,
        memBytes: 1024,
        ownerInstanceId: 'orch-a',
      });

      expect(mocks.insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ owner_instance_id: 'orch-a' }),
      );
      expect(mocks.doUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ owner_instance_id: 'orch-a' }),
      );
    });
  });
});
