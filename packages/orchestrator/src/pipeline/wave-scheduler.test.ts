import { describe, it, expect } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { ExecutionJobStatus } from '@kici-dev/engine';
import { evaluateWave } from './wave-scheduler.js';

interface ChildRow {
  job_name: string;
  status: string;
  wave_gated: boolean;
  variant_label: string | null;
  wave_max_parallel: number | null;
  wave_fail_fast: boolean | null;
}

/**
 * Minimal Kysely stand-in for evaluateWave's single query:
 * `selectFrom('execution_jobs').select([...]).where().where().execute()`.
 */
function mockDb(children: ChildRow[]): Kysely<Database> {
  const chain = {
    select: () => chain,
    where: () => chain,
    execute: async () => children,
  };
  return { selectFrom: () => chain } as unknown as Kysely<Database>;
}

/** Build a fan-out child row with the wave policy stamped (the bounded-wave case). */
const child = (
  name: string,
  status: string,
  waveGated: boolean,
  policy: { maxParallel: number; failFast?: boolean } | null,
): ChildRow => ({
  job_name: name,
  status,
  wave_gated: waveGated,
  variant_label: name.replace(/^patch \(|\)$/g, ''),
  wave_max_parallel: policy?.maxParallel ?? null,
  wave_fail_fast: policy?.failFast ?? (policy ? false : null),
});

const evalArgs = (completedStatus = ExecutionJobStatus.enum.success) => ({
  runId: 'r',
  baseJobName: 'patch',
  completedStatus,
});

const P1 = { maxParallel: 1 };
const P2 = { maxParallel: 2 };

describe('evaluateWave', () => {
  it('releases the next wave_gated sibling (lowest variant_label) when one completes', async () => {
    const db = mockDb([
      child('patch (web-01)', 'success', false, P1),
      child('patch (web-02)', 'pending', true, P1),
      child('patch (web-03)', 'pending', true, P1),
    ]);
    expect(await evaluateWave(db, evalArgs())).toMatchObject({
      action: 'release',
      jobName: 'patch (web-02)',
      baseJobName: 'patch',
    });
  });

  it('does nothing when in-flight count is still at maxParallel', async () => {
    const db = mockDb([
      child('patch (web-01)', 'success', false, P2),
      child('patch (web-02)', 'running', false, P2),
      child('patch (web-03)', 'running', false, P2),
      child('patch (web-04)', 'pending', true, P2),
    ]);
    expect(await evaluateWave(db, evalArgs())).toEqual({ action: 'noop' });
  });

  it('releases when in-flight drops below maxParallel', async () => {
    const db = mockDb([
      child('patch (web-01)', 'success', false, P2),
      child('patch (web-02)', 'success', false, P2),
      child('patch (web-03)', 'running', false, P2),
      child('patch (web-04)', 'pending', true, P2),
    ]);
    expect(await evaluateWave(db, evalArgs())).toMatchObject({
      action: 'release',
      jobName: 'patch (web-04)',
    });
  });

  it('noops when no wave_gated siblings remain', async () => {
    const db = mockDb([
      child('patch (web-01)', 'success', false, P1),
      child('patch (web-02)', 'success', false, P1),
    ]);
    expect(await evaluateWave(db, evalArgs())).toEqual({ action: 'noop' });
  });

  it('noops when no sibling carries a wave policy (not a bounded wave)', async () => {
    const db = mockDb([
      child('patch (web-01)', 'success', false, null),
      child('patch (web-02)', 'success', false, null),
    ]);
    expect(await evaluateWave(db, evalArgs())).toEqual({ action: 'noop' });
  });

  it('recovers the policy from a held sibling when the completed row lost it', async () => {
    // The just-completed child was re-inserted on release without the policy
    // (wave_max_parallel null); a still-held sibling carries it.
    const db = mockDb([
      child('patch (web-01)', 'success', false, null),
      child('patch (web-02)', 'pending', true, P1),
    ]);
    expect(await evaluateWave(db, evalArgs())).toMatchObject({
      action: 'release',
      jobName: 'patch (web-02)',
      baseJobName: 'patch',
    });
  });

  it('skips the remaining siblings on a child failure when failFast', async () => {
    const ff = { maxParallel: 1, failFast: true };
    const db = mockDb([
      child('patch (web-01)', 'failed', false, ff),
      child('patch (web-02)', 'pending', true, ff),
      child('patch (web-03)', 'pending', true, ff),
    ]);
    expect(await evaluateWave(db, evalArgs(ExecutionJobStatus.enum.failed))).toEqual({
      action: 'skip-remaining',
      jobNames: ['patch (web-02)', 'patch (web-03)'],
    });
  });

  it('failFast on a SUCCESS still releases the next sibling (only failures halt)', async () => {
    const ff = { maxParallel: 1, failFast: true };
    const db = mockDb([
      child('patch (web-01)', 'success', false, ff),
      child('patch (web-02)', 'pending', true, ff),
    ]);
    expect(await evaluateWave(db, evalArgs(ExecutionJobStatus.enum.success))).toMatchObject({
      action: 'release',
      jobName: 'patch (web-02)',
      failFast: true,
    });
  });

  it('failFast on a failure with no held siblings is a noop (nothing to skip)', async () => {
    const ff = { maxParallel: 1, failFast: true };
    const db = mockDb([
      child('patch (web-01)', 'failed', false, ff),
      child('patch (web-02)', 'success', false, ff),
    ]);
    expect(await evaluateWave(db, evalArgs(ExecutionJobStatus.enum.failed))).toEqual({
      action: 'noop',
    });
  });
});
