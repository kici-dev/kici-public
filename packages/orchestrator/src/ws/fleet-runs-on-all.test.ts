import { describe, it, expect, vi } from 'vitest';
import { resolveWorkflowRunsOnAll } from './fleet-runs-on-all.js';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

/** Build a Kysely stub whose workflow_registrations query returns `rows`. */
function dbReturning(rows: Array<{ lock_entry: string }>): Kysely<Database> {
  return {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          where: () => ({ execute: () => Promise.resolve(rows) }),
        }),
      }),
    }),
  } as unknown as Kysely<Database>;
}

const fanoutWorkflow = JSON.stringify({
  name: 'fanout',
  jobs: [
    { _type: 'static', name: 'plain' },
    {
      _type: 'static',
      name: 'deploy',
      runsOnAll: { include: [[{ kind: 'exact', value: 'role:db' }]], exclude: [] },
      onUnreachable: 'skip',
    },
  ],
});

describe('resolveWorkflowRunsOnAll', () => {
  it('returns the runsOnAll predicate + onUnreachable for a fan-out workflow', async () => {
    const db = dbReturning([{ lock_entry: fanoutWorkflow }]);
    const res = await resolveWorkflowRunsOnAll(db, 'fanout');
    expect(res).not.toBeNull();
    expect(res?.include).toEqual([[{ kind: 'exact', value: 'role:db' }]]);
    expect(res?.exclude).toEqual([]);
    expect(res?.onUnreachable).toBe('skip');
  });

  it('defaults onUnreachable to hold when the job omits it', async () => {
    const wf = JSON.stringify({
      name: 'fanout',
      jobs: [{ _type: 'static', name: 'deploy', runsOnAll: { include: [], exclude: [] } }],
    });
    const res = await resolveWorkflowRunsOnAll(dbReturning([{ lock_entry: wf }]), 'fanout');
    expect(res?.onUnreachable).toBe('hold');
  });

  it('returns null when no job declares runsOnAll', async () => {
    const wf = JSON.stringify({
      name: 'plain',
      jobs: [{ _type: 'static', name: 'a' }],
    });
    const res = await resolveWorkflowRunsOnAll(dbReturning([{ lock_entry: wf }]), 'plain');
    expect(res).toBeNull();
  });

  it('returns null when the workflow is not registered', async () => {
    const res = await resolveWorkflowRunsOnAll(dbReturning([]), 'missing');
    expect(res).toBeNull();
  });

  it('skips an unparseable lock_entry without throwing', async () => {
    const res = await resolveWorkflowRunsOnAll(
      dbReturning([{ lock_entry: 'not json' }, { lock_entry: fanoutWorkflow }]),
      'fanout',
    );
    expect(res?.onUnreachable).toBe('skip');
  });
});
