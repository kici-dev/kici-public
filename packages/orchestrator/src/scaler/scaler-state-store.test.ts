import { describe, it, expect } from 'vitest';

import { ScalerStateStore } from './scaler-state-store.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

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

    it('sweepStaleSpawningAgents returns the deleted row count', async () => {
      const { db, mocks } = createMockDb({ deleteResult: { numDeletedRows: 2n } });
      const store = new ScalerStateStore(db);

      const count = await store.sweepStaleSpawningAgents(new Date('2026-05-18T09:00:00Z'));

      expect(count).toBe(2);
      expect(mocks.deleteFrom).toHaveBeenCalledWith('scaler_spawning_agents');
      expect(mocks.deleteWhere).toHaveBeenCalledWith(
        'spawned_at',
        '<',
        new Date('2026-05-18T09:00:00Z'),
      );
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
});
