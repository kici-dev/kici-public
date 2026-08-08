import { describe, it, expect, beforeEach } from 'vitest';
import { TERMINAL_RUN_STATES } from '@kici-dev/engine';
import {
  toSerializableInputs,
  storePendingWorkflowContext,
  loadPendingWorkflowContext,
  deletePendingWorkflowContext,
  restorePendingWorkflowContexts,
  clearPendingWorkflowContextsMap,
  type SerializableWorkflowDispatchInputs,
} from './pending-workflow-context.js';

/**
 * Mock DB that models both `pending_workflow_contexts` and `execution_runs`,
 * and actually simulates the terminal-run prune so the restore test can prove
 * a terminal run's row is deleted (and not restored) while a non-terminal one
 * survives. `deleteFrom('pending_workflow_contexts').where('run_id','in', <subquery>)`
 * removes every pending row whose run status is in `TERMINAL_RUN_STATES`.
 */
function createMockDb(
  pendingRows: Array<{ run_id: string; context: SerializableWorkflowDispatchInputs }>,
  runStatuses: Record<string, string>,
) {
  const rows = [...pendingRows];
  return {
    deleteFrom: (table: string) => {
      expect(table).toBe('pending_workflow_contexts');
      return {
        where: (col: string, op: string) => {
          expect(col).toBe('run_id');
          expect(op).toBe('in');
          return {
            execute: async () => {
              // Prune rows whose run reached a terminal state.
              for (let i = rows.length - 1; i >= 0; i--) {
                const status = runStatuses[rows[i].run_id];
                if (status !== undefined && TERMINAL_RUN_STATES.has(status)) {
                  rows.splice(i, 1);
                }
              }
            },
          };
        },
      };
    },
    selectFrom: (table: string) => {
      if (table === 'execution_runs') {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.where = () => chain;
        return chain;
      }
      return {
        selectAll: () => ({ execute: async () => rows }),
      };
    },
  };
}

function makeInputs(
  overrides: Partial<SerializableWorkflowDispatchInputs> = {},
): SerializableWorkflowDispatchInputs {
  return {
    runId: 'run1',
    resolvedOrgId: 'org1',
    repoIdentifier: 'a/b',
    info: {
      routingKey: 'github:1',
      deliveryId: 'd1',
      event: 'push',
      action: null,
      provider: 'github',
      payload: { ref: 'refs/heads/main' },
    },
    payload: { ref: 'refs/heads/main' },
    credentials: {},
    event: { type: 'push', targetBranch: 'main' },
    eventWithFiles: { type: 'push', targetBranch: 'main' },
    ref: 'sha',
    fullLockFile: { workflows: [], source: { file: '.kici/workflows/x.ts' } },
    workflow: { name: 'wf' },
    decision: { matched: true, workflowName: 'wf' },
    trustResolution: { tier: 'trusted' },
    lockFileSource: undefined,
    crossSource: false,
    ...overrides,
  } as unknown as SerializableWorkflowDispatchInputs;
}

describe('pending-workflow-context', () => {
  beforeEach(() => clearPendingWorkflowContextsMap());

  it('stores and loads the serializable inputs by runId (memory path)', async () => {
    const inputs = makeInputs();
    await storePendingWorkflowContext(undefined, inputs);
    const got = await loadPendingWorkflowContext(undefined, 'run1');
    expect(got).toEqual(inputs);
  });

  it('returns null for an unknown runId', async () => {
    expect(await loadPendingWorkflowContext(undefined, 'nope')).toBeNull();
  });

  it('overwrites an existing entry for the same runId', async () => {
    await storePendingWorkflowContext(undefined, makeInputs({ ref: 'sha-1' }));
    await storePendingWorkflowContext(undefined, makeInputs({ ref: 'sha-2' }));
    const got = await loadPendingWorkflowContext(undefined, 'run1');
    expect(got?.ref).toBe('sha-2');
  });

  it('deletes the entry', async () => {
    await storePendingWorkflowContext(undefined, makeInputs());
    await deletePendingWorkflowContext(undefined, 'run1');
    expect(await loadPendingWorkflowContext(undefined, 'run1')).toBeNull();
  });

  it('prunes rows for terminal runs on restore and keeps non-terminal ones', async () => {
    const terminalStatus = [...TERMINAL_RUN_STATES][0];
    const db = createMockDb(
      [
        { run_id: 'run-terminal', context: makeInputs({ runId: 'run-terminal' }) },
        { run_id: 'run-held', context: makeInputs({ runId: 'run-held' }) },
      ],
      { 'run-terminal': terminalStatus, 'run-held': 'held' },
    );

    const restored = await restorePendingWorkflowContexts(db as never);

    // Only the non-terminal (held) run's context survives the prune + restore.
    expect(restored).toBe(1);
    expect(await loadPendingWorkflowContext(undefined, 'run-held')).not.toBeNull();
    expect(await loadPendingWorkflowContext(undefined, 'run-terminal')).toBeNull();
  });

  it('does not carry the pending-jobs token flag into the stored context', () => {
    // `buildWindowTokenHeld` records that ONE dispatch call is holding a token,
    // which it releases before returning. Persisting it would make the resumed
    // dispatch release a token it never took — stealing the one held by a
    // deferred init / dynamic task and un-holding the run mid-registration.
    const ctx = {
      ...makeInputs(),
      deps: {},
      bundle: {},
      buildWindowTokenHeld: true,
    };

    const stored = toSerializableInputs(ctx as never) as Record<string, unknown>;

    expect('buildWindowTokenHeld' in stored).toBe(false);
    expect('deps' in stored).toBe(false);
    expect('bundle' in stored).toBe(false);
    expect(stored.runId).toBe('run1');
  });
});
