/**
 * A bound context missing in the run's org while another org on the same
 * orchestrator has it: the job still dispatches, and its env warning says so,
 * naming only the run's org.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  dispatchMatchedWorkflow,
  formatCrossOrgContextWarning,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import {
  makeGateTracker,
  makeHoldDb,
  makeSingleJobContext,
  TEST_INBOUND_PROVIDER,
} from './dispatch-matched-workflow.test-helpers.js';

const bundle = {
  normalizer: { provider: TEST_INBOUND_PROVIDER },
  repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://git.example/${repo}.git` },
} as unknown as WorkflowDispatchContext['bundle'];

const RUN_ORG = 'org_run';

async function dispatchBindingPages(otherOrgs: string[], testRun = false) {
  const orgsMatchingContext = vi.fn(async () => otherOrgs);
  const { ctx, dispatched } = makeSingleJobContext({
    bundle,
    fullRepo: true,
    executionTracker: makeGateTracker(),
    db: makeHoldDb(),
    jobContext: 'pages',
    contextStore: { matchContext: async () => null, orgsMatchingContext },
    ...(testRun && { testRun: { fixtureId: 'fx-1' } }),
  });
  ctx.resolvedOrgId = RUN_ORG;
  const result = await dispatchMatchedWorkflow(ctx);
  return { result, dispatched, orgsMatchingContext };
}

describe('cross-org bound context warning', () => {
  it('warns on a non-test run, naming the run org and not the other org', async () => {
    // fails-when: the missing context is skipped silently, or the other org id leaks.
    const { result, dispatched, orgsMatchingContext } = await dispatchBindingPages(['org_other']);
    expect(orgsMatchingContext).toHaveBeenCalledWith('pages', RUN_ORG);
    expect(dispatched).toHaveLength(1);
    expect(result.envWarnings).toEqual([formatCrossOrgContextWarning(['pages'], RUN_ORG)]);
    expect(result.envWarnings?.[0]).toContain(`org '${RUN_ORG}'`);
    expect(result.envWarnings?.join()).not.toContain('org_other');
  });

  it('keeps no warning when no other org has the context', async () => {
    // breaks-if-wrong: a plainly unconfigured context dispatches as before.
    const { result, dispatched } = await dispatchBindingPages([]);
    expect(dispatched).toHaveLength(1);
    expect(result.envWarnings).toBeUndefined();
  });

  it('appends the cross-org sentence to a test run unavailable warning', async () => {
    const { result } = await dispatchBindingPages(['org_other'], true);
    const [warning] = result.envWarnings ?? [];
    expect(warning).toContain('unavailable for this test run');
    expect(warning).toContain('Another org on this orchestrator has a context with that name');
    expect(warning).not.toContain('org_other');
  });

  it('formats several names as one sentence', () => {
    expect(formatCrossOrgContextWarning(['a', 'b'], 'o')).toMatch(
      /^Contexts 'a', 'b' are not configured in org 'o'.*none of their variables/,
    );
  });
});
