/**
 * Org global workflows route through the Tier-2 eval round instead of dropping
 * their dynamic jobs.
 *
 * The defect this suite guards: a global workflow whose jobs a `DynamicJobFn`
 * produces must dispatch those jobs, not nothing at all — no error, no skipped
 * job, no trace. A workflow-level `filter` must be evaluated, or a global that
 * declared it applies to no source repo runs anyway.
 *
 * Both org-global paths are covered, because they are separate call sites that
 * have diverged before: `tryDispatchGlobalsWithoutLockFile` (Phase F, no lock
 * file resolves for the source repo) and `dispatchGlobalWorkflowsForOtherRepos`
 * (Phase J, a lock file did resolve). Both are module-private, so they are
 * driven end-to-end through `processWebhook`.
 */
import { describe, it, expect, vi } from 'vitest';
import { dispatchGlobalWorkflowsForOtherRepos, processWebhook } from './process-webhook.js';
import { ROUND_JOB_PREFIX } from './global-eval-round.js';
import { webhookPayloadPath } from './webhook-payload-store.js';
import type { WebhookInfo } from '../webhook/handler.js';
import { ExecutionRunStatus, HoldScope, TraceCheck, TriggerSource } from '@kici-dev/engine';
import { resumeWorkflow, rejectWorkflow } from './resume-workflow.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import { cancelRunWithReason } from '../cancel/cancel-run.js';
import { ExecutionTracker } from '../reporting/execution-tracker.js';
import type { GlobalEvalRoundResult, LockJob } from '@kici-dev/engine';
import { AgentCapabilityFlag, GLOBAL_EVAL_SKIPS_RESULT_AWARE_LABEL } from '@kici-dev/engine';
import { dispatchGlobalCandidateViaPipeline } from './global-dispatch.js';

// A pass-through spy: every global dispatch still runs the real pipeline, and a
// test can read the exact job list a candidate handed it.
vi.mock('./global-dispatch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./global-dispatch.js')>();
  return {
    ...actual,
    dispatchGlobalCandidateViaPipeline: vi.fn(actual.dispatchGlobalCandidateViaPipeline),
  };
});

const SOURCE_REPO = 'acme/app';
const GLOBAL_REPO = 'acme/org-workflows';
const GLOBAL_WORKFLOW = 'org-ci';
/** A dot-prefixed source repo — an identifier picomatch's default '**' skips. */
const DOT_SOURCE_REPO = '.hidden/app';

function makeInfo(sourceRepo: string = SOURCE_REPO): WebhookInfo {
  return {
    routingKey: 'github:1',
    deliveryId: `d-${Math.random().toString(36).slice(2)}`,
    event: 'push',
    provider: 'github',
    payload: { repository: { full_name: sourceRepo } },
  } as unknown as WebhookInfo;
}

/** A static lock job that needs no eval round. */
function staticJob(name: string): LockJob {
  return {
    _type: 'static',
    name,
    runsOn: [{ kind: 'exact', value: 'default' }],
    needs: [],
    steps: [{ name: 'run', hasOutputs: false }],
  } as unknown as LockJob;
}

/** A static lock job carrying a static matrix, so it materializes into children. */
function matrixJob(name: string, values: Record<string, unknown[]>): LockJob {
  return { ...staticJob(name), matrix: { _type: 'static', values } } as unknown as LockJob;
}

/** A `DynamicJobFn` entry — the shape the drop used to discard. */
function dynamicEntry() {
  return { _type: 'dynamic' as const, source: { file: '.kici/workflows/org.ts', index: 0 } };
}

/** A result-aware `DynamicJobFn` entry: deferred until `build` completes. */
function resultAwareEntry() {
  return {
    _type: 'dynamic' as const,
    source: { file: '.kici/workflows/org.ts', index: 1 },
    needs: ['build'],
    resultAware: true,
  };
}

/** The job list handed to the pipeline, one entry per global candidate, in order. */
function pipelineWorkflows(): Array<{ name: string; jobs: Array<Record<string, unknown>> }> {
  return vi.mocked(dispatchGlobalCandidateViaPipeline).mock.calls.map((call) => ({
    name: call[0].resolved.candidate.lockEntry.name,
    jobs: [...call[0].resolved.jobs] as unknown as Array<Record<string, unknown>>,
  }));
}

/**
 * A global workflow registration in ANOTHER repo, triggering on push.
 *
 * `jobs` and `hasFilter` are the two knobs the partition reads: a workflow
 * carrying either a dynamic entry or a filter needs the round, everything else
 * dispatches straight from the lock file.
 */
function makeGlobalRegistration(over: {
  jobs?: unknown[];
  hasFilter?: boolean;
  name?: string;
  id?: string;
  /** Tier-1 `requires` on the push trigger, evaluated before the round. */
  requires?: unknown[];
  /** `repos` patterns on the push trigger, deciding which source repos apply. */
  repos?: Array<{ type: 'glob' | 'regex'; pattern: string }>;
  /** The registration's own routing key. Differs from the inbound one when the
   * workflow repo lives behind another provider. */
  routingKey?: string;
  /** The repository that defines the workflow. */
  repoIdentifier?: string;
  /** Disabled in the dashboard; the index filters it like the real one. */
  disabled?: boolean;
}) {
  return {
    id: over.id ?? 'reg-global-1',
    routingKey: over.routingKey ?? 'github:1',
    repoIdentifier: over.repoIdentifier ?? GLOBAL_REPO,
    workflowName: over.name ?? GLOBAL_WORKFLOW,
    triggerTypes: ['push'],
    isGlobal: true,
    disabled: over.disabled ?? false,
    commitSha: 'globalsha',
    defaultBranch: 'trunk',
    sourceFile: '.kici/workflows/org.ts',
    lockEntry: {
      name: over.name ?? GLOBAL_WORKFLOW,
      contentHash: 'ghash',
      compileSchemaVersion: 1,
      triggers: [
        {
          _type: 'push',
          branches: [],
          paths: [],
          ...(over.requires === undefined ? {} : { requires: over.requires }),
          ...(over.repos === undefined ? {} : { repos: over.repos }),
        },
      ],
      jobs: over.jobs ?? [staticJob('scan')],
      ...(over.hasFilter === undefined ? {} : { hasFilter: over.hasFilter }),
    },
  };
}

interface TraceLine {
  matched: boolean;
  summary: string;
  checks: Array<{ check: string; passed: boolean; value?: string; pattern?: string }>;
}

/** The aggregated one-per-delivery line naming every `repos`-filtered drop. */
interface ReposDropLine {
  deliveryId: string;
  sourceRepo: string;
  droppedCount: number;
  dropped: Array<{ workflow: string; workflowRepo: string; repos: string }>;
}

/**
 * Capture the orchestrator's own log lines for the duration of a call.
 *
 * Winston's Console transport writes to `console._stdout` when Node exposes it
 * and to `process.stdout` otherwise, so both are covered — spying on
 * `process.stdout` alone silently records nothing under vitest and the
 * assertion reads as "the line was never emitted".
 */
function captureLogLines() {
  const lines: string[] = [];
  const stream = (console as unknown as { _stdout?: NodeJS.WriteStream })._stdout ?? process.stdout;
  const write = vi.spyOn(stream, 'write').mockImplementation((chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  });
  return {
    restore: () => write.mockRestore(),
    /** The decision trace, parsed. Throws (failing the test) when absent. */
    findTrace(): TraceLine {
      const line = lines.find((l) => l.includes('Global workflow decision trace'));
      if (line === undefined) {
        throw new Error(`no decision trace emitted; saw ${lines.length} log line(s)`);
      }
      return JSON.parse(line) as TraceLine;
    },
    /** The aggregated repos-drop line, parsed. Throws (failing) when absent. */
    findReposDrops(): ReposDropLine {
      const line = lines.find((l) => l.includes('Global workflows dropped by their repos filter'));
      if (line === undefined) {
        throw new Error(`no repos-drop line emitted; saw ${lines.length} log line(s)`);
      }
      return JSON.parse(line) as ReposDropLine;
    },
    /** How many times the aggregated repos-drop line was emitted. */
    countReposDropLines(): number {
      return lines.filter((l) => l.includes('Global workflows dropped by their repos filter'))
        .length;
    },
  };
}

interface Harness {
  deps: Parameters<typeof processWebhook>[1];
  /** The inbound event's provider bundle — the one the scoped pass posts through. */
  bundle: Record<string, any>;
  dispatch: ReturnType<typeof vi.fn>;
  track: ReturnType<typeof vi.fn>;
  /** The errored-run writer for a round that produced no verdicts. */
  recordRoundFailure: ReturnType<typeof vi.fn>;
  /** Object-storage writes — how a failed round's webhook payload is persisted. */
  append: ReturnType<typeof vi.fn>;
  /** The `execution_runs` writer for a dispatched candidate. */
  onExecutionStarted: ReturnType<typeof vi.fn>;
  /** The post-dispatch job registration. */
  addJobsToRun: ReturnType<typeof vi.fn>;
  /** Per-job status writes — how a rejected job is marked failed. */
  onJobStatus: ReturnType<typeof vi.fn>;
  /** The pending-jobs token that holds the run open across the dispatch loop. */
  holdRunForPendingJobs: ReturnType<typeof vi.fn>;
  /** The paired release of that token. */
  releasePendingJobsHold: ReturnType<typeof vi.fn>;
  /** The terminalizer for a run whose dispatch threw. */
  failRun: ReturnType<typeof vi.fn>;
  /** The dedicated failed-round commit check. */
  postGlobalEvalFailedCheck: ReturnType<typeof vi.fn>;
  /**
   * Every tracker and dispatcher call in the order they happened, as
   * `'run-start'` / `'dispatch:<jobName>'` / `'add-jobs'`. The run row has to be
   * written BEFORE the jobs are queued, and only an ordered trace can show it.
   */
  callOrder: string[];
  /** Every job input handed to the dispatcher, in dispatch order. */
  dispatched: () => Array<Record<string, any>>;
  /** Dispatched jobs excluding the eval-round job itself. */
  workJobs: () => Array<Record<string, any>>;
  /** The decision summaries carried by the started `execution.event`. */
  forwardedDecisions: () => Array<Record<string, any>>;
}

/**
 * Deps that reach the org-global paths.
 *
 * With `withLockFile: false` the bundle has no `lockFileFetcher`, so no lock
 * file resolves for the source repo and `processWebhook` takes Phase F. With
 * `withLockFile: true` a lock file resolves that declares only a `pr` workflow
 * — which cannot match this push — so any dispatch observed came from the
 * Phase J org-global path.
 */
function makeDeps(over: {
  registrations: ReturnType<typeof makeGlobalRegistration>[];
  roundResult?: GlobalEvalRoundResult;
  withLockFile?: boolean;
  /** Omit the pending-eval tracker entirely (older / hand-built deps). */
  withoutTracker?: boolean;
  /** Make the dispatcher throw for this job name (an infrastructure fault). */
  failDispatchOn?: string;
  /**
   * Make the dispatcher REJECT these job names, as a full queue does. Distinct
   * from `failDispatchOn`: a throw propagates, a rejection is a value the
   * caller has to account for.
   */
  rejectDispatchOn?: string[];
  /** Make every round attempt fail, as a wedged or vanished agent would. */
  roundFails?: boolean;
  /** Attach an execution tracker so the errored run row can be observed. */
  withExecutionTracker?: boolean;
  /**
   * Extra provider bundles keyed by routing key, for the cross-provider case
   * where the workflow repo does not live behind the event's provider. Any key
   * not listed here resolves to the inbound bundle, as before.
   */
  bundleByRoutingKey?: Record<string, unknown>;
  /** The repo the event came from. Defaults to `acme/app`. */
  sourceRepo?: string;
  /**
   * The normalized event's two branches. They are equal by default, which is
   * the push case; a caller sets them apart to tell which of the two a code
   * path actually reads.
   */
  branches?: { targetBranch: string; sourceBranch: string };
}): Harness {
  const sourceRepo = over.sourceRepo ?? SOURCE_REPO;
  const branches = over.branches ?? { targetBranch: 'main', sourceBranch: 'main' };
  const callOrder: string[] = [];
  const dispatch = vi.fn(async (input: Record<string, any>) => {
    callOrder.push(`dispatch:${input.jobName}`);
    if (over.failDispatchOn !== undefined && input.jobName === over.failDispatchOn) {
      throw new Error(`dispatch exploded for ${input.jobName}`);
    }
    if (over.rejectDispatchOn?.includes(String(input.jobName))) {
      return { status: 'rejected', reason: 'queue full' };
    }
    return { status: 'queued', jobId: `job-${input.jobName}` };
  });
  const track = vi.fn(async () => {
    if (over.roundFails) throw new Error('agent gone');
    return over.roundResult ?? { candidates: [] };
  });
  const recordRoundFailure = vi.fn(async () => undefined);
  const append = vi.fn(async () => undefined);
  const onExecutionStarted = vi.fn(async () => {
    callOrder.push('run-start');
  });
  const addJobsToRun = vi.fn(async () => {
    callOrder.push('add-jobs');
  });
  const onJobStatus = vi.fn(async (_runId: string, jobId: string, state: string) => {
    callOrder.push(`job-status:${jobId}:${state}`);
  });
  const holdRunForPendingJobs = vi.fn((_runId: string) => {
    callOrder.push('hold');
    return true;
  });
  const releasePendingJobsHold = vi.fn(async () => {
    callOrder.push('release');
  });
  const failRun = vi.fn(async () => {
    callOrder.push('fail-run');
  });
  const postGlobalEvalFailedCheck = vi.fn(async () => undefined);

  const bundle = {
    normalizer: {
      provider: 'github',
      normalizeEvent: () => ({
        type: 'push',
        payload: {},
        targetBranch: branches.targetBranch,
        sourceBranch: branches.sourceBranch,
        senderUsername: 'octocat',
        provider: 'github',
      }),
      extractRef: () => 'headsha',
      extractRepoIdentifier: () => sourceRepo,
      extractCredentials: () => ({ token: 'src-token' }),
      isDefaultBranchPush: () => false,
    },
    checkStatusPoster: {
      provider: 'github',
      postCheckStatus: vi.fn(),
      postGlobalEvalFailedCheck,
    },
    lockFileFetcher: over.withLockFile ? { fetchLockFile: vi.fn() } : undefined,
    repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://example.invalid/${repo}.git` },
  };

  const platformSend = vi.fn();
  const deps = {
    dedup: { claim: vi.fn(async () => true), exists: vi.fn(), mark: vi.fn(), cleanup: vi.fn() },
    logStorage: { append },
    platformClient: { send: platformSend },
    providerRegistry: {
      getByRoutingKey: (key: string) => over.bundleByRoutingKey?.[key] ?? bundle,
      getAll: () => [],
    },
    orchestratorMode: 'platform',
    registrationIndex: {
      refreshIfNeeded: vi.fn(async () => undefined),
      // Filters disabled rows the way the real index does.
      getGlobalByOrgAndTriggerType: () => over.registrations.filter((reg) => !reg.disabled),
      getByOrgAndRepo: (_org: string, repo: string) =>
        over.registrations.filter((reg) => reg.repoIdentifier === repo && !reg.disabled),
      getAllByOrgAndRepo: (_org: string, repo: string) =>
        over.registrations.filter((reg) => reg.repoIdentifier === repo),
      getByRepo: () => [],
      getByOrgAndEvent: () => [],
    },
    dispatcher: { dispatch },
    ...(over.withoutTracker ? {} : { pendingGlobalEvals: { track, cleanup: vi.fn() } }),
    ...(over.withExecutionTracker
      ? {
          executionTracker: {
            recordGlobalEvalRoundFailureRun: recordRoundFailure,
            onExecutionStarted,
            addJobsToRun,
            onJobStatus,
            holdRunForPendingJobs,
            releasePendingJobsHold,
            failRun,
          },
        }
      : {}),
    lockFileCache: {
      get: vi.fn(async () =>
        over.withLockFile
          ? {
              schemaVersion: 34,
              source: { file: '.kici/workflows/ci.ts', export: '#default' },
              contentHash: 'srchash',
              workflows: [
                {
                  name: 'src-pr-only',
                  contentHash: 'shash',
                  compileSchemaVersion: 1,
                  triggers: [
                    {
                      _type: 'pr',
                      events: ['opened'],
                      targetBranches: [],
                      sourceBranches: [],
                      paths: [],
                    },
                  ],
                  jobs: [],
                },
              ],
            }
          : null,
      ),
    },
  } as unknown as Parameters<typeof processWebhook>[1];

  const dispatched = () => dispatch.mock.calls.map((c) => c[0] as Record<string, any>);
  return {
    deps,
    bundle,
    dispatch,
    track,
    recordRoundFailure,
    append,
    onExecutionStarted,
    addJobsToRun,
    onJobStatus,
    holdRunForPendingJobs,
    releasePendingJobsHold,
    failRun,
    postGlobalEvalFailedCheck,
    callOrder,
    dispatched,
    workJobs: () => dispatched().filter((d) => !String(d.jobName).startsWith(ROUND_JOB_PREFIX)),
    /** The decision summaries carried by the started `execution.event`. */
    forwardedDecisions: (): Array<Record<string, any>> => {
      const started = platformSend.mock.calls
        .map((call) => call[0] as Record<string, any>)
        .find((msg) => msg.type === 'execution.event' && msg.event === 'started');
      return (started?.data?.decisions ?? []) as Array<Record<string, any>>;
    },
  };
}

describe('org global workflows route dynamic jobs through the eval round', () => {
  it('dispatches a static-only global straight from the lock file, with no round', async () => {
    // The non-vacuity control for every case below: the same harness dispatches
    // a real job when nothing needs a round, so an empty `workJobs()` elsewhere
    // is about the round's verdict and not about a harness that never
    // dispatches. It is also the guard that the immediate path stayed
    // byte-identical to the pre-round behaviour.
    const h = makeDeps({ registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')] })] });

    await processWebhook(makeInfo(), h.deps);

    expect(h.dispatched().map((d) => d.jobName)).toEqual(['scan']);
    expect(h.track).not.toHaveBeenCalled();
  });

  it("builds a global job's workflow clone URL from the registration bundle, not the event bundle", async () => {
    // The workflow repo lives behind another provider than the event's source
    // repo. Asking the event's URL builder for it yields a host that does not
    // serve that repo, and the agent's dual checkout dies on it.
    const h = makeDeps({
      registrations: [
        makeGlobalRegistration({ jobs: [staticJob('scan')], routingKey: 'gitlab:9' }),
      ],
      bundleByRoutingKey: {
        'gitlab:9': {
          repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://gitlab.invalid/${repo}.git` },
        },
      },
    });

    await processWebhook(makeInfo(), h.deps);

    const job = h.workJobs()[0];
    expect(job.jobConfig.workflowRepoUrl).toBe(`https://gitlab.invalid/${GLOBAL_REPO}.git`);
    // The source repo still clones from the EVENT's bundle — do not swap both.
    expect(job.repoUrl).toBe(`https://example.invalid/${SOURCE_REPO}.git`);
  });

  it('dispatches generated jobs for a global workflow with a DynamicJobFn', async () => {
    // The correctness fix: this workflow's only entry is a `DynamicJobFn`, which
    // the static-only drop discarded outright — it dispatched nothing at all.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult: {
        candidates: [
          {
            workflowName: GLOBAL_WORKFLOW,
            run: true,
            jobs: [staticJob('gen-a'), staticJob('gen-b')],
          },
        ],
      } as GlobalEvalRoundResult,
    });

    await processWebhook(makeInfo(), h.deps);

    expect(h.workJobs().map((d) => d.jobName)).toEqual(['gen-a', 'gen-b']);
  });

  it('dispatches one eval-round job and never a dynamicJobFn job for a global', async () => {
    // The falsifiable form of "a global's generator does not take the per-repo
    // dynamic-eval path": assert over the wired dispatch, where a `dynamicJobFn`
    // job COULD be observed, rather than over a module that cannot emit one.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true, jobs: [staticJob('gen-a')] }],
      } as GlobalEvalRoundResult,
    });

    await processWebhook(makeInfo(), h.deps);

    const round = h.dispatched().filter((d) => String(d.jobName).startsWith(ROUND_JOB_PREFIX));
    expect(round).toHaveLength(1);
    expect(round[0].jobConfig.globalEvalRound).toBe(true);
    expect(round[0].jobConfig.isGlobalWorkflow).toBe(true);
    // Positive control on the negative below: the round job's config is
    // readable and populated, so an absent `dynamicJobFn` means absent.
    expect(round[0].jobConfig.candidates).toHaveLength(1);
    expect(h.dispatched().some((d) => d.jobConfig?.dynamicJobFn === true)).toBe(false);
  });

  it('dispatches static and generated jobs together for a mixed global workflow', async () => {
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('lint'), dynamicEntry()] })],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true, jobs: [staticJob('gen-a')] }],
      } as GlobalEvalRoundResult,
    });

    await processWebhook(makeInfo(), h.deps);

    expect(h.workJobs().map((d) => d.jobName)).toEqual(['lint', 'gen-a']);
  });

  it('dispatches nothing for a global workflow whose filter returned false', async () => {
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')], hasFilter: true })],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: false }],
      } as GlobalEvalRoundResult,
    });

    await processWebhook(makeInfo(), h.deps);

    // The round job itself dispatched — the filter was genuinely evaluated —
    // and the workflow's own static job did not.
    expect(h.track).toHaveBeenCalledTimes(1);
    expect(h.workJobs()).toEqual([]);
  });

  it('explains a filter exclusion in a decision trace', async () => {
    // A `filter` runs on an agent and returns nothing but a boolean, so its
    // exclusion leaves no run, no check, and no artifact — the author sees
    // nothing happen and has no way to ask why. The trace is that answer.
    const lines = captureLogLines();
    try {
      const h = makeDeps({
        registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')], hasFilter: true })],
        roundResult: {
          candidates: [
            { workflowName: GLOBAL_WORKFLOW, run: false, reason: 'filter returned false' },
          ],
        } as GlobalEvalRoundResult,
      });

      await processWebhook(makeInfo(), h.deps);
    } finally {
      lines.restore();
    }

    const parsed = lines.findTrace();
    expect(parsed.matched).toBe(false);
    expect(parsed.summary).toBe('filter returned false');
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({ check: 'filter', passed: false }),
    );
    // Positive control: the trigger checks that DID pass are in the same trace,
    // so the entry above is an addition rather than the whole record.
    expect(parsed.checks.some((c) => c.passed)).toBe(true);
  });

  it('traces an unevaluable requires as indeterminate, not as an exclusion', async () => {
    // The harness bundle carries no file-contents fetcher, so the Tier-1
    // requirement cannot be read at all. That is an infrastructure gap, not the
    // author's requirement saying no — and a trace that renders it as
    // "excluded" tells the author their filter rejected the commit when nothing
    // ever looked at it.
    const lines = captureLogLines();
    try {
      const h = makeDeps({
        registrations: [
          makeGlobalRegistration({
            jobs: [staticJob('scan')],
            requires: [{ file: 'package.json', format: 'json', exists: ['$.scripts.ci'] }],
          }),
        ],
      });

      await processWebhook(makeInfo(), h.deps);

      // The workflow really was suppressed — nothing dispatched.
      expect(h.workJobs()).toEqual([]);
    } finally {
      lines.restore();
    }

    const parsed = lines.findTrace();
    const requires = parsed.checks.find((c) => c.check === 'requires');
    expect(requires).toBeDefined();
    expect(requires).toMatchObject({ value: 'indeterminate', passed: false });
    // The distinction under test: this is NOT the definite-negative rendering.
    expect(requires?.value).not.toBe('excluded');
  });

  it('dispatches a filter-declaring global whose filter returned true', async () => {
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')], hasFilter: true })],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true }],
      } as GlobalEvalRoundResult,
    });

    await processWebhook(makeInfo(), h.deps);

    expect(h.workJobs().map((d) => d.jobName)).toEqual(['scan']);
  });

  it('dispatches nothing when the round reports the candidate indeterminate', async () => {
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult: {
        candidates: [
          { workflowName: GLOBAL_WORKFLOW, run: false, indeterminate: true, reason: 'boom' },
        ],
      } as GlobalEvalRoundResult,
    });

    await processWebhook(makeInfo(), h.deps);

    // The round ran — without this line the empty `workJobs()` would also be
    // what the immediate path produces for this fixture (a dynamic-only
    // workflow has no static jobs), so the assertion would not distinguish
    // "declined by the round" from "never routed to the round". Twice, because
    // a round whose every candidate is undecided is a failure and gets the
    // group's one retry.
    expect(h.track).toHaveBeenCalledTimes(2);
    expect(h.workJobs()).toEqual([]);
  });

  it('dispatches nothing when the round returns no verdict for the candidate', async () => {
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult: { candidates: [] } as GlobalEvalRoundResult,
    });

    await processWebhook(makeInfo(), h.deps);

    // Same reason as the case above: prove the round ran before reading
    // anything into an empty dispatch list. Twice for the same reason — a
    // round that reported on no candidate at all decided nothing.
    expect(h.track).toHaveBeenCalledTimes(2);
    expect(h.workJobs()).toEqual([]);
  });

  it('fails closed when no pending-eval tracker is wired', async () => {
    // Without the tracker the round can never settle, so a workflow whose
    // `filter` was never evaluated must not dispatch anyway.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')], hasFilter: true })],
      withoutTracker: true,
    });

    await processWebhook(makeInfo(), h.deps);

    expect(h.dispatched()).toEqual([]);
  });

  it('does not mutate the jobs the round handed back', async () => {
    // The round result is handed over BY REFERENCE — a cache hit returns the
    // stored object as-is — so a mutation on the way into the dispatch build
    // would be replayed on the next webhook redelivery.
    const generated = staticJob('gen-a');
    const roundResult = {
      candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true, jobs: [generated] }],
    } as GlobalEvalRoundResult;
    const before = structuredClone(roundResult);

    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult,
    });

    await processWebhook(makeInfo(), h.deps);

    // Positive control: the dispatch really happened, so the equality below is
    // asserted over a result the pipeline actually consumed.
    expect(h.workJobs().map((d) => d.jobName)).toEqual(['gen-a']);
    expect(roundResult).toEqual(before);
  });

  it('survives a malformed generated job without failing the whole delivery', async () => {
    // A generated job is proven only to carry a usable `name`; a bad label
    // matcher still throws at materialize time. It must take down its own
    // workflow, never the sibling global in the same delivery.
    const broken = { _type: 'static', name: 'broken', runsOn: ['default'] } as unknown as LockJob;
    const h = makeDeps({
      registrations: [
        makeGlobalRegistration({ id: 'reg-a', name: 'org-dyn', jobs: [dynamicEntry()] }),
        makeGlobalRegistration({ id: 'reg-b', name: 'org-static', jobs: [staticJob('scan')] }),
      ],
      roundResult: {
        candidates: [{ workflowName: 'org-dyn', run: true, jobs: [broken] }],
      } as GlobalEvalRoundResult,
    });

    await processWebhook(makeInfo(), h.deps);

    expect(h.workJobs().map((d) => d.jobName)).toEqual(['scan']);
  });

  it('records the build failure in the trace rather than omitting the workflow', async () => {
    // A workflow that matched, failed to materialize, and then went missing
    // from the delivery's trace reproduces exactly the indistinguishability the
    // trace exists to remove: its author cannot tell it apart from one that was
    // never registered.
    const broken = { _type: 'static', name: 'broken', runsOn: ['default'] } as unknown as LockJob;
    const h = makeDeps({
      registrations: [
        makeGlobalRegistration({ id: 'reg-a', name: 'org-dyn', jobs: [dynamicEntry()] }),
        makeGlobalRegistration({ id: 'reg-b', name: 'org-static', jobs: [staticJob('scan')] }),
      ],
      roundResult: {
        candidates: [{ workflowName: 'org-dyn', run: true, jobs: [broken] }],
      } as GlobalEvalRoundResult,
    });

    await processWebhook(makeInfo(), h.deps);

    const decisions = h.forwardedDecisions();
    // Positive control: the sibling that DID dispatch is in the trace, so the
    // entry asserted below is being read out of a populated array.
    expect(decisions.map((d) => d.workflowName)).toContain('org-static');

    const failed = decisions.find((d) => d.workflowName === 'org-dyn');
    expect(failed).toBeDefined();
    expect(failed?.matched).toBe(false);
    expect(failed?.checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: 'dispatch', passed: false })]),
    );
  });

  it('propagates a dispatcher failure on a round-cleared workflow', async () => {
    // The catch is bounded to the BUILD. A dispatcher throw — a wedged queue, a
    // database error — is an infrastructure fault, and swallowing it here would
    // leave `gen-a` queued under a run id that never reaches `matchedRunIds`,
    // never reaches the event log, and can never complete. It must fail the
    // delivery, which records it as `failed` in the event log. Not so the
    // provider retries: `dedup.claim` already holds this delivery id, so a
    // redelivery of the same id is dropped as a duplicate.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult: {
        candidates: [
          {
            workflowName: GLOBAL_WORKFLOW,
            run: true,
            jobs: [staticJob('gen-a'), staticJob('gen-b')],
          },
        ],
      } as GlobalEvalRoundResult,
      failDispatchOn: 'gen-b',
    });

    await expect(processWebhook(makeInfo(), h.deps)).rejects.toThrow(/dispatch exploded/);
    // Positive control: the throw happened at DISPATCH time, on the second job —
    // the first one really was dispatched, so the build succeeded and this is
    // not the build-catch path in disguise.
    expect(h.workJobs().map((d) => d.jobName)).toEqual(['gen-a', 'gen-b']);
  });

  it('propagates a malformed lock-file job on the immediate path', async () => {
    // Positive control for the case above, and the record of what the immediate
    // path does today: the SAME malformed job dispatched without a round
    // genuinely rejects out of `processWebhook`. So the round path completing
    // cleanly is the round-only catch doing its job, not an exception the
    // pipeline swallows somewhere else.
    const broken = { _type: 'static', name: 'broken', runsOn: ['default'] } as unknown as LockJob;
    const h = makeDeps({ registrations: [makeGlobalRegistration({ jobs: [broken] })] });

    await expect(processWebhook(makeInfo(), h.deps)).rejects.toThrow(/invalid label matcher/);
  });

  it('routes a global through the round on the lock-file path too (Phase J)', async () => {
    // Phase F and Phase J are separate call sites that have diverged before, so
    // the wiring is asserted independently on each.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true, jobs: [staticJob('gen-a')] }],
      } as GlobalEvalRoundResult,
      withLockFile: true,
    });

    await processWebhook(makeInfo(), h.deps);

    expect(h.track).toHaveBeenCalledTimes(1);
    expect(h.workJobs().map((d) => d.jobName)).toEqual(['gen-a']);
  });

  it('dispatches nothing on the lock-file path when the filter returned false', async () => {
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')], hasFilter: true })],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: false }],
      } as GlobalEvalRoundResult,
      withLockFile: true,
    });

    await processWebhook(makeInfo(), h.deps);

    expect(h.track).toHaveBeenCalledTimes(1);
    expect(h.workJobs()).toEqual([]);
  });

  it('records one errored run and one check for a round that failed, naming every candidate', async () => {
    // Two candidates in ONE round (same workflow repo, sha, and routing key), so
    // "one row" is falsifiable: a per-candidate implementation would write two.
    const h = makeDeps({
      registrations: [
        makeGlobalRegistration({ jobs: [dynamicEntry()], name: 'org-ci', id: 'reg-1' }),
        makeGlobalRegistration({ jobs: [dynamicEntry()], name: 'org-lint', id: 'reg-2' }),
      ],
      roundFails: true,
      withExecutionTracker: true,
    });

    await processWebhook(makeInfo(), h.deps);

    // Positive control: the round really ran, and really retried — so the
    // records below describe a genuinely failed round.
    expect(h.track).toHaveBeenCalledTimes(2);

    expect(h.recordRoundFailure).toHaveBeenCalledTimes(1);
    const row = h.recordRoundFailure.mock.calls[0][0];
    expect(row.failureReason).toContain('org-ci');
    expect(row.failureReason).toContain('org-lint');
    expect(row.failureReason).toContain('agent gone');
    expect(row.workflowName).toBe(`${ROUND_JOB_PREFIX}${GLOBAL_REPO}`);
    expect(row.repoIdentifier).toBe(SOURCE_REPO);
    expect(row.sha).toBe('headsha');
    // The run id is the last attempt's round-job id, so the row, the queue row
    // and that attempt's logs all carry one id.
    expect(row.runId).toBe(h.dispatched()[h.dispatched().length - 1].runId);

    expect(h.postGlobalEvalFailedCheck).toHaveBeenCalledTimes(1);
    const [repo, sha, summary] = h.postGlobalEvalFailedCheck.mock.calls[0];
    expect(repo).toBe(SOURCE_REPO);
    expect(sha).toBe('headsha');
    expect(summary).toContain('org-lint');

    // And nothing ran: a round that produced no verdict clears no workflow.
    expect(h.workJobs()).toEqual([]);
  });

  it("stores the failed round's webhook payload under the round run id", async () => {
    // Re-running the errored round re-evaluates the original event, so the
    // payload the round was deciding on has to survive with its run row.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundFails: true,
      withExecutionTracker: true,
    });
    const info = makeInfo();

    await processWebhook(info, h.deps);

    const runId = h.recordRoundFailure.mock.calls[0][0].runId as string;
    expect(h.append).toHaveBeenCalledWith(webhookPayloadPath(runId), JSON.stringify(info.payload));
  });

  it('completes the delivery when the payload write for a failed round throws', async () => {
    // Best-effort like the row and the check: the round already failed, and
    // losing the delivery on top of that would take the event-log row with it.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundFails: true,
      withExecutionTracker: true,
    });
    h.append.mockRejectedValue(new Error('storage down'));

    await expect(processWebhook(makeInfo(), h.deps)).resolves.toBeDefined();
    expect(h.append).toHaveBeenCalled();
  });

  it('records the errored run and the check for a round that reported success but decided nothing', async () => {
    // The agent's round runner never throws on its own budget breach — it
    // returns `success` with every candidate padded `indeterminate`. Read as a
    // success that produces no row and no check, which is the failure mode most
    // likely to happen in production.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult: {
        candidates: [
          {
            workflowName: GLOBAL_WORKFLOW,
            run: false,
            indeterminate: true,
            reason: 'round budget exceeded',
          },
        ],
      } as GlobalEvalRoundResult,
      withExecutionTracker: true,
    });

    await processWebhook(makeInfo(), h.deps);

    // Positive control: the round genuinely completed twice (it did not throw),
    // so what follows is about how a decided-nothing success is read.
    expect(h.track).toHaveBeenCalledTimes(2);
    expect(h.recordRoundFailure).toHaveBeenCalledTimes(1);
    expect(h.recordRoundFailure.mock.calls[0][0].failureReason).toContain('round budget exceeded');
    expect(h.postGlobalEvalFailedCheck).toHaveBeenCalledTimes(1);
    expect(h.workJobs()).toEqual([]);
  });

  it('records nothing when every round succeeds', async () => {
    // The negative control for the case above: the same tracker and poster are
    // wired, so their silence here is about the round's outcome and not about a
    // harness that never observes them.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true, jobs: [staticJob('gen-a')] }],
      } as GlobalEvalRoundResult,
      withExecutionTracker: true,
    });

    await processWebhook(makeInfo(), h.deps);

    expect(h.workJobs().map((d) => d.jobName)).toEqual(['gen-a']);
    expect(h.recordRoundFailure).not.toHaveBeenCalled();
    expect(h.postGlobalEvalFailedCheck).not.toHaveBeenCalled();
  });

  it('still completes the delivery when the errored-run write itself fails', async () => {
    // The round already failed and its workflows are already recorded
    // indeterminate. Losing the delivery on top of that would take the
    // event-log row with it, so both records are best-effort.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundFails: true,
      withExecutionTracker: true,
    });
    h.recordRoundFailure.mockRejectedValue(new Error('db down'));
    h.postGlobalEvalFailedCheck.mockRejectedValue(new Error('403 Forbidden'));

    await expect(processWebhook(makeInfo(), h.deps)).resolves.toBeDefined();
    // Control: both really were attempted, so this is not a path that skipped
    // them.
    expect(h.recordRoundFailure).toHaveBeenCalledTimes(1);
    expect(h.postGlobalEvalFailedCheck).toHaveBeenCalledTimes(1);
  });
});

/**
 * An admitted cross-repo global workflow is a run, and must be visible as one.
 *
 * The defect this suite guards: jobs that execute while no `execution_runs` row
 * exists. Nothing keyed on a run could see them — not `runs list`, not `runs
 * jobs`, not the dashboard, not cancel — and `ExecutionTracker.onJobStatus`
 * discards every status they report, because `execution_jobs` carries a foreign
 * key onto `execution_runs`.
 *
 * Both dispatch paths are covered, because both go through the shared pipeline:
 * the immediate path (a candidate the lock file fully describes) and the
 * round-cleared path (a candidate a `filter` or a generator decided on).
 */
describe('an admitted cross-repo global workflow creates its run row', () => {
  /** Positional argument names of `ExecutionTracker.onExecutionStarted`. */
  const ARG = {
    runId: 0,
    workflowName: 1,
    provider: 2,
    repoIdentifier: 3,
    ref: 4,
    sha: 5,
    deliveryId: 6,
    triggerDecision: 8,
    jobs: 9,
    routingKey: 10,
    workflowRepo: 25,
  } as const;

  it('records the run against the SOURCE repo before dispatching its jobs', async () => {
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')] })],
      withExecutionTracker: true,
    });
    const info = makeInfo();

    await processWebhook(info, h.deps);

    // Control: the job really was dispatched, so what follows is about the run
    // row and not about a harness that dispatched nothing.
    expect(h.workJobs().map((d) => d.jobName)).toEqual(['scan']);

    expect(h.onExecutionStarted).toHaveBeenCalledTimes(1);
    const call = h.onExecutionStarted.mock.calls[0];
    // The run id is the one the jobs were queued under, or the row addresses a
    // run nothing will ever report against.
    expect(call[ARG.runId]).toBe(h.workJobs()[0].runId);
    expect(call[ARG.workflowName]).toBe(GLOBAL_WORKFLOW);
    // The SOURCE repo — the one that emitted the event and whose code the jobs
    // check out. The workflow's own repo travels in `jobConfig`, not here.
    expect(call[ARG.repoIdentifier]).toBe(SOURCE_REPO);
    expect(call[ARG.provider]).toBe('github');
    expect(call[ARG.ref]).toBe('main');
    expect(call[ARG.sha]).toBe('headsha');
    expect(call[ARG.deliveryId]).toBe(info.deliveryId);
    expect(call[ARG.routingKey]).toBe('github:1');
    // The trigger match that admitted this candidate, so the row explains why
    // it ran.
    expect(call[ARG.triggerDecision]).toBeTruthy();
    // No jobs at registration time: the dispatcher mints their ids.
    expect(call[ARG.jobs]).toEqual([]);
    // The repo that DEFINES the workflow — the one piece of the global
    // dispatch that `repo_identifier` cannot express, and the only thing a
    // rerun can use to tell this run from a per-repository one.
    // fails-when: the workflow repo's identifier, registered commit, or
    // registered default branch is dropped
    expect(call[ARG.workflowRepo]).toEqual({
      identifier: GLOBAL_REPO,
      sha: 'globalsha',
      branch: 'trunk',
    });
    expect(call[ARG.workflowRepo].identifier).not.toBe(call[ARG.repoIdentifier]);

    // Ordering is the whole point of registering with an empty job list — a
    // status arriving before the row exists is dropped and never retried. The
    // pending-jobs token brackets the dispatch window: taken once the row
    // exists, released once every job is registered.
    expect(h.callOrder).toEqual(['run-start', 'hold', 'dispatch:scan', 'add-jobs', 'release']);
    expect(h.addJobsToRun.mock.calls[0][0]).toBe(h.workJobs()[0].runId);
    // The same row shape a per-repository run registers: an unexpanded job
    // carries no `baseJobName` (a materialized child does, see below).
    expect(h.addJobsToRun.mock.calls[0][1]).toEqual([
      { jobId: 'job-scan', jobName: 'scan', runsOnLabels: ['default'] },
    ]);
  });

  it('records the presented branch on the run row, never the job checkout ref', async () => {
    // `execution_runs.ref` is the branch the run PRESENTS, which is what every
    // other `onExecutionStarted` caller writes and what the context branch gate
    // evaluates. The dispatched jobs carry a different value — the checkout ref,
    // which for a pull request is the head branch a fork contributor names
    // freely — and this row is read back as a branch claim by the internal-event
    // branch inheritance, so the two must not be confused.
    //
    // The two branches differ here, so the assertion can only hold if the
    // presented branch is what reaches the row.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')] })],
      withExecutionTracker: true,
      branches: { targetBranch: 'main', sourceBranch: 'attacker-names-this' },
    });

    await processWebhook(makeInfo(), h.deps);

    // Control: the job really was dispatched, and it really does carry the
    // other branch — so this is about which of two live values the row takes.
    expect(h.workJobs().map((d) => d.ref)).toEqual(['attacker-names-this']);
    expect(h.onExecutionStarted).toHaveBeenCalledTimes(1);
    expect(h.onExecutionStarted.mock.calls[0][ARG.ref]).toBe('main');
  });

  it('records the run for a candidate the eval round cleared', async () => {
    // The other half of the shared dispatch: a workflow whose jobs a generator
    // produced never touches the immediate path above.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true, jobs: [staticJob('gen-a')] }],
      } as GlobalEvalRoundResult,
      withExecutionTracker: true,
    });

    await processWebhook(makeInfo(), h.deps);

    expect(h.workJobs().map((d) => d.jobName)).toEqual(['gen-a']);
    expect(h.onExecutionStarted).toHaveBeenCalledTimes(1);
    const call = h.onExecutionStarted.mock.calls[0];
    expect(call[ARG.repoIdentifier]).toBe(SOURCE_REPO);
    expect(call[ARG.runId]).toBe(h.workJobs()[0].runId);
    // The round's own job is not a run and gets no row of its own.
    expect(h.callOrder.filter((c) => c === 'run-start')).toEqual(['run-start']);
    expect(h.callOrder.indexOf('run-start')).toBeLessThan(h.callOrder.indexOf('dispatch:gen-a'));
    expect(h.addJobsToRun.mock.calls[0][1]).toEqual([
      { jobId: 'job-gen-a', jobName: 'gen-a', runsOnLabels: ['default'] },
    ]);
  });

  it('tracks every rejected job, so an all-rejected run cannot hang pending', async () => {
    // The half-present run: with the run row written but a full queue rejecting
    // every job, dropping the rejections leaves a row with NO `execution_jobs`.
    // `isRunComplete` ends `run.jobs.size > 0` so it can never finish; the
    // stale-run detector scans from `execution_jobs` / `dispatch_queue` so it
    // never sees it; and cold-store archival needs a terminal status. It would
    // sit `pending` in `runs list` forever.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan'), staticJob('lint')] })],
      rejectDispatchOn: ['scan', 'lint'],
      withExecutionTracker: true,
    });

    await processWebhook(makeInfo(), h.deps);

    // Control: both really were attempted, so the assertions below are about
    // how a rejection is accounted for, not about a dispatch that never ran.
    expect(h.dispatched().map((d) => d.jobName)).toEqual(['scan', 'lint']);
    expect(h.onExecutionStarted).toHaveBeenCalledTimes(1);

    // Both are registered under synthetic ids — the run knows it has two jobs.
    expect(h.addJobsToRun).toHaveBeenCalledTimes(1);
    const registered = h.addJobsToRun.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(registered.map((j) => j.jobName)).toEqual(['scan', 'lint']);
    for (const job of registered) {
      expect(String(job.jobId)).toMatch(/^rejected-/);
    }

    // And both are driven terminal, which is what lets the run complete at all.
    expect(h.onJobStatus).toHaveBeenCalledTimes(2);
    for (const call of h.onJobStatus.mock.calls) {
      expect(call[1]).toBe(registered[h.onJobStatus.mock.calls.indexOf(call)].jobId);
      expect(call[2]).toBe('failed');
    }
    // Registration precedes the status writes, or the status has no row to hit.
    expect(h.callOrder.indexOf('add-jobs')).toBeLessThan(
      h.callOrder.findIndex((c) => c.startsWith('job-status:')),
    );
  });

  it('marks one rejected job failed instead of letting the run finish green without it', async () => {
    // The milder half of the same defect: dropping a single rejection lets the
    // remaining job carry the run to `success` with a job silently absent.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan'), staticJob('lint')] })],
      rejectDispatchOn: ['lint'],
      withExecutionTracker: true,
    });

    await processWebhook(makeInfo(), h.deps);

    const registered = h.addJobsToRun.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(registered.map((j) => j.jobName)).toEqual(['scan', 'lint']);
    // The accepted job keeps the dispatcher's own id; only the rejected one is
    // synthetic.
    expect(registered[0].jobId).toBe('job-scan');
    expect(String(registered[1].jobId)).toMatch(/^rejected-/);

    expect(h.onJobStatus).toHaveBeenCalledTimes(1);
    expect(h.onJobStatus.mock.calls[0][1]).toBe(registered[1].jobId);
    expect(h.onJobStatus.mock.calls[0][2]).toBe('failed');
  });

  it("carries a materialized child's base name and matrix values onto its job row", async () => {
    // `base_job_name` is the rolling-wave scheduler's grouping key, not a
    // display field — a NULL there makes the wave gate bail. Both values are
    // already in the job config the dispatch built, so the row can carry the
    // same identity a per-repository job row does.
    const h = makeDeps({
      registrations: [
        makeGlobalRegistration({ jobs: [matrixJob('scan', { os: ['linux', 'macos'] })] }),
      ],
      withExecutionTracker: true,
    });

    await processWebhook(makeInfo(), h.deps);

    // Control: the matrix really expanded, so this is about what the expansion
    // records and not about a job that never fanned out.
    const names = h.workJobs().map((d) => d.jobName);
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);

    const registered = h.addJobsToRun.mock.calls[0][1] as Array<Record<string, unknown>>;
    expect(registered).toHaveLength(2);
    for (const job of registered) {
      expect(job.baseJobName).toBe('scan');
      expect(job.matrixValues).toBeTruthy();
    }
    expect(registered.map((j) => (j.matrixValues as { os: string }).os)).toEqual([
      'linux',
      'macos',
    ]);
  });

  it('records no run for a candidate the round declined', async () => {
    // The negative control: the same tracker is wired, so its silence here is
    // about the verdict and not about a harness that never observes it.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()], hasFilter: true })],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: false, jobs: [] }],
      } as unknown as GlobalEvalRoundResult,
      withExecutionTracker: true,
    });

    await processWebhook(makeInfo(), h.deps);

    expect(h.workJobs()).toEqual([]);
    expect(h.onExecutionStarted).not.toHaveBeenCalled();
    expect(h.addJobsToRun).not.toHaveBeenCalled();
  });
});

describe('a global workflow dropped by its `repos` filter says so', () => {
  it('names the workflow, its repo, the patterns and the source repo', async () => {
    // Before this, the repo-glob drop was the ONE exclusion that emitted
    // nothing: a global workflow that never fired looked exactly like one that
    // was never registered, so the only way to tell them apart was to read the
    // org's lock files by hand.
    const lines = captureLogLines();
    try {
      const h = makeDeps({
        registrations: [
          makeGlobalRegistration({
            jobs: [staticJob('scan')],
            repos: [{ type: 'glob', pattern: 'other-org/*' }],
          }),
        ],
      });

      await processWebhook(makeInfo(), h.deps);

      // The workflow really was suppressed — nothing dispatched.
      expect(h.workJobs()).toEqual([]);
    } finally {
      lines.restore();
    }

    const parsed = lines.findReposDrops();
    expect(parsed.sourceRepo).toBe(SOURCE_REPO);
    expect(parsed.droppedCount).toBe(1);
    expect(parsed.dropped[0]).toMatchObject({
      workflow: GLOBAL_WORKFLOW,
      workflowRepo: GLOBAL_REPO,
    });
    // The declared pattern set travels with the drop, so the reader can see
    // what the repo was tested against without opening the lock file.
    expect(parsed.dropped[0].repos).toContain('other-org/*');
  });

  it('emits ONE line per delivery, however many globals were dropped', async () => {
    // The volume guard. A repo-scoped global drops on every delivery from every
    // repo it does not name, so this is the steady state rather than an
    // anomaly — a line per workflow would scale with the org's global count and
    // bury the per-workflow exclusions that do warrant their own line.
    const lines = captureLogLines();
    try {
      const h = makeDeps({
        registrations: [
          makeGlobalRegistration({
            id: 'reg-a',
            name: 'org-a',
            jobs: [staticJob('scan')],
            repos: [{ type: 'glob', pattern: 'other-org/*' }],
          }),
          makeGlobalRegistration({
            id: 'reg-b',
            name: 'org-b',
            jobs: [staticJob('scan')],
            repos: [{ type: 'glob', pattern: 'yet-another/*' }],
          }),
        ],
      });

      await processWebhook(makeInfo(), h.deps);

      expect(h.workJobs()).toEqual([]);
    } finally {
      lines.restore();
    }

    expect(lines.countReposDropLines()).toBe(1);
    const parsed = lines.findReposDrops();
    expect(parsed.droppedCount).toBe(2);
    expect(parsed.dropped.map((d) => d.workflow).sort()).toEqual(['org-a', 'org-b']);
  });

  it('emits no line for a global whose `repos` filter matches', async () => {
    // The non-vacuity control for both cases above: the same fixture with a
    // matching pattern dispatches and stays silent, so the line is about the
    // mismatch and not about a path that logs unconditionally.
    const lines = captureLogLines();
    let h!: Harness;
    try {
      h = makeDeps({
        registrations: [
          makeGlobalRegistration({
            jobs: [staticJob('scan')],
            repos: [{ type: 'glob', pattern: 'acme/*' }],
          }),
        ],
      });

      await processWebhook(makeInfo(), h.deps);
    } finally {
      lines.restore();
    }

    expect(h.workJobs().map((d) => d.jobName)).toEqual(['scan']);
    expect(lines.countReposDropLines()).toBe(0);
  });

  it('emits no line for a global that was dropped for some other reason', async () => {
    // A workflow excluded by `requires` gets the per-workflow decision trace,
    // not this line — the two reports must not double-report one drop.
    const lines = captureLogLines();
    try {
      const h = makeDeps({
        registrations: [
          makeGlobalRegistration({
            jobs: [staticJob('scan')],
            repos: [{ type: 'glob', pattern: 'acme/*' }],
            requires: [{ file: 'package.json', format: 'json', exists: ['$.scripts.ci'] }],
          }),
        ],
      });

      await processWebhook(makeInfo(), h.deps);

      expect(h.workJobs()).toEqual([]);
    } finally {
      lines.restore();
    }

    expect(lines.countReposDropLines()).toBe(0);
    // Control: the drop really was reported, just on the other line.
    expect(
      lines.findTrace().checks.find((c) => c.check === TraceCheck.ContentRequirements),
    ).toBeDefined();
  });

  it("dispatches for a dot-prefixed source repo under `repos: ['**']`", async () => {
    // The end-to-end shape of the matcher fix: an org-wide global declares
    // every repo, and the event comes from a dot-prefixed identifier. Under
    // picomatch's default that identifier did not match `**`, so the workflow
    // silently never ran for that repo.
    const h = makeDeps({
      sourceRepo: DOT_SOURCE_REPO,
      registrations: [
        makeGlobalRegistration({
          jobs: [staticJob('scan')],
          repos: [{ type: 'glob', pattern: '**' }],
        }),
      ],
    });

    await processWebhook(makeInfo(DOT_SOURCE_REPO), h.deps);

    expect(h.workJobs().map((d) => d.jobName)).toEqual(['scan']);
  });

  it('still drops a dot-prefixed source repo that no pattern names', async () => {
    // The control for the case above: `dot: true` widened `**`, it did not
    // make every pattern match everything.
    const lines = captureLogLines();
    let h!: Harness;
    try {
      h = makeDeps({
        sourceRepo: DOT_SOURCE_REPO,
        registrations: [
          makeGlobalRegistration({
            jobs: [staticJob('scan')],
            repos: [{ type: 'glob', pattern: 'acme/*' }],
          }),
        ],
      });

      await processWebhook(makeInfo(DOT_SOURCE_REPO), h.deps);
    } finally {
      lines.restore();
    }

    expect(h.workJobs()).toEqual([]);
    expect(lines.findReposDrops().sourceRepo).toBe(DOT_SOURCE_REPO);
  });
});

/**
 * A global run's lifecycle across the dispatch window itself.
 *
 * Two defects this suite guards, both of which leave a run row in a state
 * nothing can repair:
 *
 * 1. The dispatch loop ran without a pending-jobs token. A job that reached a
 *    terminal state while jobs 2..N were still dispatching finalized the run —
 *    `onJobStatus` recovers an unregistered job into `run.jobs`, and
 *    `isRunComplete` then sees every job it knows about terminal. The run was
 *    written terminal with the wrong status and duration, released its
 *    concurrency slot early, and never re-finalized once `completedAt` was set.
 * 2. A throw inside the window left the row with zero jobs. No sweeper reaps
 *    one: the stale-run detector scans from `execution_jobs` / `dispatch_queue`,
 *    orphan recovery requires `status = 'running'`, cold-store archival requires
 *    a terminal status, and cancel cannot terminalize it either because
 *    `completeRunIfAllJobsTerminal` requires at least one job. It sat `pending`
 *    forever, uncancellable, while the deadline detector re-fired every tick.
 */
describe('a global run is held open across its dispatch window', () => {
  it('takes a pending-jobs token before the first dispatch and releases it after registration', async () => {
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan'), staticJob('lint')] })],
      withExecutionTracker: true,
    });

    await processWebhook(makeInfo(), h.deps);

    // Control: both jobs really were dispatched, so the window this brackets
    // is a multi-job one — the only shape the defect can bite in.
    expect(h.workJobs().map((d) => d.jobName)).toEqual(['scan', 'lint']);

    expect(h.holdRunForPendingJobs).toHaveBeenCalledTimes(1);
    expect(h.holdRunForPendingJobs).toHaveBeenCalledWith(h.workJobs()[0].runId);
    expect(h.releasePendingJobsHold).toHaveBeenCalledTimes(1);
    expect(h.releasePendingJobsHold).toHaveBeenCalledWith(h.workJobs()[0].runId);

    // The token has to cover the WHOLE loop: taken once the row exists and
    // before any job is queued, released only once every job is registered.
    // Anything narrower reopens the window a fast job finalizes through.
    expect(h.callOrder).toEqual([
      'run-start',
      'hold',
      'dispatch:scan',
      'dispatch:lint',
      'add-jobs',
      'release',
    ]);
    // The happy path terminalizes nothing.
    expect(h.failRun).not.toHaveBeenCalled();
  });

  it('holds the run for a candidate the eval round cleared', async () => {
    // The other half of the shared dispatch — a generator-produced candidate
    // never touches the immediate path above.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult: {
        candidates: [
          {
            workflowName: GLOBAL_WORKFLOW,
            run: true,
            jobs: [staticJob('gen-a'), staticJob('gen-b')],
          },
        ],
      } as GlobalEvalRoundResult,
      withExecutionTracker: true,
    });

    await processWebhook(makeInfo(), h.deps);

    expect(h.workJobs().map((d) => d.jobName)).toEqual(['gen-a', 'gen-b']);
    expect(h.holdRunForPendingJobs).toHaveBeenCalledTimes(1);
    expect(h.callOrder.indexOf('hold')).toBeLessThan(h.callOrder.indexOf('dispatch:gen-a'));
    expect(h.callOrder.indexOf('add-jobs')).toBeLessThan(h.callOrder.indexOf('release'));
  });

  it('terminalizes the run when the first dispatch throws, and still propagates', async () => {
    // The unrecoverable orphan: the row is written, then the only dispatch
    // explodes, so no `execution_jobs` row and no `dispatch_queue` entry ever
    // exists for anything to recover the run from.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')] })],
      withExecutionTracker: true,
      failDispatchOn: 'scan',
    });

    await expect(processWebhook(makeInfo(), h.deps)).rejects.toThrow(/dispatch exploded/);

    // Control: the run row really was written before the throw, so there IS an
    // orphan to terminalize and this is not a path that never got that far.
    expect(h.onExecutionStarted).toHaveBeenCalledTimes(1);
    const runId = h.onExecutionStarted.mock.calls[0][0] as string;
    // And nothing registered a job against it — the row is genuinely empty.
    expect(h.addJobsToRun).not.toHaveBeenCalled();

    expect(h.failRun).toHaveBeenCalledTimes(1);
    expect(h.failRun.mock.calls[0][0]).toBe(runId);
    expect(String(h.failRun.mock.calls[0][1])).toMatch(/dispatch exploded/);
    // Terminalized before the error leaves the function, and the token is
    // dropped either way.
    expect(h.callOrder).toEqual(['run-start', 'hold', 'dispatch:scan', 'fail-run', 'release']);
  });

  it('terminalizes the run when job registration throws', async () => {
    // The same orphan by the other route: every dispatch succeeded, but the
    // write that would have given the run its jobs failed.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')] })],
      withExecutionTracker: true,
    });
    h.addJobsToRun.mockImplementation(async () => {
      throw new Error('addJobsToRun exploded');
    });

    await expect(processWebhook(makeInfo(), h.deps)).rejects.toThrow(/addJobsToRun exploded/);

    // Control: the dispatch itself succeeded, so this is the registration
    // failing and not the case above in disguise.
    expect(h.workJobs().map((d) => d.jobName)).toEqual(['scan']);
    expect(h.failRun).toHaveBeenCalledTimes(1);
    expect(h.failRun.mock.calls[0][0]).toBe(h.onExecutionStarted.mock.calls[0][0]);
  });

  it('lets the original fault propagate even when terminalizing it also fails', async () => {
    // The delivery must fail with the fault that caused it, not with whatever
    // the cleanup hit on its way out — the first is diagnosable, the second is
    // not.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')] })],
      withExecutionTracker: true,
      failDispatchOn: 'scan',
    });
    h.failRun.mockImplementation(async () => {
      throw new Error('failRun exploded');
    });

    await expect(processWebhook(makeInfo(), h.deps)).rejects.toThrow(/dispatch exploded/);
    expect(h.failRun).toHaveBeenCalledTimes(1);
  });

  it('does not fail a completed dispatch when releasing the pending-jobs hold throws', async () => {
    // Releasing can finalize the run — DB writes, the provider check, the
    // Platform forward — so it can throw. From a bare `finally` that throw
    // replaces the successful return, failing a delivery whose id `dedup.claim`
    // already holds: the event is silently lost and every remaining candidate
    // is skipped.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')] })],
      withExecutionTracker: true,
    });
    h.releasePendingJobsHold.mockImplementation(async () => {
      throw new Error('release exploded');
    });

    await expect(processWebhook(makeInfo(), h.deps)).resolves.not.toThrow();

    // Controls: the dispatch really did complete, so there was a successful
    // return for the throw to have replaced.
    expect(h.workJobs().map((d) => d.jobName)).toEqual(['scan']);
    expect(h.addJobsToRun).toHaveBeenCalledTimes(1);
    expect(h.releasePendingJobsHold).toHaveBeenCalledTimes(1);
    // Swallowed, not routed into the failure path.
    expect(h.failRun).not.toHaveBeenCalled();
  });

  it('lets the original fault propagate when releasing the hold also throws', async () => {
    // The error path's own sub-case: `failRun` threw and was swallowed, so the
    // run is still in memory holding the token and the release can finalize a
    // partially-registered run. The delivery must still fail with the fault
    // that caused it rather than with the cleanup's.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')] })],
      withExecutionTracker: true,
      failDispatchOn: 'scan',
    });
    h.failRun.mockImplementation(async () => {
      throw new Error('failRun exploded');
    });
    h.releasePendingJobsHold.mockImplementation(async () => {
      throw new Error('release exploded');
    });

    await expect(processWebhook(makeInfo(), h.deps)).rejects.toThrow(/dispatch exploded/);
    expect(h.releasePendingJobsHold).toHaveBeenCalledTimes(1);
  });
});

/**
 * The organization-wide pass can be scoped to one workflow repository.
 *
 * The re-run of a failed evaluation round re-drives this pass for exactly the
 * repository whose round failed. Every other repository's globals already
 * reached their verdict on the original delivery, so re-evaluating them would
 * dispatch a second run for work that already ran.
 */
describe('the organization-wide pass honours an onlyWorkflowRepo scope', () => {
  const OTHER_GLOBAL_REPO = 'acme/other-workflows';

  function passArgs(h: Harness, onlyWorkflowRepo?: string) {
    return {
      info: makeInfo(),
      deps: h.deps,
      eventWithFiles: {
        type: 'push',
        payload: {},
        targetBranch: 'main',
        sourceBranch: 'main',
        senderUsername: 'octocat',
        provider: 'github',
        sourceRepo: SOURCE_REPO,
      },
      resolvedOrgId: 'org-1',
      repoIdentifier: SOURCE_REPO,
      ref: 'headsha',
      dispatchBundle: h.bundle,
      dispatchCredentials: { token: 'src-token' },
      bundle: h.bundle,
      credentials: { token: 'src-token' },
      securityDecision: { action: 'pass' },
      ...(onlyWorkflowRepo === undefined ? {} : { onlyWorkflowRepo }),
    } as unknown as Parameters<typeof dispatchGlobalWorkflowsForOtherRepos>[0];
  }

  function twoRepoHarness() {
    return makeDeps({
      registrations: [
        makeGlobalRegistration({ jobs: [staticJob('scoped')], name: 'org-ci', id: 'reg-1' }),
        makeGlobalRegistration({
          jobs: [staticJob('other')],
          name: 'other-ci',
          id: 'reg-2',
          repoIdentifier: OTHER_GLOBAL_REPO,
        }),
      ],
    });
  }

  it('evaluates every workflow repo when no scope is set', async () => {
    // The non-vacuity control: both registrations really do reach dispatch, so
    // the single job below is about the scope and not about a harness that only
    // ever dispatches one.
    const h = twoRepoHarness();

    await dispatchGlobalWorkflowsForOtherRepos(passArgs(h));

    expect(
      h
        .workJobs()
        .map((d) => d.jobName)
        .sort(),
    ).toEqual(['other', 'scoped']);
  });

  it('drops registrations authored outside the scoped workflow repo', async () => {
    const h = twoRepoHarness();

    await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, GLOBAL_REPO));

    expect(h.workJobs().map((d) => d.jobName)).toEqual(['scoped']);
  });

  it("records the dispatch source the round's stored credentials belong to", async () => {
    // A cross-provider global resolves its lock file through ANOTHER source's
    // bundle, so `provider_context` and `routing_key` name different sources. The
    // re-run rebuilds the dispatch pair from this column; without it, it pairs
    // one source's credentials with the other source's API client.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundFails: true,
      withExecutionTracker: true,
    });
    const args = passArgs(h, GLOBAL_REPO) as unknown as Record<string, unknown>;
    args.dispatchRoutingKey = 'github:99';

    await dispatchGlobalWorkflowsForOtherRepos(
      args as unknown as Parameters<typeof dispatchGlobalWorkflowsForOtherRepos>[0],
    );

    expect(h.recordRoundFailure).toHaveBeenCalledTimes(1);
    expect(h.recordRoundFailure.mock.calls[0][0].dispatchRoutingKey).toBe('github:99');
  });

  it('records no dispatch source when the round dispatched through the inbound one', async () => {
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundFails: true,
      withExecutionTracker: true,
    });

    await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, GLOBAL_REPO));

    expect(h.recordRoundFailure).toHaveBeenCalledTimes(1);
    expect(h.recordRoundFailure.mock.calls[0][0].dispatchRoutingKey).toBeUndefined();
  });

  it('reports the workflow repo of a round it could not decide', async () => {
    // What a re-run reads to tell a clean re-evaluation from one that failed
    // again, without reading the run rows back.
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundFails: true,
      withExecutionTracker: true,
    });

    const outcome = await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, GLOBAL_REPO));

    expect(outcome.roundFailureWorkflowRepos).toEqual([GLOBAL_REPO]);
  });

  it('reports no round failure when the scoped round decides cleanly', async () => {
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true, jobs: [staticJob('gen-a')] }],
      } as GlobalEvalRoundResult,
      withExecutionTracker: true,
    });

    const outcome = await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, GLOBAL_REPO));

    expect(outcome.roundFailureWorkflowRepos).toEqual([]);
    expect(outcome.decidedWorkflowRepos).toEqual([GLOBAL_REPO]);
    expect(h.workJobs().map((d) => d.jobName)).toEqual(['gen-a']);
  });

  /**
   * The positive signal a re-run gates its success check on.
   *
   * "No round failure" is not the same claim: several paths evaluate nothing at
   * all and report no failure either, so reading their silence as a clean
   * verdict posts success for work that never ran.
   */
  describe('decidedWorkflowRepos', () => {
    it('names a repository whose candidates dispatched straight from the lock file', async () => {
      const h = makeDeps({
        registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')] })],
      });

      const outcome = await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, GLOBAL_REPO));

      expect(outcome.decidedWorkflowRepos).toEqual([GLOBAL_REPO]);
      expect(h.workJobs().map((d) => d.jobName)).toEqual(['scan']);
    });

    it('names a repository the pass considered and excluded on a real verdict', async () => {
      // A `run: false` verdict IS a verdict: the round decided the workflow does
      // not apply. The repository was evaluated, so it counts as decided even
      // though nothing dispatched.
      const h = makeDeps({
        registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
        roundResult: {
          candidates: [{ workflowName: GLOBAL_WORKFLOW, run: false }],
        } as GlobalEvalRoundResult,
      });

      const outcome = await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, GLOBAL_REPO));

      expect(outcome.decidedWorkflowRepos).toEqual([GLOBAL_REPO]);
      expect(h.workJobs()).toEqual([]);
    });

    it('names no repository when no pending-eval tracker is wired', async () => {
      // The fail-closed branch suppresses every candidate and deliberately
      // surfaces no round failure, so the absence of one says nothing here.
      const h = makeDeps({
        registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')], hasFilter: true })],
        withoutTracker: true,
      });

      const outcome = await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, GLOBAL_REPO));

      expect(outcome.roundFailureWorkflowRepos).toEqual([]);
      expect(outcome.decidedWorkflowRepos).toEqual([]);
      expect(h.workJobs()).toEqual([]);
    });

    it('names no repository when the round could not be decided', async () => {
      const h = makeDeps({
        registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
        roundFails: true,
        withExecutionTracker: true,
      });

      const outcome = await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, GLOBAL_REPO));

      expect(outcome.decidedWorkflowRepos).toEqual([]);
    });

    it('names no repository when the orchestrator carries no registration index', async () => {
      const h = makeDeps({
        registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')] })],
      });
      const args = passArgs(h, GLOBAL_REPO) as unknown as Record<string, unknown>;
      args.deps = { ...(args.deps as Record<string, unknown>), registrationIndex: undefined };

      const outcome = await dispatchGlobalWorkflowsForOtherRepos(
        args as unknown as Parameters<typeof dispatchGlobalWorkflowsForOtherRepos>[0],
      );

      expect(outcome.roundFailureWorkflowRepos).toEqual([]);
      expect(outcome.decidedWorkflowRepos).toEqual([]);
    });

    it("a failed round's re-run does not dispatch a result-aware-only sibling a second time", async () => {
      vi.mocked(dispatchGlobalCandidateViaPipeline).mockClear();
      const h = makeDeps({
        registrations: [
          makeGlobalRegistration({
            jobs: [dynamicEntry()],
            name: GLOBAL_WORKFLOW,
            id: 'reg-round',
          }),
          makeGlobalRegistration({
            jobs: [staticJob('build'), resultAwareEntry()],
            name: 'org-deferred',
            id: 'reg-deferred',
          }),
        ],
        roundFails: true,
      });

      // The delivery: the round fails, the result-aware-only sibling dispatches.
      await dispatchGlobalWorkflowsForOtherRepos(passArgs(h, GLOBAL_REPO));
      // The Re-run of that failed round, as rerun.ts drives it.
      const rerun = passArgs(h, GLOBAL_REPO) as unknown as Record<string, unknown>;
      rerun.onlyRoundCandidates = true;
      await dispatchGlobalWorkflowsForOtherRepos(
        rerun as unknown as Parameters<typeof dispatchGlobalWorkflowsForOtherRepos>[0],
      );

      // fails-when: the re-run dispatches the sibling the delivery already dispatched for this commit
      expect(pipelineWorkflows().filter((w) => w.name === 'org-deferred')).toHaveLength(1);
      // Positive control: the re-run did re-drive the round.
      expect(h.track.mock.calls.length).toBeGreaterThan(0);
    });

    it('releasing an approved hold dispatches a result-aware-only sibling once', async () => {
      // breaks-if-wrong: the held round's release is the one re-drive that must dispatch it
      vi.mocked(dispatchGlobalCandidateViaPipeline).mockClear();
      const h = makeDeps({
        registrations: [
          makeGlobalRegistration({
            jobs: [staticJob('build'), resultAwareEntry()],
            name: 'org-deferred',
            id: 'reg-deferred',
          }),
        ],
      });
      const release = passArgs(h, GLOBAL_REPO) as unknown as Record<string, unknown>;
      release.onlyRoundCandidates = true;
      release.releasedHold = true;
      await dispatchGlobalWorkflowsForOtherRepos(
        release as unknown as Parameters<typeof dispatchGlobalWorkflowsForOtherRepos>[0],
      );

      expect(pipelineWorkflows().map((w) => w.name)).toEqual(['org-deferred']);
    });

    it.each([
      { name: 'a result-aware-only workflow is held with the round', deferred: true },
      { name: 'a static-only workflow is held on its own', deferred: false },
    ])('under a held event, $name', async ({ deferred }) => {
      vi.mocked(dispatchGlobalCandidateViaPipeline).mockClear();
      const h = makeDeps({
        registrations: [
          makeGlobalRegistration({
            jobs: deferred ? [staticJob('build'), resultAwareEntry()] : [staticJob('scan')],
          }),
        ],
      });
      const args = passArgs(h, GLOBAL_REPO) as unknown as Record<string, unknown>;
      args.securityDecision = { action: 'hold', reason: 'untrusted contributor' };

      const outcome = await dispatchGlobalWorkflowsForOtherRepos(
        args as unknown as Parameters<typeof dispatchGlobalWorkflowsForOtherRepos>[0],
      );

      // fails-when: a result-aware-only workflow takes its own hold instead of the round's, so releasing the round drops it
      // breaks-if-wrong: a static-only workflow still takes its own hold through the pipeline
      expect(pipelineWorkflows()).toHaveLength(deferred ? 0 : 1);
      expect(outcome.matchedCount).toBe(1);
      expect(h.workJobs()).toEqual([]);
    });

    it('names no repository whose run a held event parked in the security queue', async () => {
      // A held event decided nothing about the workflows it holds: they run, or
      // do not, when an approver answers. Counting the repository as decided
      // would let a re-run post the round-succeeded check on a held event.
      // fails-when: a held event counts its workflow repository as decided, or dispatches the global job
      const h = makeDeps({
        registrations: [makeGlobalRegistration({ jobs: [staticJob('scan')] })],
      });
      const args = passArgs(h, GLOBAL_REPO) as unknown as Record<string, unknown>;
      args.securityDecision = { action: 'hold', reason: 'untrusted contributor' };

      const outcome = await dispatchGlobalWorkflowsForOtherRepos(
        args as unknown as Parameters<typeof dispatchGlobalWorkflowsForOtherRepos>[0],
      );

      expect(outcome.decidedWorkflowRepos).toEqual([]);
      expect(outcome.matchedCount).toBe(1);
      expect(h.workJobs()).toEqual([]);
    });
  });
});

/**
 * Approving the security hold of a held evaluation round runs that round.
 *
 * Driven through `resumeWorkflow`, the release every approval surface reaches,
 * with the real organization-wide pass behind it: the round job must dispatch
 * for the held workflow repository and the jobs it admits must follow.
 */
describe('releasing a held evaluation round', () => {
  /** `repos` on a trigger is what makes a workflow organization-wide. */
  const ANY_REPO: Array<{ type: 'glob'; pattern: string }> = [{ type: 'glob', pattern: '**' }];
  const HELD_RUN_ID = 'held-round-1';
  const HELD_ROW = {
    run_id: HELD_RUN_ID,
    routing_key: 'github:1',
    workflow_name: `${ROUND_JOB_PREFIX}${GLOBAL_REPO}`,
    status: ExecutionRunStatus.enum.held,
    provider: 'github',
    repo_identifier: SOURCE_REPO,
    ref: 'main',
    sha: 'headsha',
    delivery_id: 'd-held',
    customer_id: 'org-1',
    workflow_repo_identifier: GLOBAL_REPO,
    // The commit and branch the hold recorded: the registrations' own.
    workflow_sha: 'globalsha',
    workflow_branch: 'trunk',
    dispatch_routing_key: null,
    is_global_eval_round: true,
    provider_context: JSON.stringify({ token: 'src-token' }),
    // The delivery's `event_log` columns: the mock serves one row to every
    // select whose predicates it satisfies.
    org_id: 'org-1',
    event: 'push',
    action: null,
  };
  const SIGNAL = {
    holdId: 'hold-1',
    runId: HELD_RUN_ID,
    jobId: 'security',
    scope: HoldScope.enum.workflow,
    stepIndex: null,
    triggerSource: TriggerSource.enum.context,
  };

  function releaseHarness(
    over: {
      row?: Record<string, unknown>;
      payload?: string | null;
      extraRegistrations?: ReturnType<typeof makeGlobalRegistration>[];
      /** Replaces the default registrations the index returns. */
      registrations?: ReturnType<typeof makeGlobalRegistration>[];
    } = {},
  ) {
    const h = makeDeps({
      registrations: over.registrations ?? [
        makeGlobalRegistration({
          jobs: [dynamicEntry()],
          name: GLOBAL_WORKFLOW,
          id: 'reg-round',
          repos: ANY_REPO,
        }),
        makeGlobalRegistration({
          jobs: [staticJob('scan')],
          name: 'org-static',
          id: 'reg-static',
          repos: ANY_REPO,
        }),
        ...(over.extraRegistrations ?? []),
      ],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true, jobs: [staticJob('gen-a')] }],
      } as GlobalEvalRoundResult,
      withExecutionTracker: true,
    });
    const complete = vi.fn(async () => undefined);
    const payload = over.payload === undefined ? JSON.stringify({ repository: {} }) : over.payload;
    const deps = h.deps as unknown as Record<string, any>;
    deps.executionTracker.completeReleasedGlobalEvalRound = complete;
    // The row every read of the run sees, moved by the guarded held → pending
    // claim: only the first release finds it held.
    const row: Record<string, unknown> = { ...(over.row ?? HELD_ROW) };
    const claim = vi.fn(async () => {
      if (row.status !== ExecutionRunStatus.enum.held) return false;
      row.status = ExecutionRunStatus.enum.pending;
      return true;
    });
    deps.executionTracker.claimHeldGlobalEvalRound = claim;
    deps.logStorage.read = vi.fn(async () => ({ data: payload ?? '', cursor: 0, complete: true }));
    deps.db = createMockDb({ selectFirstRow: row }).db;
    return { h, complete, claim, row, deps: h.deps };
  }

  it('dispatches the round for the held workflow repository, then the jobs it admits', async () => {
    // fails-when: approving the round's hold replays nothing, or replays it as a workflow dispatch
    const { h, complete, deps } = releaseHarness();

    await resumeWorkflow(SIGNAL, deps, deps.db);

    expect(h.track).toHaveBeenCalledTimes(1);
    const round = h.dispatched().find((d) => String(d.jobName).startsWith(ROUND_JOB_PREFIX));
    expect(round?.jobConfig.workflowRepoIdentifier).toBe(GLOBAL_REPO);
    // The workflow that needed no round was held and released on its own, so
    // the round's release must not dispatch it a second time.
    expect(h.workJobs().map((d) => d.jobName)).toEqual(['gen-a']);
    expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, { status: ExecutionRunStatus.enum.success });
  });

  it('dispatches a result-aware-only workflow held with the round when the round is released', async () => {
    // A held event holds every candidate carrying a generator with its repository's
    // round — including one recorded before result-aware generators stopped
    // needing the round — so approving that hold must dispatch it.
    const { h, deps } = releaseHarness({
      extraRegistrations: [
        makeGlobalRegistration({
          jobs: [staticJob('build'), resultAwareEntry()],
          name: 'org-deferred',
          id: 'reg-deferred',
          repos: ANY_REPO,
        }),
      ],
    });
    vi.mocked(dispatchGlobalCandidateViaPipeline).mockClear();

    await resumeWorkflow(SIGNAL, deps, deps.db);

    // fails-when: the release partition drops the result-aware-only workflow it held
    expect(
      pipelineWorkflows()
        .map((w) => w.name)
        .sort(),
    ).toEqual([GLOBAL_WORKFLOW, 'org-deferred'].sort());
    // breaks-if-wrong: the static-only workflow was held on its own and must not dispatch again
    expect(pipelineWorkflows().map((w) => w.name)).not.toContain('org-static');
    // It needs no round, so the round still carries only the round candidate.
    const round = h.dispatched().find((d) => String(d.jobName).startsWith(ROUND_JOB_PREFIX));
    expect(
      round?.jobConfig.candidates.map((c: { workflowName: string }) => c.workflowName),
    ).toEqual([GLOBAL_WORKFLOW]);
  });

  it('runs the round once when the release signal fires twice', async () => {
    // fails-when: a second release of the same hold dispatches the round and its admitted jobs again
    const { h, claim, complete, deps } = releaseHarness();

    await Promise.all([
      resumeWorkflow(SIGNAL, deps, deps.db),
      resumeWorkflow(SIGNAL, deps, deps.db),
    ]);

    expect(claim).toHaveBeenCalledTimes(2);
    expect(h.track).toHaveBeenCalledTimes(1);
    expect(
      h.dispatched().filter((d) => String(d.jobName).startsWith(ROUND_JOB_PREFIX)),
    ).toHaveLength(1);
    expect(h.workJobs().map((d) => d.jobName)).toEqual(['gen-a']);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  /**
   * A database whose `execution_runs` writes apply to `row` when their plain
   * `status` guards hold, so a real cancel moves the row the release re-reads.
   * Raw-SQL guards are not evaluated: the round row has no job rows, which is
   * what the one raw guard on the cancel path (NOT EXISTS execution_jobs) asks.
   */
  function runRowDb(row: Record<string, unknown>) {
    const base = createMockDb({ selectFirstRow: row }).db as unknown as Record<string, any>;
    const holds = (column: unknown, op: unknown, value: unknown): boolean => {
      if (column === 'run_id') return value === row.run_id;
      if (column !== 'status') return true;
      if (op === '=') return row.status === value;
      if (op === 'in') return (value as unknown[]).includes(row.status);
      if (op === 'not in') return !(value as unknown[]).includes(row.status);
      return true;
    };
    return new Proxy(base, {
      get(target, prop) {
        if (prop !== 'updateTable') return target[prop as string];
        return (table: string) => {
          if (table !== 'execution_runs') return target.updateTable(table);
          let values: Record<string, unknown> = {};
          const guards: unknown[][] = [];
          const apply = () => {
            if (!guards.every((g) => g.length !== 3 || holds(g[0], g[1], g[2]))) return undefined;
            for (const [k, v] of Object.entries(values)) {
              if (v === null || typeof v !== 'object' || v instanceof Date) row[k] = v;
            }
            return { ...row };
          };
          const chain: Record<string, any> = {
            set: (v: Record<string, unknown>) => ((values = v), chain),
            where: (...args: unknown[]) => (guards.push(args), chain),
            returningAll: () => chain,
            execute: async () => [{ numUpdatedRows: apply() ? 1n : 0n }],
            executeTakeFirst: async () => apply(),
          };
          return chain;
        };
      },
    });
  }

  it('dispatches nothing the round admitted once its run was cancelled mid-round', async () => {
    // Cancelled through the real cancel path: the round row has no job rows,
    // so it is the cancel itself that has to move it off `pending`.
    // fails-when: a round whose run a user cancelled while it ran still dispatches its admitted jobs
    const { h, row, deps } = releaseHarness();
    const db = runRowDb(row);
    (deps as unknown as Record<string, unknown>).db = db;
    const forwarded = vi.fn();
    const tracker = new ExecutionTracker({ db: db as never, onExecutionStatusChange: forwarded });
    vi.spyOn(tracker, 'completeRunIfAllJobsTerminal').mockResolvedValue(undefined);
    h.track.mockImplementation(async () => {
      const cancelled = await cancelRunWithReason(
        {
          db: db as never,
          jobQueue: {
            getDispatchedJobOwnersByRunId: async () => [],
            cancelByRunId: async () => 0,
          } as never,
          registry: { get: () => undefined } as never,
          executionTracker: tracker,
        },
        HELD_RUN_ID,
        'cancelled by a user',
      );
      expect(cancelled.alreadyTerminal).toBe(false);
      return {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true, jobs: [staticJob('gen-a')] }],
      };
    });

    await resumeWorkflow(SIGNAL, deps, db as never);

    expect(h.track).toHaveBeenCalledTimes(1);
    expect(row.status).toBe(ExecutionRunStatus.enum.cancelled);
    expect(forwarded.mock.calls[0][1]).toBe(ExecutionRunStatus.enum.cancelled);
    expect(h.workJobs()).toEqual([]);
  });

  it('dispatches nothing and settles nothing when the claim itself fails', async () => {
    const { h, claim, complete, deps } = releaseHarness();
    claim.mockRejectedValueOnce(new Error('connection reset'));

    await expect(resumeWorkflow(SIGNAL, deps, deps.db)).resolves.toBeUndefined();

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('fails the held round with the reason when its payload was not stored', async () => {
    const { h, complete, deps } = releaseHarness({ payload: null });

    await resumeWorkflow(SIGNAL, deps, deps.db);

    expect(h.dispatch).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, {
      status: ExecutionRunStatus.enum.failed,
      reason: expect.stringContaining('webhook payload was not stored'),
    });
  });

  it('fails the held round when the released round reaches no verdict', async () => {
    const { h, complete, deps } = releaseHarness();
    h.track.mockImplementation(async () => {
      throw new Error('agent gone');
    });

    await resumeWorkflow(SIGNAL, deps, deps.db);

    expect(h.workJobs()).toEqual([]);
    expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, {
      status: ExecutionRunStatus.enum.failed,
      reason: expect.stringContaining('reached no verdict'),
    });
  });

  describe('against the commit the hold recorded', () => {
    const HELD_SHA = 'heldsha';
    /** The workflow as the hold saw it: its filter sent it to the round. */
    const heldEntry = {
      ...makeGlobalRegistration({
        jobs: [staticJob('scan')],
        hasFilter: true,
        repos: [{ type: 'glob', pattern: '**' }],
      }).lockEntry,
    };

    /**
     * A release whose registration moved on from the held commit: at
     * `globalsha` the filter is gone, so today's registration alone would not
     * send the workflow to the round.
     */
    function driftedRelease(lockFileAtHeldSha: unknown = { workflows: [heldEntry] }) {
      const harness = releaseHarness({
        row: { ...HELD_ROW, workflow_sha: HELD_SHA },
        registrations: [
          makeGlobalRegistration({
            jobs: [staticJob('scan')],
            repos: [{ type: 'glob', pattern: '**' }],
            id: 'reg-drifted',
          }),
        ],
      });
      harness.h.track.mockImplementation(async () => ({
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true }],
      }));
      const fetchLockFile = vi.fn(async () => lockFileAtHeldSha);
      (harness.h.bundle as Record<string, unknown>).lockFileFetcher = { fetchLockFile };
      vi.mocked(dispatchGlobalCandidateViaPipeline).mockClear();
      return { ...harness, fetchLockFile };
    }

    it("runs the held version's round and dispatches it once after the filter was removed", async () => {
      // fails-when: the release evaluates the registration's current entry, whose missing filter drops the workflow
      const { h, complete, deps, fetchLockFile } = driftedRelease();

      await resumeWorkflow(SIGNAL, deps, deps.db);

      expect(fetchLockFile).toHaveBeenCalledWith(GLOBAL_REPO, HELD_SHA, undefined);
      const rounds = h.dispatched().filter((d) => String(d.jobName).startsWith(ROUND_JOB_PREFIX));
      expect(rounds).toHaveLength(1);
      expect(rounds[0].jobConfig.workflowSha).toBe(HELD_SHA);
      expect(
        rounds[0].jobConfig.candidates.map((c: { workflowName: string }) => c.workflowName),
      ).toEqual([GLOBAL_WORKFLOW]);
      const calls = vi.mocked(dispatchGlobalCandidateViaPipeline).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0].resolved.candidate.reg.commitSha).toBe(HELD_SHA);
      expect(calls[0][0].resolved.candidate.lockEntry.hasFilter).toBe(true);
      expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, {
        status: ExecutionRunStatus.enum.success,
      });
    });

    it('fails the held round, naming the workflow repository, when its registrations were deleted', async () => {
      // breaks-if-wrong: a deleted registration must not fall back to any other lock
      const { h, complete, deps, fetchLockFile } = driftedRelease();
      (deps as unknown as Record<string, any>).registrationIndex.getAllByOrgAndRepo = () => [];

      await resumeWorkflow(SIGNAL, deps, deps.db);

      expect(fetchLockFile).not.toHaveBeenCalled();
      expect(h.track).not.toHaveBeenCalled();
      expect(h.dispatched()).toEqual([]);
      expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, {
        status: ExecutionRunStatus.enum.failed,
        reason: expect.stringContaining(`workflow repository ${GLOBAL_REPO} no longer registers`),
      });
    });

    it('fails the held round, naming the workflow, when one of two covered registrations was deleted', async () => {
      // fails-when: the surviving workflow's round runs and the deleted one is silently dropped
      // breaks-if-wrong: the release must not dispatch part of the round it covered
      const secondEntry = { ...heldEntry, name: 'org-second' };
      const { h, complete, deps, fetchLockFile } = driftedRelease({
        workflows: [heldEntry, secondEntry],
      });

      await resumeWorkflow(SIGNAL, deps, deps.db);

      expect(fetchLockFile).toHaveBeenCalledWith(GLOBAL_REPO, HELD_SHA, undefined);
      expect(h.track).not.toHaveBeenCalled();
      expect(h.dispatched()).toEqual([]);
      expect(vi.mocked(dispatchGlobalCandidateViaPipeline)).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, {
        status: ExecutionRunStatus.enum.failed,
        reason: expect.stringContaining(
          `workflow repository ${GLOBAL_REPO} can no longer run org-second (no longer registered)`,
        ),
      });
    });

    it('fails the held round when a covered registration no longer subscribes to the event', async () => {
      const { h, complete, deps } = driftedRelease();
      const index = (deps as unknown as Record<string, any>).registrationIndex;
      const [reg] = index.getAllByOrgAndRepo('org-1', GLOBAL_REPO);
      index.getAllByOrgAndRepo = () => [{ ...reg, triggerTypes: ['pr'] }];

      await resumeWorkflow(SIGNAL, deps, deps.db);

      expect(h.track).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, {
        status: ExecutionRunStatus.enum.failed,
        reason: expect.stringContaining(
          `can no longer run ${GLOBAL_WORKFLOW} (no longer subscribed)`,
        ),
      });
    });

    it('fails the held round when the held commit has no lock file, rather than using the current one', async () => {
      // fails-when: a lock file gone from the held commit falls back to the registration's entry
      const { h, complete, deps } = driftedRelease(null);

      await resumeWorkflow(SIGNAL, deps, deps.db);

      expect(h.track).not.toHaveBeenCalled();
      expect(h.dispatched()).toEqual([]);
      expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, {
        status: ExecutionRunStatus.enum.failed,
        reason: expect.stringContaining(`${GLOBAL_REPO} has no lock file at ${HELD_SHA}`),
      });
    });

    it('leaves out a workflow the held commit does not define as organization-wide', async () => {
      // A workflow added to the repository after the hold was not part of the held round.
      const { h, complete, deps } = driftedRelease({ workflows: [] });

      await resumeWorkflow(SIGNAL, deps, deps.db);

      expect(h.track).not.toHaveBeenCalled();
      expect(vi.mocked(dispatchGlobalCandidateViaPipeline)).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, {
        status: ExecutionRunStatus.enum.failed,
        reason: expect.stringContaining('reached no verdict'),
      });
    });
  });

  describe('against the workflows the hold recorded', () => {
    /** A round-covered workflow registered at the held commit. */
    function covered(name: string, over: { disabled?: boolean } = {}) {
      return makeGlobalRegistration({
        jobs: [dynamicEntry()],
        name,
        id: `reg-${name}`,
        repos: ANY_REPO,
        ...over,
      });
    }

    /** A release of a round whose hold recorded `recorded`, at the registrations' commit. */
    function recordedRelease(
      recorded: string[],
      registrations: ReturnType<typeof makeGlobalRegistration>[],
      row: Record<string, unknown> = {},
    ) {
      const harness = releaseHarness({
        row: {
          ...HELD_ROW,
          trigger_decision: JSON.stringify({ heldRoundWorkflows: recorded }),
          ...row,
        },
        registrations,
      });
      harness.h.track.mockImplementation(async () => ({
        candidates: recorded.map((workflowName) => ({
          workflowName,
          run: true,
          jobs: [staticJob(`gen-${workflowName}`)],
        })),
      }));
      return harness;
    }

    it('fails naming a covered workflow disabled while its siblings stayed at the held commit', async () => {
      // fails-when: the disabled workflow is absent from the index and the rest of the round runs
      const { h, complete, deps } = recordedRelease(
        [GLOBAL_WORKFLOW, 'org-second'],
        [covered(GLOBAL_WORKFLOW), covered('org-second', { disabled: true })],
      );

      await resumeWorkflow(SIGNAL, deps, deps.db);

      expect(h.track).not.toHaveBeenCalled();
      expect(h.dispatched()).toEqual([]);
      expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, {
        status: ExecutionRunStatus.enum.failed,
        reason: expect.stringContaining(
          `workflow repository ${GLOBAL_REPO} can no longer run org-second (disabled)`,
        ),
      });
    });

    it('fails naming a covered workflow deleted at an unchanged commit', async () => {
      const { h, complete, deps } = recordedRelease(
        [GLOBAL_WORKFLOW, 'org-second'],
        [covered(GLOBAL_WORKFLOW)],
      );

      await resumeWorkflow(SIGNAL, deps, deps.db);

      expect(h.track).not.toHaveBeenCalled();
      expect(h.dispatched()).toEqual([]);
      expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, {
        status: ExecutionRunStatus.enum.failed,
        reason: expect.stringContaining('org-second (no longer registered)'),
      });
    });

    it('releases when a workflow disabled before the hold is not in the recorded set', async () => {
      // breaks-if-wrong: a workflow the hold never covered must not fail the release
      const { h, complete, deps } = recordedRelease(
        [GLOBAL_WORKFLOW],
        [covered(GLOBAL_WORKFLOW), covered('org-second', { disabled: true })],
      );

      await resumeWorkflow(SIGNAL, deps, deps.db);

      const round = h.dispatched().find((d) => String(d.jobName).startsWith(ROUND_JOB_PREFIX));
      expect(
        round?.jobConfig.candidates.map((c: { workflowName: string }) => c.workflowName),
      ).toEqual([GLOBAL_WORKFLOW]);
      expect(h.workJobs().map((d) => d.jobName)).toEqual([`gen-${GLOBAL_WORKFLOW}`]);
      expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, {
        status: ExecutionRunStatus.enum.success,
      });
    });

    it('releases the recorded workflows from a drifted commit', async () => {
      const { h, complete, deps } = recordedRelease([GLOBAL_WORKFLOW], [covered(GLOBAL_WORKFLOW)], {
        workflow_sha: 'heldsha',
      });
      const fetchLockFile = vi.fn(async () => ({
        workflows: [covered(GLOBAL_WORKFLOW).lockEntry, covered('added-later').lockEntry],
      }));
      (h.bundle as Record<string, unknown>).lockFileFetcher = { fetchLockFile };

      await resumeWorkflow(SIGNAL, deps, deps.db);

      expect(fetchLockFile).toHaveBeenCalledWith(GLOBAL_REPO, 'heldsha', undefined);
      const round = h.dispatched().find((d) => String(d.jobName).startsWith(ROUND_JOB_PREFIX));
      expect(round?.jobConfig.workflowSha).toBe('heldsha');
      expect(
        round?.jobConfig.candidates.map((c: { workflowName: string }) => c.workflowName),
      ).toEqual([GLOBAL_WORKFLOW]);
      expect(complete).toHaveBeenCalledWith(HELD_RUN_ID, {
        status: ExecutionRunStatus.enum.success,
      });
    });
  });

  it('replays a held workflow run through its stored context, not as a round', async () => {
    // breaks-if-wrong: a held run without the round marker must keep its own resume path
    const { h, complete, deps } = releaseHarness({
      row: { ...HELD_ROW, is_global_eval_round: false },
    });

    await resumeWorkflow(SIGNAL, deps, deps.db);

    expect(h.track).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('cancels the held round on rejection and runs no round', async () => {
    const { h, deps } = releaseHarness();
    const cancelHeldRun = vi.fn(async () => undefined);
    (deps as unknown as Record<string, any>).executionTracker.cancelHeldRun = cancelHeldRun;

    await rejectWorkflow(
      { run_id: HELD_RUN_ID, job_id: 'security' } as unknown as Parameters<
        typeof rejectWorkflow
      >[0],
      deps,
      deps.db,
      'not this one',
    );

    expect(cancelHeldRun).toHaveBeenCalledWith(HELD_RUN_ID, 'not this one');
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});

describe('result-aware generators in an organization-wide workflow', () => {
  /** One registered, idle init-runner, advertising the capability or not. */
  function oneAgentFleet(capable: boolean) {
    return {
      findAvailable: () => [{ platform: 'linux', arch: 'x64', version: '0.9.3' }],
      getAllEntries: () => [
        {
          labels: new Set([
            'kici:role:init-runner',
            ...(capable ? [GLOBAL_EVAL_SKIPS_RESULT_AWARE_LABEL] : []),
          ]),
          platform: 'linux',
          arch: 'x64',
          version: '0.9.3',
          capabilities: capable
            ? { [AgentCapabilityFlag.enum.globalEvalSkipsResultAwareGenerators]: true }
            : null,
        },
      ],
    };
  }

  it('dispatches a result-aware-only workflow straight to the pipeline with its generator intact', async () => {
    vi.mocked(dispatchGlobalCandidateViaPipeline).mockClear();
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [staticJob('build'), resultAwareEntry()] })],
    });

    await processWebhook(makeInfo(), h.deps);

    // fails-when: a workflow whose only generator is result-aware is sent to the round
    expect(h.track).not.toHaveBeenCalled();
    // breaks-if-wrong: the result-aware entry must reach the pipeline intact (resultAware + needs)
    const [workflow] = pipelineWorkflows();
    expect(workflow.jobs).toEqual([staticJob('build'), resultAwareEntry()]);
    expect(h.workJobs().map((d) => d.jobName)).toEqual(['build']);
  });

  it('a needs-free generator returning zero jobs still produces no run', async () => {
    vi.mocked(dispatchGlobalCandidateViaPipeline).mockClear();
    const h = makeDeps({
      registrations: [makeGlobalRegistration({ jobs: [dynamicEntry()] })],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true, jobs: [] }],
      } as GlobalEvalRoundResult,
      withExecutionTracker: true,
    });

    await processWebhook(makeInfo(), h.deps);

    // Positive control: the round really ran and cleared the candidate.
    expect(h.track).toHaveBeenCalledTimes(1);
    // The cleared candidate carries nothing to dispatch: no static job, no
    // generated job, no result-aware generator.
    expect(pipelineWorkflows()).toEqual([{ name: GLOBAL_WORKFLOW, jobs: [] }]);
    // fails-when: a cleared candidate with no static, generated or result-aware job creates a run
    expect(h.onExecutionStarted).not.toHaveBeenCalled();
    expect(h.workJobs()).toHaveLength(0);
  });

  it('dispatches a result-aware generator on the deferred path next to what the round generated', async () => {
    vi.mocked(dispatchGlobalCandidateViaPipeline).mockClear();
    const h = makeDeps({
      registrations: [
        makeGlobalRegistration({ jobs: [staticJob('build'), dynamicEntry(), resultAwareEntry()] }),
      ],
      roundResult: {
        candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true, jobs: [staticJob('gen-a')] }],
      } as GlobalEvalRoundResult,
    });
    (h.deps as unknown as Record<string, unknown>).agentRegistry = oneAgentFleet(true);

    await processWebhook(makeInfo(), h.deps);

    const round = h.dispatched().find((d) => String(d.jobName).startsWith(ROUND_JOB_PREFIX));
    // fails-when: the round can reach an agent that has not advertised skipping result-aware generators
    expect(round?.runsOnLabels).toContain(GLOBAL_EVAL_SKIPS_RESULT_AWARE_LABEL);
    const [workflow] = pipelineWorkflows();
    // breaks-if-wrong: the round-generated job and the deferred generator must both reach the pipeline
    expect(workflow.jobs).toEqual([staticJob('build'), staticJob('gen-a'), resultAwareEntry()]);
  });

  it.each([
    { name: 'no registered agent advertises the capability', capable: false },
    { name: 'the registered agent advertises the capability', capable: true },
  ])(
    'records the unsupported-fleet failure for a mixed workflow only when $name',
    async ({ capable }) => {
      vi.mocked(dispatchGlobalCandidateViaPipeline).mockClear();
      const h = makeDeps({
        registrations: [makeGlobalRegistration({ jobs: [dynamicEntry(), resultAwareEntry()] })],
        roundResult: {
          candidates: [{ workflowName: GLOBAL_WORKFLOW, run: true, jobs: [staticJob('gen-a')] }],
        } as GlobalEvalRoundResult,
        withExecutionTracker: true,
      });
      (h.deps as unknown as Record<string, unknown>).agentRegistry = oneAgentFleet(capable);

      await processWebhook(makeInfo(), h.deps);

      const rounds = h.dispatched().filter((d) => String(d.jobName).startsWith(ROUND_JOB_PREFIX));
      // fails-when: the round is sent to a fleet whose every agent would run the result-aware generator
      expect(rounds).toHaveLength(capable ? 1 : 0);
      // Positive control: the same fixture with the flag present dispatches the admitted workflow.
      expect(pipelineWorkflows()).toHaveLength(capable ? 1 : 0);
      // The same visible record an unsupported fleet produces: one errored run and one check.
      expect(h.recordRoundFailure).toHaveBeenCalledTimes(capable ? 0 : 1);
      expect(h.postGlobalEvalFailedCheck).toHaveBeenCalledTimes(capable ? 0 : 1);
    },
  );
});
