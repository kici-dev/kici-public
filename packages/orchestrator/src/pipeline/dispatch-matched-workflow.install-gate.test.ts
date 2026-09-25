/**
 * The workflow install gate across a hold and its release, through the real
 * dispatch: the hold stores which contexts its approval covers, and the release
 * reads that record back from the stored dispatch context.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InitFailureCategory } from '@kici-dev/engine';
import type { LockRegistry } from '@kici-dev/engine';
import {
  dispatchMatchedWorkflow,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import {
  clearPendingWorkflowContextsMap,
  loadPendingWorkflowContext,
} from './pending-workflow-context.js';
import { rebuildWorkflowDispatchContext, withWorkflowRepoCredentials } from './resume-workflow.js';
import {
  makeGateTracker,
  makeJobContextRow,
  makeSingleJobContext,
} from './dispatch-matched-workflow.test-helpers.js';

const REGISTRIES: LockRegistry[] = [
  { url: 'https://npm.example.com/', tokenSecret: 'a:NPM_TOKEN' },
];
const INSTALL_ENV = ['b:CARGO_TOKEN'];
/** The provider bundle the live registry answers for the run's routing key. */
const bundle = {
  normalizer: { provider: 'local' },
  repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://git.example/${repo}.git` },
} as unknown as WorkflowDispatchContext['bundle'];
const SECRETS: Record<string, Record<string, string>> = {
  a: { NPM_TOKEN: 'a-token' },
  b: { CARGO_TOKEN: 'b-token' },
};

/** Context `a` holds for a reviewer; context `b` has no rules. */
const ROW_A = makeJobContextRow(
  'a',
  { bundle: undefined },
  {
    required_reviewers: JSON.stringify(['alice']),
  },
);
const ROW_B = makeJobContextRow('b', { bundle: undefined });
/** `b` after an operator restricted it to release branches; the run presents `main`. */
const ROW_B_RESTRICTED = makeJobContextRow(
  'b',
  { bundle: undefined },
  {
    branch_restrictions: JSON.stringify(['release/*']),
  },
);

function makeHarness() {
  const rows = new Map<string, unknown>([
    ['a', ROW_A],
    ['b', ROW_B],
  ]);
  const tracker = {
    ...makeGateTracker(),
    recordRunHeld: vi.fn().mockResolvedValue(undefined),
    resumeHeldRun: vi.fn().mockResolvedValue(true),
  };
  const heldRunStore = { createHold: vi.fn().mockResolvedValue({ id: 'hold-1' }) };
  const resolveForContext = vi.fn(async (_orgId: string, c: { name: string }) => SECRETS[c.name]);
  const { ctx, dispatched } = makeSingleJobContext({
    bundle,
    fullRepo: true,
    executionTracker: tracker,
    heldRunStore,
    secretResolver: { resolveForContext },
    contextStore: { matchContext: async (_org: string, name: string) => rows.get(name) ?? null },
  });
  const workflow = ctx.workflow as { registries?: LockRegistry[]; installEnv?: string[] };
  workflow.registries = REGISTRIES;
  workflow.installEnv = INSTALL_ENV;
  (ctx.deps as unknown as Record<string, unknown>).providerRegistry = {
    getByRoutingKey: () => bundle,
  };
  return { ctx, dispatched, rows, tracker, heldRunStore, resolveForContext };
}

/** The dispatch context a release rebuilds from the stored inputs, as `resumeWorkflow` does. */
async function storedContext(live: WorkflowDispatchContext): Promise<WorkflowDispatchContext> {
  const stored = await loadPendingWorkflowContext(undefined, live.runId);
  if (!stored) throw new Error('the hold stored no dispatch context');
  const rebuilt = rebuildWorkflowDispatchContext(stored, live.deps);
  if (!rebuilt) throw new Error('the stored dispatch context could not be rebuilt');
  return withWorkflowRepoCredentials(rebuilt);
}

describe('dispatchMatchedWorkflow — install gate over a hold and its release', () => {
  beforeEach(() => clearPendingWorkflowContextsMap());

  it('stores which contexts held and which were admitted', async () => {
    const h = makeHarness();
    const result = await dispatchMatchedWorkflow(h.ctx);

    expect(result.held).toBe(true);
    expect(h.heldRunStore.createHold.mock.calls[0][1]).toMatchObject({ contextId: 'env-a' });
    const stored = await loadPendingWorkflowContext(undefined, h.ctx.runId);
    // fails-when: the hold is stored without the record its release needs
    expect(stored?.installGateRecord).toEqual({
      held: [{ name: 'a', id: 'env-a' }],
      admitted: [{ name: 'b', id: 'env-b' }],
    });
    expect(h.resolveForContext).not.toHaveBeenCalled();
  });

  it('delivers both contexts on release when nothing changed', async () => {
    const h = makeHarness();
    await dispatchMatchedWorkflow(h.ctx);

    await dispatchMatchedWorkflow(await storedContext(h.ctx), {
      skipInstallProtectionGate: true,
      reuseRunId: h.ctx.runId,
    });

    // breaks-if-wrong: the approved context is held again by its reviewer rule
    expect(h.dispatched).toHaveLength(1);
    const jobConfig = h.dispatched[0].jobConfig as Record<string, unknown>;
    expect(jobConfig.npmRegistries).toMatchObject([{ token: 'a-token' }]);
    expect(jobConfig.installEnvSecrets).toEqual({ CARGO_TOKEN: 'b-token' });
  });

  it('fails the run on release when an admitted context now rejects', async () => {
    const h = makeHarness();
    await dispatchMatchedWorkflow(h.ctx);
    h.rows.set('b', ROW_B_RESTRICTED);

    await dispatchMatchedWorkflow(await storedContext(h.ctx), {
      skipInstallProtectionGate: true,
      reuseRunId: h.ctx.runId,
    });

    // fails-when: the release skips `b`'s gate, which the approval never covered
    expect(h.dispatched).toHaveLength(0);
    expect(h.resolveForContext).not.toHaveBeenCalled();
    expect(h.tracker.recordInitFailureRun).toHaveBeenCalledTimes(1);
    expect(h.tracker.recordInitFailureRun.mock.calls[0][0]).toMatchObject({
      initFailure: { category: InitFailureCategory.enum.install_secrets },
    });
    const failure = JSON.stringify(h.tracker.recordInitFailureRun.mock.calls[0][0]);
    expect(failure).toContain("context 'b' install gate reject");
    // The approval covered `a`: only a release that lost the record gates it again.
    expect(failure).not.toContain("context 'a'");
  });
});
