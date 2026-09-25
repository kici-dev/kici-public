import { describe, expect, it } from 'vitest';
import {
  canonicalizeLabels,
  canonicalizeMatcher,
  ExecutionJobStatus,
  type LabelMatcher,
} from '@kici-dev/engine';
import {
  classifyUnroutable,
  type JobRoutingFacts,
  makeCanRouteLabels,
  terminalizeUnroutableJob,
  unroutableMessage,
  type TerminalizeDeps,
} from './terminalize-unroutable.js';
import { PendingGlobalEvalTracker } from '../cache/pending-global-evals.js';
import { AgentRegistry } from '../agent/registry.js';
import { JobContainerNeed } from '../scaler/agent-fit.js';
import { mockWs } from '../__test-helpers__/mock-ws.js';

/**
 * The routing facts as `rowToExpiredJobInfo` produces them: selectors are given
 * as plain strings and folded here, exactly as that read folds them.
 */
function facts(
  over: {
    lastProvisioningError?: string | null;
    runsOnLabels?: string[];
    runsOnPatterns?: LabelMatcher[];
    excludeLabels?: string[];
    excludePatterns?: LabelMatcher[];
  } = {},
): JobRoutingFacts {
  return {
    lastProvisioningError: over.lastProvisioningError ?? null,
    runsOnLabels: canonicalizeLabels(over.runsOnLabels ?? ['linux', 'gpu']),
    runsOnPatterns: (over.runsOnPatterns ?? []).map(canonicalizeMatcher),
    excludeLabels: canonicalizeLabels(over.excludeLabels ?? []),
    excludePatterns: (over.excludePatterns ?? []).map(canonicalizeMatcher),
  };
}

describe('classifyUnroutable', () => {
  it('is unroutable when nothing in the fleet can route the labels', () => {
    const r = classifyUnroutable(facts(), () => false);
    expect(r.unroutable).toBe(true);
    expect(r.status).toBe(ExecutionJobStatus.enum.unroutable);
    expect(r.errorMessage).toContain('runsOn [linux, gpu]');
  });

  it('is timed_out_stale when something could route it', () => {
    const r = classifyUnroutable(facts(), () => true);
    expect(r.unroutable).toBe(false);
    expect(r.status).toBe(ExecutionJobStatus.enum.timed_out_stale);
  });

  it('is never unroutable when a provisioning error was recorded', () => {
    // The scaler got far enough to attempt (and fail) a spawn, so the labels
    // DID route — the real cause is that failure, not the `runsOn`.
    const r = classifyUnroutable(
      facts({ lastProvisioningError: 'image pull failed' }),
      () => false,
    );
    expect(r.unroutable).toBe(false);
    expect(r.status).toBe(ExecutionJobStatus.enum.timed_out_stale);
    expect(r.errorMessage).toBe('image pull failed');
  });

  it('settles an external provisioning failure on the provisioning cause, not the labels', () => {
    // The shape the event scaler records once its stranded provision is reaped.
    // The probe deliberately says "nothing routes": a `runsOn` naming only the
    // scaler's own label matches no CONNECTED agent while the provision is
    // failing, which is exactly the state that produced the misleading
    // "No connected agent or scaler backend currently matches …" verdict — a
    // backend did match, and was actively spawning.
    const detail =
      'External provisioning for scaler `github-actions` produced no agent: the scale-up ' +
      'was delivered, but agent agent-77 never registered before the spawn timeout.';
    const r = classifyUnroutable(
      facts({ runsOnLabels: ['github-actions'], lastProvisioningError: detail }),
      () => false,
    );
    expect(r.unroutable).toBe(false);
    expect(r.status).toBe(ExecutionJobStatus.enum.timed_out_stale);
    expect(r.errorMessage).toBe(detail);
    expect(r.errorMessage).not.toContain('No connected agent or scaler backend');
  });

  it('falls back to timed_out_stale when no probe is wired', () => {
    const r = classifyUnroutable(facts(), undefined);
    expect(r.unroutable).toBe(false);
    expect(r.status).toBe(ExecutionJobStatus.enum.timed_out_stale);
    expect(r.errorMessage).toContain('Queue timeout expired');
  });

  it('renders regex matchers readably rather than as [object Object]', () => {
    const r = classifyUnroutable(
      facts({
        runsOnLabels: [],
        runsOnPatterns: [{ kind: 'regex', source: 'gpu-.*', flags: 'i' }],
      }),
      () => false,
    );
    expect(r.errorMessage).toContain('/gpu-.*/i');
    expect(r.errorMessage).not.toContain('[object Object]');
  });
});

describe('a container job nothing can start', () => {
  /**
   * Labels route for a plain job and not for a container one: the agents that
   * match cannot start a container.
   */
  const labelsOnly = (
    _l: string[],
    _p: LabelMatcher[],
    _e: string[],
    _x: LabelMatcher[],
    job?: {
      container: JobContainerNeed;
    },
  ) => (job?.container ?? JobContainerNeed.None) === JobContainerNeed.None;

  it('is unroutable, and says the matching agents lack a container runtime', () => {
    const verdict = classifyUnroutable(
      { ...facts({ runsOnLabels: ['linux'] }), id: 'q-1', container: JobContainerNeed.Image },
      labelsOnly,
    );

    // fails-when: the job waits out the queue timeout as timed_out_stale, or
    // fails with a message telling its author to fix a correct runsOn
    expect(verdict.status).toBe(ExecutionJobStatus.enum.unroutable);
    expect(verdict.errorMessage).toBe(
      "No connected agent can start this job's container: the agents that match runsOn " +
        '[linux] report neither kici:runtime:docker nor kici:runtime:podman, and no scaler ' +
        'backend matches — the job was never dispatched',
    );
  });

  it('keeps the label message when no agent matches the labels either', () => {
    const verdict = classifyUnroutable(
      { ...facts({ runsOnLabels: ['linux'] }), container: JobContainerNeed.Image },
      () => false,
    );
    expect(verdict.errorMessage).toContain(
      'No connected agent or scaler backend currently matches',
    );
  });

  it('leaves a plain job on the same fleet routable', () => {
    // breaks-if-wrong: an agent that cannot start containers still routes plain jobs
    const verdict = classifyUnroutable(
      { ...facts({ runsOnLabels: ['linux'] }), container: JobContainerNeed.None },
      labelsOnly,
    );
    expect(verdict.unroutable).toBe(false);
  });
});

describe("a job whose only matching agents run other jobs' images", () => {
  /**
   * An agent carries the labels, and refuses every job it is asked to fit: the
   * shape of a fleet whose only matching agents were each started inside
   * another job's image.
   */
  const labelsMatchNoFit = (
    _l: string[],
    _p: LabelMatcher[],
    _e: string[],
    _x: LabelMatcher[],
    job?: { container: JobContainerNeed },
  ) => job === undefined;

  const IMAGE_AGENTS_MESSAGE =
    'No connected agent can take this job: the agents that match runsOn [linux] were each ' +
    "started inside another job's image and run only that job, and no scaler backend " +
    'matches — the job was never dispatched';

  it('is unroutable, and says the matching agents run other jobs', () => {
    const verdict = classifyUnroutable(
      { ...facts({ runsOnLabels: ['linux'] }), id: 'q-1', container: JobContainerNeed.None },
      labelsMatchNoFit,
    );

    // fails-when: the job is told no agent matches its correct runsOn
    expect(verdict.status).toBe(ExecutionJobStatus.enum.unroutable);
    expect(verdict.errorMessage).toBe(IMAGE_AGENTS_MESSAGE);
  });

  it('says the same of a container job, which those agents refuse as well', () => {
    const verdict = classifyUnroutable(
      { ...facts({ runsOnLabels: ['linux'] }), id: 'q-1', container: JobContainerNeed.Image },
      labelsMatchNoFit,
    );
    expect(verdict.errorMessage).toBe(IMAGE_AGENTS_MESSAGE);
  });

  it('keeps the label message when no connected agent carries the labels', () => {
    // breaks-if-wrong: a runsOn that matches nothing must still be named as the cause
    const verdict = classifyUnroutable(
      { ...facts({ runsOnLabels: ['linux'] }), container: JobContainerNeed.None },
      () => false,
    );
    expect(verdict.errorMessage).toContain(
      'No connected agent or scaler backend currently matches runsOn [linux]',
    );
  });
});

describe('makeCanRouteLabels', () => {
  const imageJob = { jobId: 'q-1', container: JobContainerNeed.Image };

  it('counts only an agent that can start the container, with no scaler', () => {
    const registry = new AgentRegistry();
    registry.register('static-1', mockWs(), ['linux'], 'linux', 'x64', '0.10.0');
    const canRoute = makeCanRouteLabels({ registry });

    // fails-when: a runtime-less 0.10.0 agent counts as a route for a container job
    expect(canRoute(['linux'], [], [], [], imageJob)).toBe(false);
    // breaks-if-wrong: the same agent routes a plain job, and routes labels alone
    expect(canRoute(['linux'], [], [], [], { container: JobContainerNeed.None })).toBe(true);
    expect(canRoute(['linux'], [], [], [])).toBe(true);

    registry.register(
      'static-2',
      mockWs(),
      ['linux', 'kici:runtime:docker'],
      'linux',
      'x64',
      '0.10.0',
    );
    expect(canRoute(['linux'], [], [], [], imageJob)).toBe(true);
  });

  it('reads a matching scaler backend as a route, since it can start an agent for the job', () => {
    const canRoute = makeCanRouteLabels({
      registry: new AgentRegistry(),
      scaler: { hasBackendForLabels: () => true, agentView: () => undefined },
    });
    expect(canRoute(['linux'], [], [], [], imageJob)).toBe(true);
  });
});

describe('unroutableMessage', () => {
  it('names the excluded selectors when the job has any', () => {
    const msg = unroutableMessage(facts({ excludeLabels: ['spot'] }));
    expect(msg).toContain('runsOn [linux, gpu]');
    expect(msg).toContain('excluding [spot]');
  });

  it('says any agent would do when the job declares no runsOn', () => {
    const msg = unroutableMessage(facts({ runsOnLabels: [] }));
    expect(msg).toContain('it declares no runsOn, so any agent would do');
  });
});

describe('terminalizeUnroutableJob and the global-eval tracker', () => {
  /**
   * A round job is the one queue entry with an in-process awaiter and no
   * `execution_runs` row, so every other branch of `terminalizeUnroutableJob`
   * is a no-op for it and the stub below never has to model more than the
   * first update returning zero rows.
   */
  const zeroRowDb = () =>
    ({
      updateTable: () => ({
        set: () => ({
          where() {
            return this;
          },
          executeTakeFirst: async () => ({ numUpdatedRows: 0n }),
        }),
      }),
    }) as unknown as TerminalizeDeps['db'];

  const expired = {
    ...facts(),
    id: 'queue-row-1',
    runId: 'run-1',
    jobName: '__globaleval__org/pipelines__abc',
  };

  it('settles the awaiting round when the queue declares the job unroutable', async () => {
    // Without this the orchestrator waits out its full ceiling for a job the
    // queue has already definitively failed — with the shipped defaults, a
    // 120s fast-fail followed by a 240s wait, twice.
    const tracker = new PendingGlobalEvalTracker();
    const settled = tracker.track('queue-row-1');
    const observed = settled.catch((err: Error) => err.message);

    await terminalizeUnroutableJob(
      {
        db: zeroRowDb(),
        executionTracker: {} as TerminalizeDeps['executionTracker'],
        canRouteLabels: () => false,
        pendingGlobalEvals: tracker,
      },
      expired,
    );

    await expect(observed).resolves.toContain('runsOn [linux, gpu]');
    expect(tracker.size).toBe(0);
  });

  it('is a no-op for a job id nothing is tracking', async () => {
    const tracker = new PendingGlobalEvalTracker();
    tracker.track('some-other-job').catch(() => {});
    await terminalizeUnroutableJob(
      {
        db: zeroRowDb(),
        executionTracker: {} as TerminalizeDeps['executionTracker'],
        canRouteLabels: () => false,
        pendingGlobalEvals: tracker,
      },
      expired,
    );
    expect(tracker.size).toBe(1);
  });
});
