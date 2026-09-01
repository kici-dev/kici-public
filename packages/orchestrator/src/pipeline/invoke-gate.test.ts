import { describe, it, expect, vi } from 'vitest';
import type { Kysely } from 'kysely';
import { ExecutionJobStatus, JobKind as WireJobKind } from '@kici-dev/engine';
import type { Database } from '../db/types.js';
import { JobKind } from '../db/types.js';
import {
  aggregateGateStatus,
  runInvokeGate,
  releaseInvokeGate,
  invokeParamsFromLockJob,
  isInvokeGate,
  zeroSubscriberMessage,
  reservedEventMessage,
  SummonRefusedError,
  type InvokeGateDeps,
  type RunInvokeGateArgs,
  type SummonedRun,
} from './invoke-gate.js';
import type { LockJob } from '@kici-dev/engine';

/** Records the execution_runs UPDATEs the executor issues to tag spawned runs. */
interface TagUpdate {
  set: Record<string, unknown>;
  runId: string;
}

function mockDb(tags: TagUpdate[]): Kysely<Database> {
  return {
    updateTable: () => {
      const pending: Partial<TagUpdate> = {};
      const chain = {
        set: (v: Record<string, unknown>) => {
          pending.set = v;
          return chain;
        },
        where: (_col: string, _op: string, val: string) => {
          pending.runId = val;
          return chain;
        },
        execute: async () => {
          tags.push({ set: pending.set ?? {}, runId: pending.runId ?? '' });
          return [];
        },
      };
      return chain;
    },
  } as unknown as Kysely<Database>;
}

function makeDeps(overrides: {
  summon: InvokeGateDeps['summon'];
  maxChainDepth?: number;
  tags?: TagUpdate[];
}): {
  deps: InvokeGateDeps;
  addJobsToRun: ReturnType<typeof vi.fn>;
  onJobStatus: ReturnType<typeof vi.fn>;
  reconcileSummonedRunIfTerminal: ReturnType<typeof vi.fn>;
} {
  const addJobsToRun = vi.fn(async () => {});
  const onJobStatus = vi.fn(async () => {});
  const reconcileSummonedRunIfTerminal = vi.fn(async () => {});
  return {
    addJobsToRun,
    onJobStatus,
    reconcileSummonedRunIfTerminal,
    deps: {
      db: mockDb(overrides.tags ?? []),
      executionTracker: { addJobsToRun, onJobStatus, reconcileSummonedRunIfTerminal } as never,
      summon: overrides.summon,
      maxChainDepth: overrides.maxChainDepth ?? 5,
    },
  };
}

const baseArgs: RunInvokeGateArgs = {
  runId: 'gate-run',
  gateJobId: 'gate-job',
  gateJobName: 'repo-tests',
  event: 'myorg.repo-tests',
  optional: false,
  sourceRepo: 'myorg/backend',
  chainDepth: 0,
};

describe('runInvokeGate', () => {
  it('creates one proxy per spawned run and tags each spawned run', async () => {
    const runs: SummonedRun[] = [
      { runId: 'r1', repo: 'myorg/backend', workflow: 'unit' },
      { runId: 'r2', repo: 'myorg/backend', workflow: 'lint' },
    ];
    const tags: TagUpdate[] = [];
    const { deps, addJobsToRun, onJobStatus } = makeDeps({
      summon: vi.fn(async () => runs),
      tags,
    });

    await runInvokeGate(deps, baseArgs);

    expect(onJobStatus).not.toHaveBeenCalled(); // gate stays running until proxies complete
    const proxies = addJobsToRun.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(proxies).toHaveLength(2);
    expect(proxies.map((p) => p.summonedRunId)).toEqual(['r1', 'r2']);
    expect(proxies.every((p) => p.jobKind === JobKind.Proxy)).toBe(true);
    expect(proxies.every((p) => p.baseJobName === 'repo-tests')).toBe(true);
    expect(proxies.map((p) => p.variantLabel)).toEqual([
      'myorg/backend:unit',
      'myorg/backend:lint',
    ]);
    // Each spawned run is tagged with its summoning gate + proxy job name.
    expect(tags).toHaveLength(2);
    expect(tags[0].runId).toBe('r1');
    expect(tags[0].set.summoned_by_run_id).toBe('gate-run');
    expect(tags[0].set.summoned_by_proxy_job).toBe(proxies[0].jobName);
  });

  it('reconciles each spawned run after tagging (closes the tag race → gate hang)', async () => {
    const runs: SummonedRun[] = [
      { runId: 'r1', repo: 'myorg/backend', workflow: 'unit' },
      { runId: 'r2', repo: 'myorg/backend', workflow: 'lint' },
    ];
    const { deps, reconcileSummonedRunIfTerminal } = makeDeps({
      summon: vi.fn(async () => runs),
    });

    await runInvokeGate(deps, baseArgs);

    // A run that finalized before its tag landed skipped the mirror; the gate
    // re-checks each tagged run so an already-terminal one still terminalizes.
    expect(reconcileSummonedRunIfTerminal.mock.calls.map((c) => c[0])).toEqual(['r1', 'r2']);
  });

  it('gives two runs with identical repo+workflow distinct, resolvable proxies', async () => {
    // Duplicate registrations: same repo + workflow, two runs. The proxy job_name
    // must be unique per run (it carries the run id) or the mirror's job_name
    // lookup resolves one proxy and the other hangs; variant_label stays the
    // shared human-readable label for the graph.
    const runs: SummonedRun[] = [
      { runId: 'run-aaaa', repo: 'myorg/backend', workflow: 'unit' },
      { runId: 'run-bbbb', repo: 'myorg/backend', workflow: 'unit' },
    ];
    const tags: TagUpdate[] = [];
    const { deps, addJobsToRun } = makeDeps({ summon: vi.fn(async () => runs), tags });

    await runInvokeGate(deps, baseArgs);

    const proxies = addJobsToRun.mock.calls[0][1] as Array<Record<string, unknown>>;
    // Distinct job_name (unique identity), shared variant_label (graph label).
    expect(proxies[0].jobName).not.toBe(proxies[1].jobName);
    expect(new Set(proxies.map((p) => p.jobName)).size).toBe(2);
    expect(proxies.map((p) => p.variantLabel)).toEqual([
      'myorg/backend:unit',
      'myorg/backend:unit',
    ]);
    // Each spawned run is tagged with ITS proxy's unique job_name, so the mirror
    // lookup keyed on job_name resolves exactly one proxy per run.
    expect(tags[0].set.summoned_by_proxy_job).toBe(proxies[0].jobName);
    expect(tags[1].set.summoned_by_proxy_job).toBe(proxies[1].jobName);
    expect(tags[0].set.summoned_by_proxy_job).not.toBe(tags[1].set.summoned_by_proxy_job);
  });

  it('fails the gate (require-by-default) when nothing subscribes', async () => {
    const { deps, onJobStatus, addJobsToRun } = makeDeps({ summon: vi.fn(async () => []) });

    await runInvokeGate(deps, baseArgs);

    expect(addJobsToRun).not.toHaveBeenCalled();
    expect(onJobStatus).toHaveBeenCalledWith(
      'gate-run',
      'gate-job',
      ExecutionJobStatus.enum.failed,
      expect.any(Number),
      undefined,
      { error: zeroSubscriberMessage('myorg/backend', 'myorg.repo-tests') },
    );
  });

  it('succeeds the gate when nothing subscribes and optional: true', async () => {
    const { deps, onJobStatus } = makeDeps({ summon: vi.fn(async () => []) });

    await runInvokeGate(deps, { ...baseArgs, optional: true });

    expect(onJobStatus).toHaveBeenCalledWith(
      'gate-run',
      'gate-job',
      ExecutionJobStatus.enum.success,
      expect.any(Number),
    );
  });

  /**
   * A refusal must never be readable as a zero-subscriber skip. The `optional`
   * variant is the one that matters: it is the configuration under which an
   * empty result reports SUCCESS, so a callback that returned `[]` on refusal
   * would turn a declined summon green.
   */
  it.each([[false], [true]])(
    'fails the gate on a refused summon even with optional: %s',
    async (optional) => {
      const summon = vi.fn(async () => {
        throw new SummonRefusedError('the orchestrator refused this summon');
      });
      const { deps, onJobStatus, addJobsToRun } = makeDeps({ summon });

      await runInvokeGate(deps, { ...baseArgs, optional });

      expect(addJobsToRun).not.toHaveBeenCalled();
      expect(onJobStatus).toHaveBeenCalledWith(
        'gate-run',
        'gate-job',
        ExecutionJobStatus.enum.failed,
        expect.any(Number),
        undefined,
        { error: 'the orchestrator refused this summon' },
      );
    },
  );

  it('still treats an EMPTY summon under optional as a green skip', async () => {
    // The control for the pair above: an empty array is a real outcome and
    // stays one. The failure above comes from the throw, not from the harness.
    const { deps, onJobStatus } = makeDeps({ summon: vi.fn(async () => []) });

    await runInvokeGate(deps, { ...baseArgs, optional: true });

    expect(onJobStatus).toHaveBeenCalledWith(
      'gate-run',
      'gate-job',
      ExecutionJobStatus.enum.success,
      expect.any(Number),
    );
  });

  it('fails the gate rather than hanging when the summon throws anything else', async () => {
    const summon = vi.fn(async () => {
      throw new Error('db is gone');
    });
    const { deps, onJobStatus } = makeDeps({ summon });

    // No rejection escapes: the gate would otherwise be left with no terminal
    // status at all, which is worse than a false green.
    await expect(runInvokeGate(deps, { ...baseArgs, optional: true })).resolves.toBeUndefined();

    expect(onJobStatus).toHaveBeenCalledWith(
      'gate-run',
      'gate-job',
      ExecutionJobStatus.enum.failed,
      expect.any(Number),
      undefined,
      { error: 'invoke gate summon failed: db is gone' },
    );
  });

  it('refuses to summon past the chain-depth bound', async () => {
    const summon = vi.fn(async () => []);
    const { deps, onJobStatus } = makeDeps({ summon, maxChainDepth: 3 });

    await runInvokeGate(deps, { ...baseArgs, chainDepth: 3 });

    expect(summon).not.toHaveBeenCalled();
    expect(onJobStatus).toHaveBeenCalledWith(
      'gate-run',
      'gate-job',
      ExecutionJobStatus.enum.failed,
      expect.any(Number),
      undefined,
      expect.objectContaining({ error: expect.stringMatching(/chain depth/i) }),
    );
  });

  it('increments chain depth for the summoned runs', async () => {
    const summon = vi.fn(async () => []);
    const { deps } = makeDeps({ summon, maxChainDepth: 5 });

    await runInvokeGate(deps, { ...baseArgs, chainDepth: 1 });

    expect(summon).toHaveBeenCalledWith(
      expect.objectContaining({ chainDepth: 2, summonedByRunId: 'gate-run' }),
    );
  });

  /**
   * The gate's event name is authored in the workflow (`invokeSource('...')`)
   * and reaches the dispatcher WITHOUT the `event.emit` guard — no agent
   * message, no `kici_events` row. So this is the path's own authoritative stop:
   * `__` would otherwise summon a run the trust classifier could read as
   * orchestrator-minted, and `kici.` would forge a scaler event with an
   * author-chosen payload — the exact forgery the scaler docs promise is
   * impossible.
   */
  it.each([
    ['__schedule_fire', '__'],
    ['__workflow_complete', '__'],
    ['kici.scaler.scale-up', 'kici.'],
  ])('refuses a gate naming the reserved event %s, without summoning', async (event, prefix) => {
    const summon = vi.fn(async () => [{ runId: 'r1', repo: 'a', workflow: 'w' }]);
    const { deps, onJobStatus, addJobsToRun } = makeDeps({ summon });

    await runInvokeGate(deps, { ...baseArgs, event });

    // Refused BEFORE the summon: nothing is dispatched, so there is nothing to
    // undo, and no proxy is created for a run that must not exist.
    expect(summon).not.toHaveBeenCalled();
    expect(addJobsToRun).not.toHaveBeenCalled();
    expect(onJobStatus).toHaveBeenCalledWith(
      'gate-run',
      'gate-job',
      ExecutionJobStatus.enum.failed,
      expect.any(Number),
      undefined,
      { error: reservedEventMessage(event, prefix) },
    );
  });

  it('still summons for an ordinary event name that merely contains the prefixes', async () => {
    // The control for the suite above: prefix, not substring. A guard that
    // refused everything would pass every case above.
    const summon = vi.fn(async () => [{ runId: 'r1', repo: 'a', workflow: 'w' }]);
    const { deps, addJobsToRun } = makeDeps({ summon });

    await runInvokeGate(deps, { ...baseArgs, event: 'deploy__done' });

    expect(summon).toHaveBeenCalledTimes(1);
    expect(addJobsToRun).toHaveBeenCalledTimes(1);
  });

  it('stamps wave columns and holds proxies beyond maxParallel', async () => {
    const runs: SummonedRun[] = [
      { runId: 'r1', repo: 'a', workflow: 'w' },
      { runId: 'r2', repo: 'b', workflow: 'w' },
      { runId: 'r3', repo: 'c', workflow: 'w' },
    ];
    const { deps, addJobsToRun } = makeDeps({ summon: vi.fn(async () => runs) });

    await runInvokeGate(deps, { ...baseArgs, maxParallel: 1, failFast: true });

    const proxies = addJobsToRun.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(proxies.map((p) => p.waveGated)).toEqual([undefined, true, true]);
    expect(proxies.every((p) => p.waveMaxParallel === 1 && p.waveFailFast === true)).toBe(true);
  });
});

describe('invokeParamsFromLockJob', () => {
  it('returns undefined for a job with no invoke action', () => {
    expect(
      invokeParamsFromLockJob({ invoke: undefined } as Pick<LockJob, 'invoke'>),
    ).toBeUndefined();
    expect(isInvokeGate({ invoke: undefined } as Pick<LockJob, 'invoke'>)).toBe(false);
  });

  it('extracts event, optional, fan-out policy, and timeout', () => {
    const params = invokeParamsFromLockJob({
      invoke: {
        event: 'myorg.repo-tests',
        scope: 'source',
        optional: true,
        payload: { sha: 'abc' },
      },
      maxParallel: 2,
      failFast: true,
      timeout: 60_000,
    } as unknown as LockJob);
    expect(params).toEqual({
      event: 'myorg.repo-tests',
      payload: { sha: 'abc' },
      optional: true,
      maxParallel: 2,
      failFast: true,
      timeoutMs: 60_000,
    });
    expect(isInvokeGate({ invoke: { event: 'e', scope: 'source' } } as LockJob)).toBe(true);
  });

  it('defaults optional to false when absent', () => {
    const params = invokeParamsFromLockJob({
      invoke: { event: 'e', scope: 'source' },
    } as unknown as LockJob);
    expect(params?.optional).toBe(false);
  });
});

describe('releaseInvokeGate', () => {
  it('swaps the synthetic gate row and summons using the run source repo + chain depth', async () => {
    const summon = vi.fn(async () => [] as SummonedRun[]);
    const onJobStatus = vi.fn(async () => {});
    const addJobsToRun = vi.fn(async () => {});
    const findSyntheticJobId = vi.fn(async () => 'needs-pending-repo-tests-xyz');
    const updates: Array<Record<string, unknown>> = [];

    // Mock db: execution_runs select → repo + chain depth; execution_jobs update captured.
    const db = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => ({ repo_identifier: 'myorg/backend', chain_depth: 2 }),
          }),
        }),
      }),
      updateTable: () => {
        const pending: Record<string, unknown> = {};
        const chain = {
          set: (v: Record<string, unknown>) => {
            Object.assign(pending, v);
            return chain;
          },
          where: () => chain,
          execute: async () => {
            updates.push({ ...pending });
            return [];
          },
        };
        return chain;
      },
    } as never;

    const invokeGateDeps: InvokeGateDeps = {
      db,
      executionTracker: { addJobsToRun, onJobStatus } as never,
      summon,
      maxChainDepth: 10,
    };
    const executionTracker = { findSyntheticJobId, addJobsToRun, onJobStatus } as never;

    await releaseInvokeGate({ db, executionTracker, invokeGateDeps }, 'gate-run', 'repo-tests', {
      event: 'myorg.repo-tests',
      optional: false,
      maxParallel: 3,
      failFast: true,
      timeoutMs: 45_000,
    });

    // Synthetic → real gate row swap: addJobsToRun called with jobKind gate + timeout, replaceSyntheticId set.
    const [runId, jobs, , replaceSyntheticId] = addJobsToRun.mock.calls[0];
    expect(runId).toBe('gate-run');
    expect(jobs[0].jobKind).toBe(JobKind.Gate);
    expect(jobs[0].jobName).toBe('repo-tests');
    expect(jobs[0].timeoutMs).toBe(45_000);
    expect(replaceSyntheticId).toBe('needs-pending-repo-tests-xyz');

    // The real gate row is stamped needs_satisfied so the invariant check does not flag it.
    expect(updates[0]).toMatchObject({ needs_satisfied: true });

    // summon uses the run's source repo + chain depth (incremented in runInvokeGate).
    expect(summon).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRepo: 'myorg/backend', chainDepth: 3 }),
    );
  });
});

describe('aggregateGateStatus', () => {
  it('stays open until every proxy is terminal', () => {
    expect(aggregateGateStatus(['success', 'running']).allTerminal).toBe(false);
  });

  it('succeeds when every proxy succeeds', () => {
    const r = aggregateGateStatus(['success', 'success']);
    expect(r.allTerminal).toBe(true);
    expect(r.status).toBe(ExecutionJobStatus.enum.success);
  });

  it('fails when any proxy fails', () => {
    const r = aggregateGateStatus(['success', 'failed']);
    expect(r.allTerminal).toBe(true);
    expect(r.status).toBe(ExecutionJobStatus.enum.failed);
  });

  it('treats an empty proxy set as terminal-success (vacuous)', () => {
    expect(aggregateGateStatus([])).toEqual({
      allTerminal: true,
      status: ExecutionJobStatus.enum.success,
    });
  });
});

describe('JobKind enum parity', () => {
  it('the DB TS enum enumerates the same members as the engine wire enum', () => {
    // The engine Zod `JobKind` is what a relayed job-status message carries on the
    // wire; the orchestrator DB `JobKind` is what `execution_jobs.job_kind` stores.
    // A member present in one but not the other silently mis-tags a gate/proxy
    // row across the seam, so keep the two vocabularies in step (same precedent as
    // HeldRunStatus). Sorted — declaration order is not part of the contract.
    expect([...WireJobKind.options].sort()).toEqual(Object.values(JobKind).sort());
  });
});
