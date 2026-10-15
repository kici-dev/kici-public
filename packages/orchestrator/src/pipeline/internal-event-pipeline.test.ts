import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LockFile, LockTrigger, WorkflowDecision } from '@kici-dev/engine';
import type { ProcessingDeps } from './processor.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { WorkflowDispatchContext } from './dispatch-matched-workflow.js';
import { SCALER_EVENT_NAMES } from '../scaler/scaler-events.js';
import {
  deriveInternalEventIdentity,
  dispatchInternalEventViaPipeline,
  trustTierRanksCoverEverySchemaTier,
  type InternalEventDispatchContext,
} from './internal-event-pipeline.js';
import { lockFileFixture, lockWorkflow, staticJob } from '../__test-helpers__/lock-fixtures.js';

/**
 * The shared dispatch core is wrapped, not replaced: every call is recorded for
 * assertions on the SYNTHESIZED context, and `passthrough` runs the real
 * pipeline to prove the core accepts that context.
 */
const core = vi.hoisted(() => ({
  seen: [] as WorkflowDispatchContext[],
  results: [] as Array<{ dispatchedJobCount: number; deferredJobCount?: number }>,
  passthrough: false,
}));

vi.mock('./dispatch-matched-workflow.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dispatch-matched-workflow.js')>();
  return {
    ...actual,
    dispatchMatchedWorkflow: async (ctx: WorkflowDispatchContext) => {
      core.seen.push(ctx);
      const result = core.passthrough
        ? await actual.dispatchMatchedWorkflow(ctx)
        : { dispatchedJobCount: 1, dispatchedJobIds: ['job-1'] };
      core.results.push(result);
      return result;
    },
  };
});

describe('deriveInternalEventIdentity', () => {
  // A change here is customer-visible: jobConfigType reaches workflows as
  // ctx.event.type; triggerEvent is the run's forwarded triggerEvent (tracker
  // memory + Platform forward, not a column).
  it.each([
    ['__schedule_fire', 'schedule', 'schedule'],
    ['__workflow_complete', 'workflow_complete', 'workflow_complete'],
    ['__workflows_failed_batch', 'workflows_failed_batch', 'workflows_failed_batch'],
    ['__job_complete', 'job_complete', 'job_complete'],
    ['kici.scaler.scale-up', 'kici_event', 'kici.scaler.scale-up'],
    ['kici.scaler.scale-down', 'kici_event', 'kici.scaler.scale-down'],
    ['my.custom.event', 'kici_event', 'my.custom.event'],
  ])('%s → jobConfig %s / trigger %s', (name, jobConfigType, triggerEvent) => {
    expect(deriveInternalEventIdentity(name)).toEqual({ jobConfigType, triggerEvent });
  });

  it('de-prefixes a bare prefix to an empty string', () => {
    // Pins the derivation as TOTAL, even for an input nothing can emit (the
    // emit path refuses the `__` namespace; the orchestrator mints only
    // enumerated names). `dispatchTriggerEvent` derives `''` here too, so its
    // blank-override guard is not exercised; that guard is covered over a REAL
    // event type in `dispatch-matched-workflow.test.ts`.
    expect(deriveInternalEventIdentity('__')).toEqual({ jobConfigType: '', triggerEvent: '' });
  });

  it('agrees with a transcription of the router branches it has to match', () => {
    // `EventRouter.eventToTriggerType` is private, so this TRANSCRIBES its
    // branches: it catches adapter drift, not a router change. Kept because a
    // disagreement dispatches a workflow with an `event.type` its rules never
    // matched, and a hand-checkable copy makes that visible in review.
    for (const name of ['__schedule_fire', '__workflow_complete', '__job_complete', 'custom.x']) {
      const routerType =
        name === '__schedule_fire'
          ? 'schedule'
          : name.startsWith('__')
            ? name.slice(2)
            : 'kici_event';
      expect(deriveInternalEventIdentity(name).jobConfigType).toBe(routerType);
    }
  });
});

/**
 * A one-static-job lock file, optionally carrying the given triggers and a
 * `dynamic` job entry.
 */
function makeLockFile(
  triggers: LockTrigger[] = [],
  opts: { withDynamicJob?: boolean } = {},
): LockFile {
  return lockFileFixture({
    schemaVersion: 4,
    contentHash: 'abc',
    lockfileHash: 'lock',
    workflows: [
      lockWorkflow({
        name: 'notify',
        source: { file: '.kici/workflows/ci.ts', export: '#default' },
        contentHash: 'wf-hash',
        compileSchemaVersion: 1,
        triggers,
        jobs: [
          staticJob({
            runsOn: [{ kind: 'exact', value: 'default' }],
            steps: [{ name: 'echo', run: 'echo hi' }],
            rules: [],
          }),
          ...(opts.withDynamicJob
            ? [
                {
                  _type: 'dynamic',
                  source: { file: '.kici/workflows/ci.ts', index: 1 },
                },
              ]
            : []),
        ],
      }),
    ],
  });
}

function makeDecision(over: Partial<WorkflowDecision> = {}): WorkflowDecision {
  return {
    workflowName: 'notify',
    matched: true,
    checks: [],
    summary: 'internal event matched',
    ...over,
  } as WorkflowDecision;
}

function makeInternalCtx(
  over: Partial<InternalEventDispatchContext> & {
    event?: Partial<InternalEventDispatchContext['event']>;
  } = {},
): InternalEventDispatchContext {
  const { event, ...rest } = over;
  return {
    event: {
      id: 'evt-1',
      eventName: 'kici.scaler.scale-up',
      payload: { claimCode: 'abc' },
      ...event,
    },
    routingKey: 'github:1',
    repoIdentifier: 'acme/infra',
    providerContext: { installationId: 4242 },
    providerType: 'github',
    bundle: makeBundle(),
    cronCommitSha: '',
    registrationDefaultBranch: null,
    ...rest,
  };
}

/**
 * A bundle carrying only the URL builder every dispatch site derives `repoUrl`
 * from. An `undefined` bundle also classifies the run as a local-working-tree
 * dispatch: no source tarball is packed and the agent clones an empty URL.
 */
function makeBundle(): InternalEventDispatchContext['bundle'] {
  return {
    repoUrlBuilder: {
      buildCloneUrl: (repo: string) => `https://github.com/${repo}.git`,
    },
  } as unknown as InternalEventDispatchContext['bundle'];
}

/**
 * Minimal `ProcessingDeps` with a capturing dispatcher and NO db, so
 * `resolveOrgId` is not reached and the org falls back to `__default__`.
 */
function makeDeps(opts: { withCacheInfra?: boolean } = {}): {
  deps: ProcessingDeps;
  dispatched: QueuedJobInput[];
} {
  const dispatched: QueuedJobInput[] = [];
  const deps = {
    dispatcher: {
      dispatch: async (input: QueuedJobInput) => {
        dispatched.push(input);
        return { status: 'dispatched' as const, agentId: 'a1', jobId: `job-${dispatched.length}` };
      },
    },
    // The source-pack half of the real bag, absent by default so topology
    // assertions stay about the adapter; the build-job test supplies it.
    ...(opts.withCacheInfra && {
      buildCoordinator: {
        ensureBuild: async (_key: string, run: () => Promise<void>) => {
          await run();
        },
      },
      sourceCache: {
        has: async () => false,
        getUrl: async () => undefined,
        getUrlAndDigest: async () => null,
      },
    }),
  } as unknown as ProcessingDeps;
  return { deps, dispatched };
}

describe('dispatchInternalEventViaPipeline', () => {
  beforeEach(() => {
    core.seen.length = 0;
    core.results.length = 0;
    core.passthrough = false;
  });

  it('synthesizes a dispatch context and delegates to the shared pipeline', async () => {
    const ctx = makeInternalCtx({
      event: { id: 'evt-1', eventName: 'kici.scaler.scale-up', payload: { claimCode: 'abc' } },
      routingKey: 'github:1',
      repoIdentifier: 'acme/infra',
      chainDepth: 2,
    });
    const { deps } = makeDeps();

    const result = await dispatchInternalEventViaPipeline(
      makeDecision(),
      makeLockFile(),
      ctx,
      deps,
    );

    const built = core.seen[0]!;
    expect(built.event.type).toBe('kici_event');
    expect(built.event.payload).toEqual({ claimCode: 'abc' });
    expect(built.triggerEventOverride).toBe('kici.scaler.scale-up');
    expect(built.chainDepth).toBe(2);
    expect(built.securityDecision).toEqual({ action: 'pass' });
    expect(built.crossSource).toBe(false);
    expect(built.workflowRepoIdentifier).toBe('acme/infra');
    // An internal event dispatches the acting repository's own lock file.
    expect(built.repoIdentifier).toBe('acme/infra');
    expect(built.resolvedOrgId).toBe('__default__');
    expect(built.localWorkingTree).toBe(false);
    expect(built.info.deliveryId).toBe('evt-1');
    expect(built.info.provider).toBe('github');
    expect(result).toEqual({
      runId: built.runId,
      repo: 'acme/infra',
      workflow: 'notify',
    });
  });

  it('returns null when the decision names a workflow absent from the lock file', async () => {
    const { deps } = makeDeps();

    const result = await dispatchInternalEventViaPipeline(
      makeDecision({ workflowName: 'nope' }),
      makeLockFile(),
      makeInternalCtx(),
      deps,
    );

    expect(result).toBeNull();
    expect(core.seen).toHaveLength(0);
  });

  it('carries a system event through as its own trigger type and trigger event', async () => {
    const { deps } = makeDeps();

    await dispatchInternalEventViaPipeline(
      makeDecision(),
      makeLockFile(),
      makeInternalCtx({
        event: { id: 'sch-1', eventName: '__schedule_fire', payload: { commitSha: 'deadbeef' } },
        cronCommitSha: 'deadbeef',
        registrationDefaultBranch: 'main',
      }),
      deps,
    );

    const built = core.seen[0]!;
    expect(built.event.type).toBe('schedule');
    expect(built.triggerEventOverride).toBe('schedule');
    // A cron fire is the one internal event with a commit of its own; its
    // branch is the registration's default branch, never the commit sha.
    expect(built.ref).toBe('deadbeef');
    expect(built.event.targetBranch).toBe('main');
  });

  describe('branch provenance', () => {
    it('a schedule fire presents the registration default branch, not the commit sha', async () => {
      const { deps } = makeDeps();

      await dispatchInternalEventViaPipeline(
        makeDecision(),
        makeLockFile(),
        makeInternalCtx({
          event: { id: 'sch-1', eventName: '__schedule_fire', payload: {} },
          cronCommitSha: 'a'.repeat(40),
          registrationDefaultBranch: 'main',
        }),
        deps,
      );

      const built = core.seen[0]!;
      expect(built.event.targetBranch).toBe('main');
      // The commit still travels as the run row's sha, so the dashboard link
      // still points at the commit that registered the workflow.
      expect(built.ref).toBe('a'.repeat(40));
    });

    it('a schedule fire with no captured default branch presents no branch', async () => {
      const { deps } = makeDeps();

      await dispatchInternalEventViaPipeline(
        makeDecision(),
        makeLockFile(),
        makeInternalCtx({
          event: { id: 'sch-1', eventName: '__schedule_fire', payload: {} },
          cronCommitSha: 'b'.repeat(40),
          registrationDefaultBranch: null,
        }),
        deps,
      );

      // Never the sha: the gate rejects with its named cause rather than quote
      // a commit as a branch an operator could allow.
      expect(core.seen[0]!.event.targetBranch).toBe('');
    });

    it('keeps targetBranch omitted from the envelope user code observes', async () => {
      const { deps } = makeDeps();

      await dispatchInternalEventViaPipeline(
        makeDecision(),
        makeLockFile(),
        makeInternalCtx({
          event: { id: 'sch-1', eventName: '__schedule_fire', payload: {} },
          cronCommitSha: 'c'.repeat(40),
          registrationDefaultBranch: 'main',
        }),
        deps,
      );

      // Setting it would re-key the documented
      // `ctx.event.targetBranch ?? 'default'` concurrency group.
      expect(core.seen[0]!.eventEnvelopeOverride).not.toHaveProperty('targetBranch');
    });

    it('does not give a non-schedule internal event the registration default branch', async () => {
      const { deps } = makeDeps();

      await dispatchInternalEventViaPipeline(
        makeDecision(),
        makeLockFile(),
        makeInternalCtx({
          event: { id: 'evt-1', eventName: 'kici.scaler.scale-up', payload: {} },
          registrationDefaultBranch: 'main',
        }),
        deps,
      );

      // Only a schedule fire runs the default branch's lock file; everything
      // else inherits its emitter's branch.
      expect(core.seen[0]!.event.targetBranch).toBe('');
    });
  });

  it('leaves chainDepth unset for a run that starts its own chain', async () => {
    const { deps } = makeDeps();

    await dispatchInternalEventViaPipeline(makeDecision(), makeLockFile(), makeInternalCtx(), deps);

    expect('chainDepth' in core.seen[0]!).toBe(false);
  });

  it('threads a zero chainDepth rather than dropping it', async () => {
    // 0 is what the caller states. A truthiness guard would drop it as
    // "unset": the same value here, but not the same statement.
    const { deps } = makeDeps();

    await dispatchInternalEventViaPipeline(
      makeDecision(),
      makeLockFile(),
      makeInternalCtx({ chainDepth: 0 }),
      deps,
    );

    expect(core.seen[0]!.chainDepth).toBe(0);
  });

  it('falls back to the internal provider when the event carries no routing key', async () => {
    const { deps } = makeDeps();

    await dispatchInternalEventViaPipeline(
      makeDecision(),
      makeLockFile(),
      makeInternalCtx({ routingKey: '', providerType: undefined }),
      deps,
    );

    expect(core.seen[0]!.info.provider).toBe('internal');
  });

  it('marks a workflows_failed_batch dispatch so it cannot re-trigger itself', async () => {
    const { deps } = makeDeps();
    const lockFile = makeLockFile([
      { _type: 'workflows_failed_batch', accumulateFor: 60_000 } as LockTrigger,
    ]);

    await dispatchInternalEventViaPipeline(
      makeDecision({ matchedTrigger: 0 }),
      lockFile,
      makeInternalCtx({
        event: { id: 'b-1', eventName: '__workflows_failed_batch', payload: {} },
      }),
      deps,
    );

    expect(core.seen[0]!.dispatchedByFailureLifecycle).toBe(true);
  });

  it('marks a failed-status workflow_complete dispatch too', async () => {
    const { deps } = makeDeps();
    const lockFile = makeLockFile([
      { _type: 'workflow_complete', status: ['failed'] } as LockTrigger,
    ]);

    await dispatchInternalEventViaPipeline(
      makeDecision({ matchedTrigger: 0 }),
      lockFile,
      makeInternalCtx({
        event: { id: 'wc-1', eventName: '__workflow_complete', payload: {} },
      }),
      deps,
    );

    expect(core.seen[0]!.dispatchedByFailureLifecycle).toBe(true);
  });

  it('leaves a success-status workflow_complete dispatch unmarked', async () => {
    const { deps } = makeDeps();
    const lockFile = makeLockFile([
      { _type: 'workflow_complete', status: ['success'] } as LockTrigger,
    ]);

    await dispatchInternalEventViaPipeline(
      makeDecision({ matchedTrigger: 0 }),
      lockFile,
      makeInternalCtx({
        event: { id: 'wc-2', eventName: '__workflow_complete', payload: {} },
      }),
      deps,
    );

    expect('dispatchedByFailureLifecycle' in core.seen[0]!).toBe(false);
  });

  it('leaves the dispatch unmarked when the decision names no matched trigger', async () => {
    // `matchedTrigger` is optional on a decision, and `triggers[-1]` is
    // undefined — not a trigger whose `_type` may be read.
    const { deps } = makeDeps();
    const lockFile = makeLockFile([
      { _type: 'workflows_failed_batch', accumulateFor: 60_000 } as LockTrigger,
    ]);

    await dispatchInternalEventViaPipeline(makeDecision(), lockFile, makeInternalCtx(), deps);

    expect('dispatchedByFailureLifecycle' in core.seen[0]!).toBe(false);
  });

  /**
   * A schedule fire carries no operator input, so the trigger's declared
   * defaults are the ONLY source of `ctx.dispatchInputs`. Dropping them makes
   * `ctx.dispatchInputs.mode` `undefined` on a cron run while a dashboard fire
   * of the same workflow sees `'full'`.
   */
  const scheduleTrigger = (cronExpression: string, def: string): LockTrigger =>
    ({
      _type: 'schedule',
      cronExpression,
      timezone: 'UTC',
      inputs: { mode: { type: 'enum', values: ['full', 'quick'], default: def } },
    }) as unknown as LockTrigger;

  it('resolves the declared schedule input defaults for a cron fire', async () => {
    const { deps } = makeDeps();
    const lockFile = makeLockFile([scheduleTrigger('0 0 * * *', 'full')]);

    await dispatchInternalEventViaPipeline(
      makeDecision(),
      lockFile,
      makeInternalCtx({
        event: {
          id: 'evt-1',
          eventName: '__schedule_fire',
          payload: { cronExpression: '0 0 * * *', timezone: 'UTC' },
        },
      }),
      deps,
    );

    expect(core.seen[0]!.dispatchInputs).toEqual({ mode: 'full' });
  });

  it('resolves the schedule that actually fired when several are declared', async () => {
    const { deps } = makeDeps();
    const lockFile = makeLockFile([
      scheduleTrigger('0 9 * * 1', 'full'),
      scheduleTrigger('0 18 * * 5', 'quick'),
    ]);

    await dispatchInternalEventViaPipeline(
      makeDecision(),
      lockFile,
      makeInternalCtx({
        event: {
          id: 'evt-1',
          eventName: '__schedule_fire',
          payload: { cronExpression: '0 18 * * 5', timezone: 'UTC' },
        },
      }),
      deps,
    );

    expect(core.seen[0]!.dispatchInputs).toEqual({ mode: 'quick' });
  });

  it('falls back to the first schedule for an internal event carrying no cron', async () => {
    const { deps } = makeDeps();
    const lockFile = makeLockFile([
      scheduleTrigger('0 9 * * 1', 'full'),
      scheduleTrigger('0 18 * * 5', 'quick'),
    ]);

    await dispatchInternalEventViaPipeline(
      makeDecision(),
      lockFile,
      makeInternalCtx({
        event: { id: 'evt-1', eventName: '__workflow_complete', payload: {} },
      }),
      deps,
    );

    expect(core.seen[0]!.dispatchInputs).toEqual({ mode: 'full' });
  });

  it('omits dispatchInputs for a workflow with no schedule trigger', async () => {
    const { deps } = makeDeps();

    await dispatchInternalEventViaPipeline(makeDecision(), makeLockFile(), makeInternalCtx(), deps);

    expect('dispatchInputs' in core.seen[0]!).toBe(false);
  });

  it('builds a context the real dispatch core accepts, and the job sees the event', async () => {
    // Runs the SYNTHESIZED context through the real core, not a stub, and
    // asserts what reached the agent.
    core.passthrough = true;
    const { deps, dispatched } = makeDeps();

    const result = await dispatchInternalEventViaPipeline(
      makeDecision(),
      makeLockFile(),
      makeInternalCtx(),
      deps,
    );

    expect(result).not.toBeNull();
    expect(dispatched).toHaveLength(1);
    const jobConfig = dispatched[0].jobConfig as { event?: { type?: string } };
    expect(jobConfig.event?.type).toBe('kici_event');
    expect(dispatched[0].runId).toBe(result!.runId);
    // A missing bundle yields a blank clone URL, which fails at checkout.
    expect(dispatched[0].repoUrl).toBe('https://github.com/acme/infra.git');
    // The registration's provider context: what `onExecutionStarted` persists as
    // `execution_runs.provider_context`, and the run's forwarded `installationId`.
    expect(dispatched[0].providerContext).toEqual({ installationId: 4242 });
  });

  /**
   * The envelope reaches the agent as `RuleContext.event` and as the `event`
   * half of `buildConcurrencyGroupContext`, so user code reads every field as
   * fact. `targetBranch` and `changedFiles` must be ABSENT: an internal event
   * has no changed files, and its branch is provenance the orchestrator
   * evaluates. Publishing it would re-key the documented
   * `ctx.event.targetBranch ?? 'default'` concurrency group, and with
   * `cancelInProgress` on by default that changes the cancellation scope.
   * The shared pipeline's `SimulatedEvent` requires `targetBranch`, so only
   * this whitelist keeps it out.
   */
  it('fabricates no field the internal event does not actually carry', async () => {
    core.passthrough = true;
    const { deps, dispatched } = makeDeps();

    await dispatchInternalEventViaPipeline(
      makeDecision(),
      makeLockFile(),
      makeInternalCtx({
        event: {
          id: 'evt-1',
          eventName: '__schedule_fire',
          // The sharp case: the one internal event with its own commit; neither
          // that sha nor its branch may reach the envelope.
          payload: { commitSha: 'a'.repeat(40) },
        },
        cronCommitSha: 'a'.repeat(40),
      }),
      deps,
    );

    const event = (dispatched[0].jobConfig as { event: Record<string, unknown> }).event;
    expect(event).not.toHaveProperty('targetBranch');
    expect(event).not.toHaveProperty('changedFiles');
    // Whitelist, not a blacklist: a future fabricated sibling (sourceBranch,
    // changedFilesStatus, provider, …) fails here without anyone naming it.
    expect(Object.keys(event).sort()).toEqual(['payload', 'type']);
    expect(event.type).toBe('schedule');
  });

  /**
   * The provider bundle makes `cacheInfraAvailable` true for internal runs (the
   * real bag carries a `buildCoordinator` and a `sourceCache`), so a cron /
   * `kiciEvent()` / `__workflow_complete` run packs its source through a
   * synthetic `__build__` job before its static jobs, as a webhook run does.
   * This dispatch topology is deliberate, so it is asserted.
   */
  it('packs the source through a build job before the static jobs, like a webhook run', async () => {
    core.passthrough = true;
    const { deps, dispatched } = makeDeps({ withCacheInfra: true });

    await dispatchInternalEventViaPipeline(makeDecision(), makeLockFile(), makeInternalCtx(), deps);

    // Order matters: the static jobs depend on the pack the build job produces.
    expect(dispatched.map((d) => d.jobName)).toEqual(['__build__notify', 'build']);
    expect(dispatched[0].runsOnLabels).toContain('kici:role:builder');
    expect(new Set(dispatched.map((d) => d.runId)).size).toBe(1);
  });

  /**
   * The shared pipeline defers dynamic jobs to the agent init round rather
   * than filtering to `_type: 'static'`, so the workflow actually runs.
   */
  it('does not drop a dynamic job the bespoke path silently discarded', async () => {
    core.passthrough = true;
    const { deps } = makeDeps();
    const lockFile = makeLockFile([], { withDynamicJob: true });

    const result = await dispatchInternalEventViaPipeline(
      makeDecision(),
      lockFile,
      makeInternalCtx(),
      deps,
    );

    expect(result).not.toBeNull();
    const dispatchResult = core.results[0]!;
    // Dispatched or explicitly deferred to the init round, never discarded.
    expect(
      (dispatchResult.dispatchedJobCount ?? 0) + (dispatchResult.deferredJobCount ?? 0),
    ).toBeGreaterThan(1);
  });
});

/**
 * A chainable Kysely stand-in: builder methods return the chain and only the
 * terminals resolve. Rows are keyed by the `selectFrom` table, so the two-hop
 * trust lookup (`kici_events` → `execution_runs`) is driven by data: "no event
 * row", "no run row", "no tier" and "the lookup throws" need no extra mocks.
 *
 * `tablesRead` records every terminal, the only way to tell "resolved without a
 * lookup" from "looked up and happened to agree".
 */
function makeFakeDb(opts: {
  rows?: Record<string, Record<string, unknown> | undefined>;
  /**
   * Per-run `execution_runs` rows, keyed by the `run_id` the query filters on,
   * since batch classification reads SEVERAL runs from one table. A run id with
   * no entry answers `undefined`: the "row is gone" case.
   */
  runRows?: Record<string, Record<string, unknown> | undefined>;
  throwOnTable?: string;
}): { db: ProcessingDeps['db']; tablesRead: string[] } {
  const tablesRead: string[] = [];
  const chainFor = (table: string): unknown => {
    // Per-`selectFrom` state: `chainFor` runs once per query, so two lookups
    // against the same table never share a filter.
    let filteredRunId: string | undefined;
    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'where') {
            return (column: unknown, _op: unknown, value: unknown) => {
              if (column === 'run_id' && typeof value === 'string') filteredRunId = value;
              return chain;
            };
          }
          if (prop === 'executeTakeFirst' || prop === 'executeTakeFirstOrThrow') {
            return async () => {
              tablesRead.push(table);
              if (opts.throwOnTable === table) throw new Error(`db unavailable: ${table}`);
              if (opts.runRows && table === 'execution_runs' && filteredRunId !== undefined) {
                return opts.runRows[filteredRunId];
              }
              return opts.rows?.[table];
            };
          }
          if (prop === 'execute') {
            return async () => {
              tablesRead.push(table);
              if (opts.throwOnTable === table) throw new Error(`db unavailable: ${table}`);
              return [];
            };
          }
          // Not a thenable: an `await` on a half-built chain must not resolve it.
          if (prop === 'then') return undefined;
          return () => chain;
        },
      },
    );
    return chain;
  };
  const db = {
    selectFrom: chainFor,
    updateTable: chainFor,
    insertInto: chainFor,
    deleteFrom: chainFor,
    fn: { countAll: () => ({ as: () => 'count' }) },
    transaction: () => ({ execute: async (cb: (trx: unknown) => unknown) => cb(db) }),
  };
  return { db: db as unknown as ProcessingDeps['db'], tablesRead };
}

/** The emitting run's persisted row, as the trust lookup reads it. */
function emitterRun(trustTier: unknown, contributorUsername = 'octocat') {
  return { trust_tier: trustTier, contributor_username: contributorUsername };
}

/**
 * Trust classification for an internally-triggered run.
 *
 * `trustResolution: undefined` is NOT neutral: `deriveCacheRefScope` maps it to
 * the isolated user-cache scope, which the Dockerfile-build gate refuses, so
 * leaving it unset denies every cron-fired image build and re-namespaces every
 * internal run's user cache.
 *
 * Every case asserts the CONSEQUENCE the agent reads (`jobConfig.cacheRefScope`)
 * as well as the resolution. The `shared` cases, differing only in the fake db's
 * row, are the positive control that rules out a vacuous `isolated` assertion.
 */
describe('dispatchInternalEventViaPipeline — trust classification', () => {
  beforeEach(() => {
    core.seen.length = 0;
    core.results.length = 0;
    core.passthrough = true;
  });

  /** Dispatch one internal event end-to-end and report what reached the job. */
  async function dispatchWith(args: {
    eventName: string;
    db?: ProcessingDeps['db'];
    summonedByRunId?: string;
    payload?: Record<string, unknown>;
  }): Promise<{ trust: unknown; cacheRefScope: unknown }> {
    const { deps, dispatched } = makeDeps();
    const withDb = { ...(deps as object), ...(args.db ? { db: args.db } : {}) } as ProcessingDeps;

    const result = await dispatchInternalEventViaPipeline(
      makeDecision(),
      makeLockFile(),
      makeInternalCtx({
        event: {
          id: '11111111-2222-3333-4444-555555555555',
          eventName: args.eventName,
          ...(args.payload ? { payload: args.payload } : {}),
        },
        ...(args.summonedByRunId ? { summonedByRunId: args.summonedByRunId } : {}),
      }),
      withDb,
    );

    // A lookup never fails the dispatch — the run still happens, isolated.
    expect(result).not.toBeNull();
    expect(dispatched).toHaveLength(1);
    return {
      trust: core.seen[0]!.trustResolution,
      cacheRefScope: (dispatched[0].jobConfig as { cacheRefScope?: unknown }).cacheRefScope,
    };
  }

  it.each([
    // The cron scheduler mints this one from its own state — no run causes it,
    // so there is no emitter whose tier it could inherit.
    ['__schedule_fire'],
    // Minted by `ScalerManager` from its own state, refused from a workflow
    // step, and rate-exempt, like `__schedule_fire`. With no `sourceRunId`,
    // non-membership would leave no tier: isolated caches and a denied
    // `container: { dockerfile }` provisioning job.
    [SCALER_EVENT_NAMES.scaleUp],
    [SCALER_EVENT_NAMES.scaleDown],
  ])('%s is trusted — the orchestrator minted it, so nothing external shaped it', async (name) => {
    const { db, tablesRead } = makeFakeDb({ rows: {} });

    const { trust, cacheRefScope } = await dispatchWith({ eventName: name, db });

    expect((trust as { tier: string }).tier).toBe('trusted');
    expect(cacheRefScope).toBe('shared');
    // Resolved from the event NAME: a minted event has no emitting run, and
    // querying for one would be a fallback waiting to misfire.
    expect(tablesRead).not.toContain('kici_events');
  });

  /**
   * Lifecycle events a RUN causes carry its id as `source_run_id` and inherit
   * its tier, as a user `kiciEvent()` does. Classifying them by name would
   * launder privilege: an untrusted fork-PR run completes and its
   * `__workflow_complete` subscriber runs trusted.
   */
  it.each([['__workflow_complete'], ['__job_complete']])(
    '%s inherits its emitting run rather than claiming minted trust',
    async (name) => {
      const { db, tablesRead } = makeFakeDb({
        rows: {
          kici_events: { source_run_id: 'run-fork-pr' },
          execution_runs: emitterRun('unknown'),
        },
      });

      const { trust, cacheRefScope } = await dispatchWith({ eventName: name, db });

      expect((trust as { tier: string }).tier).toBe('unknown');
      expect(cacheRefScope).toBe('isolated');
      // The verdict came from the two-hop lookup, not from the name.
      expect(tablesRead).toContain('kici_events');
    },
  );

  it.each([['__workflow_complete'], ['__job_complete']])(
    '%s from a trusted emitter still runs shared — the change is a tightening, not a downgrade',
    async (name) => {
      const { db } = makeFakeDb({
        rows: {
          kici_events: { source_run_id: 'run-default-branch' },
          execution_runs: emitterRun('trusted', 'maintainer'),
        },
      });

      const { trust, cacheRefScope } = await dispatchWith({ eventName: name, db });

      expect((trust as { tier: string }).tier).toBe('trusted');
      expect((trust as { contributorUsername: string }).contributorUsername).toBe('maintainer');
      expect(cacheRefScope).toBe('shared');
    },
  );

  /**
   * `__workflows_failed_batch` has no `sourceRunId` (one event per swept window,
   * caused by many runs), so it resolves the MOST RESTRICTIVE tier across the
   * runs it names.
   */
  it('a batch of trusted runs resolves trusted', async () => {
    const { db } = makeFakeDb({
      runRows: { 'run-a': emitterRun('trusted'), 'run-b': emitterRun('trusted') },
    });

    const { trust, cacheRefScope } = await dispatchWith({
      eventName: '__workflows_failed_batch',
      db,
      payload: { total: 2, runs: [{ runId: 'run-a' }, { runId: 'run-b' }] },
    });

    expect((trust as { tier: string }).tier).toBe('trusted');
    expect(cacheRefScope).toBe('shared');
  });

  it('a batch mixing trusted with unknown resolves the most restrictive tier', async () => {
    const { db } = makeFakeDb({
      runRows: { 'run-a': emitterRun('trusted'), 'run-b': emitterRun('unknown') },
    });

    const { trust, cacheRefScope } = await dispatchWith({
      eventName: '__workflows_failed_batch',
      db,
      payload: { total: 2, runs: [{ runId: 'run-a' }, { runId: 'run-b' }] },
    });

    expect((trust as { tier: string }).tier).toBe('unknown');
    expect(cacheRefScope).toBe('isolated');
  });

  /**
   * The retry scanner caps `runs` at `BATCH_MAX_RUNS` while `total` stays the
   * true count, so a capped batch's `runs` is a SAMPLE whose minimum proves
   * nothing. It fails safe to isolated; an all-trusted sample would otherwise
   * fail open.
   */
  it('a capped batch is isolated even when every run it carries is trusted', async () => {
    const { db, tablesRead } = makeFakeDb({
      runRows: { 'run-a': emitterRun('trusted'), 'run-b': emitterRun('trusted') },
    });

    const { trust, cacheRefScope } = await dispatchWith({
      eventName: '__workflows_failed_batch',
      db,
      payload: { total: 201, runs: [{ runId: 'run-a' }, { runId: 'run-b' }] },
    });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
    // Refused WITHOUT reading any run.
    expect(tablesRead).not.toContain('execution_runs');
  });

  it.each([
    ['an empty runs list', { total: 0, runs: [] }],
    ['an absent runs list', { total: 3 }],
    ['a payload with no total', { runs: [{ runId: 'run-a' }] }],
    ['a runs entry with no runId', { total: 1, runs: [{ repo: 'acme/api' }] }],
    ['an empty payload', {}],
  ])('a batch carrying %s is isolated', async (_label, payload) => {
    const { db } = makeFakeDb({ runRows: { 'run-a': emitterRun('trusted') } });

    const { trust, cacheRefScope } = await dispatchWith({
      eventName: '__workflows_failed_batch',
      db,
      payload: payload as Record<string, unknown>,
    });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  it('a batch whose run row is gone is isolated, not silently narrowed to the rest', async () => {
    // One unreadable member makes the minimum unknowable, which takes the strict
    // path rather than the tiers that did resolve.
    const { db } = makeFakeDb({ runRows: { 'run-a': emitterRun('trusted') } });

    const { trust, cacheRefScope } = await dispatchWith({
      eventName: '__workflows_failed_batch',
      db,
      payload: { total: 2, runs: [{ runId: 'run-a' }, { runId: 'run-gone' }] },
    });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  it('a batch whose run lookup throws degrades to isolated', async () => {
    const { db } = makeFakeDb({
      runRows: { 'run-a': emitterRun('trusted') },
      throwOnTable: 'execution_runs',
    });

    const { trust, cacheRefScope } = await dispatchWith({
      eventName: '__workflows_failed_batch',
      db,
      payload: { total: 1, runs: [{ runId: 'run-a' }] },
    });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  it('a batch dispatched with no db at all is isolated', async () => {
    const { trust, cacheRefScope } = await dispatchWith({
      eventName: '__workflows_failed_batch',
      payload: { total: 1, runs: [{ runId: 'run-a' }] },
    });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  it.each([
    // Negative control for the rows above: membership is the ENUMERATED name,
    // never the `kici.` prefix, so an unrecognized reserved name takes the
    // strict path, as in the `__` namespace.
    ['kici.scaler.scale-sideways'],
    ['kici.something.else'],
    ['kici.'],
  ])('%s is NOT minted — an unrecognized reserved name stays isolated', async (name) => {
    const { db } = makeFakeDb({ rows: {} });

    const { trust, cacheRefScope } = await dispatchWith({ eventName: name, db });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  it('inherits a trusted emitter — a default-branch push subscriber stays shared', async () => {
    const { db } = makeFakeDb({
      rows: {
        kici_events: { source_run_id: 'run-emitter' },
        execution_runs: emitterRun('trusted'),
      },
    });

    const { trust, cacheRefScope } = await dispatchWith({ eventName: 'my.custom.event', db });

    expect((trust as { tier: string; contributorUsername: string }).tier).toBe('trusted');
    // The emitter's contributor, whom the subscriber's privilege answers to,
    // travels with the tier.
    expect((trust as { contributorUsername: string }).contributorUsername).toBe('octocat');
    expect(cacheRefScope).toBe('shared');
  });

  it('inherits an unknown emitter — a fork-PR subscriber cannot launder its way to shared', async () => {
    const { db } = makeFakeDb({
      rows: {
        kici_events: { source_run_id: 'run-emitter' },
        execution_runs: emitterRun('unknown'),
      },
    });

    const { trust, cacheRefScope } = await dispatchWith({ eventName: 'my.custom.event', db });

    // The tier is carried, not blanked: `unknown` is STRICTER than `undefined`
    // at the context trust gate (which passes an unresolved tier) and at the
    // install-secrets registry gate.
    expect((trust as { tier: string }).tier).toBe('unknown');
    expect(cacheRefScope).toBe('isolated');
  });

  it('a feature-branch emitter (no persisted tier) leaves the subscriber isolated', async () => {
    const { db } = makeFakeDb({
      rows: {
        kici_events: { source_run_id: 'run-emitter' },
        execution_runs: emitterRun(null),
      },
    });

    const { trust, cacheRefScope } = await dispatchWith({ eventName: 'my.custom.event', db });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  /**
   * A stored tier the schema does not admit (an older row's `known`, meaning
   * "not trusted") is still a tier the run carried. It inherits as `unknown`,
   * never unresolved: `isUntrustedTier(undefined)` is `false`, so an unresolved
   * read would let the subscriber PASS the trust gate its emitter was held at.
   */
  it.each([['known'], ['super-trusted']])(
    // fails-when: a non-null stored tier that fails the schema reads as unresolved
    'a stored %s tier the schema no longer admits inherits as unknown, not as unresolved',
    async (stored) => {
      const { db } = makeFakeDb({
        rows: {
          kici_events: { source_run_id: 'run-emitter' },
          execution_runs: emitterRun(stored),
        },
      });

      const { trust, cacheRefScope } = await dispatchWith({ eventName: 'my.custom.event', db });

      expect((trust as { tier: string }).tier).toBe('unknown');
      expect(cacheRefScope).toBe('isolated');
    },
  );

  // fails-when: one `known` member reads as unresolved and the batch, instead of
  // resolving `unknown`, is refused outright — or worse, narrowed to the rest
  it('a batch carrying a stored known member resolves unknown', async () => {
    const { db } = makeFakeDb({
      runRows: { 'run-a': emitterRun('trusted'), 'run-b': emitterRun('known') },
    });

    const { trust, cacheRefScope } = await dispatchWith({
      eventName: '__workflows_failed_batch',
      db,
      payload: { total: 2, runs: [{ runId: 'run-a' }, { runId: 'run-b' }] },
    });

    expect((trust as { tier: string }).tier).toBe('unknown');
    expect(cacheRefScope).toBe('isolated');
  });

  it('an event with no source_run_id has no emitter to inherit from', async () => {
    const { db, tablesRead } = makeFakeDb({
      rows: {
        kici_events: { source_run_id: null },
        // Present, and deliberately trusted: reaching it would be the bug.
        execution_runs: emitterRun('trusted'),
      },
    });

    const { trust, cacheRefScope } = await dispatchWith({ eventName: 'my.custom.event', db });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
    expect(tablesRead).not.toContain('execution_runs');
  });

  it('a missing event row falls back to isolated', async () => {
    const { db } = makeFakeDb({ rows: { execution_runs: emitterRun('trusted') } });

    const { trust, cacheRefScope } = await dispatchWith({ eventName: 'my.custom.event', db });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  it('a run row that no longer exists falls back to isolated', async () => {
    const { db, tablesRead } = makeFakeDb({
      rows: { kici_events: { source_run_id: 'run-gone' } },
    });

    const { trust, cacheRefScope } = await dispatchWith({ eventName: 'my.custom.event', db });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
    // The fallback follows an empty result, not a skipped query.
    expect(tablesRead).toContain('execution_runs');
  });

  it('a lookup that throws degrades to isolated instead of failing the dispatch', async () => {
    const { db } = makeFakeDb({
      rows: { kici_events: { source_run_id: 'run-emitter' } },
      throwOnTable: 'kici_events',
    });

    const { trust, cacheRefScope } = await dispatchWith({ eventName: 'my.custom.event', db });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  it('a run row lookup that throws degrades to isolated too', async () => {
    const { db } = makeFakeDb({
      rows: { kici_events: { source_run_id: 'run-emitter' } },
      throwOnTable: 'execution_runs',
    });

    const { trust, cacheRefScope } = await dispatchWith({ eventName: 'my.custom.event', db });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  it('a user event dispatched with no db at all is isolated', async () => {
    const { trust, cacheRefScope } = await dispatchWith({ eventName: 'my.custom.event' });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  it('an unrecognized __-prefixed name takes the strict path, not the minted one', async () => {
    // The minted set is enumerated, not prefix-matched: an unemitted `__`-name
    // may be externally shaped, so it inherits (no emitter: isolated).
    const { db, tablesRead } = makeFakeDb({ rows: {} });

    const { trust, cacheRefScope } = await dispatchWith({ eventName: '__not_a_real_event', db });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
    expect(tablesRead).toContain('kici_events');
  });
  /**
   * An invoke-gate summon states its emitting run directly. Its synthesized
   * event id (`invoke-<uuid>`) matches no `kici_events` row, so the event
   * lookup would ALWAYS return isolated, wrong for a trusted summoner and a
   * warn-level error on every summon.
   */
  it('a summoned run inherits its summoner directly, with no event lookup', async () => {
    const { db, tablesRead } = makeFakeDb({
      rows: {
        execution_runs: emitterRun('trusted', 'maintainer'),
        // Present and pointing at nothing: reaching it would be the bug.
        kici_events: { source_run_id: null },
      },
    });

    const { trust, cacheRefScope } = await dispatchWith({
      eventName: 'my.custom.event',
      db,
      summonedByRunId: 'run-summoner',
    });

    expect((trust as { tier: string }).tier).toBe('trusted');
    expect((trust as { contributorUsername: string }).contributorUsername).toBe('maintainer');
    expect(cacheRefScope).toBe('shared');
    expect(tablesRead).toContain('execution_runs');
    expect(tablesRead).not.toContain('kici_events');
  });

  it('a summoned run inherits a non-trusted summoner rather than laundering it', async () => {
    const { db } = makeFakeDb({ rows: { execution_runs: emitterRun('unknown') } });

    const { trust, cacheRefScope } = await dispatchWith({
      eventName: 'my.custom.event',
      db,
      summonedByRunId: 'run-summoner',
    });

    expect((trust as { tier: string }).tier).toBe('unknown');
    expect(cacheRefScope).toBe('isolated');
  });

  it('a summoner whose run row is gone leaves the summoned run isolated', async () => {
    const { db } = makeFakeDb({ rows: {} });

    const { trust, cacheRefScope } = await dispatchWith({
      eventName: 'my.custom.event',
      db,
      summonedByRunId: 'run-gone',
    });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  it('a summoner lookup that throws leaves the summoned run isolated', async () => {
    const { db } = makeFakeDb({
      rows: { execution_runs: emitterRun('trusted') },
      throwOnTable: 'execution_runs',
    });

    const { trust, cacheRefScope } = await dispatchWith({
      eventName: 'my.custom.event',
      db,
      summonedByRunId: 'run-summoner',
    });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  /**
   * The summon check runs BEFORE the minted-name check. A gate's event name is
   * workflow-authored (`invokeSource('__schedule_fire')`), so minted-first
   * would let a workflow grant its own summoned run the trusted tier. The name
   * is refused upstream too (`runInvokeGate`, `buildSummonCallback`,
   * `invokeSource`); this pins the classifier independently.
   */
  it.each([['__schedule_fire'], ['__workflow_complete'], ['__job_complete']])(
    'a summoned run naming %s still inherits, and is never granted minted-trust',
    async (eventName) => {
      const { db } = makeFakeDb({ rows: { execution_runs: emitterRun('unknown') } });

      const { trust, cacheRefScope } = await dispatchWith({
        eventName,
        db,
        summonedByRunId: 'run-summoner',
      });

      expect((trust as { tier: string }).tier).toBe('unknown');
      expect(cacheRefScope).toBe('isolated');
    },
  );

  it('a summoned run naming a minted event with an unknown summoner is isolated', async () => {
    // No summoner row: minted-first would return `trusted`; summon-first
    // returns the strict fallback.
    const { db } = makeFakeDb({ rows: {} });

    const { trust, cacheRefScope } = await dispatchWith({
      eventName: '__schedule_fire',
      db,
      summonedByRunId: 'run-gone',
    });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });

  it('a summoned run with no db is isolated', async () => {
    const { trust, cacheRefScope } = await dispatchWith({
      eventName: 'my.custom.event',
      summonedByRunId: 'run-summoner',
    });

    expect(trust).toBeUndefined();
    expect(cacheRefScope).toBe('isolated');
  });
});

/**
 * Branch inheritance for a non-schedule internal trigger.
 *
 * A `kiciEvent()` subscriber, an invoke-gate summon, and the lifecycle events
 * run off one emitting run and present its branch to context branch
 * restrictions; otherwise a `main`-restricted context rejects every
 * event-triggered run.
 *
 * The `main` cases, differing only in the fake db's row, are the positive
 * control that rules out a vacuous `''` assertion.
 */
describe('dispatchInternalEventViaPipeline — inherited branch', () => {
  beforeEach(() => {
    core.seen.length = 0;
    core.results.length = 0;
    core.passthrough = false;
  });

  async function presentedBranchFor(args: {
    eventName: string;
    db?: ProcessingDeps['db'];
    summonedByRunId?: string;
    payload?: Record<string, unknown>;
    registrationDefaultBranch?: string | null;
  }): Promise<string> {
    const { deps } = makeDeps();
    const withDb = { ...(deps as object), ...(args.db ? { db: args.db } : {}) } as ProcessingDeps;

    await dispatchInternalEventViaPipeline(
      makeDecision(),
      makeLockFile(),
      makeInternalCtx({
        event: {
          id: '11111111-2222-3333-4444-555555555555',
          eventName: args.eventName,
          ...(args.payload ? { payload: args.payload } : {}),
        },
        ...(args.summonedByRunId ? { summonedByRunId: args.summonedByRunId } : {}),
        ...(args.registrationDefaultBranch !== undefined && {
          registrationDefaultBranch: args.registrationDefaultBranch,
        }),
      }),
      withDb,
    );

    return core.seen[0]!.event.targetBranch;
  }

  it('a kiciEvent() subscriber presents the emitting run branch', async () => {
    const { db } = makeFakeDb({
      rows: {
        kici_events: { source_run_id: 'run-1' },
        execution_runs: { ...emitterRun('trusted'), ref: 'main' },
      },
    });

    expect(await presentedBranchFor({ eventName: 'deploy.requested', db })).toBe('main');
  });

  it.each([['__workflow_complete'], ['__job_complete']])(
    '%s presents the completing run branch',
    async (name) => {
      const { db } = makeFakeDb({
        rows: {
          kici_events: { source_run_id: 'run-1' },
          execution_runs: { ...emitterRun('trusted'), ref: 'release/1.2' },
        },
      });

      expect(await presentedBranchFor({ eventName: name, db })).toBe('release/1.2');
    },
  );

  it('an invoke-gate summon inherits its summoner branch', async () => {
    const { db } = makeFakeDb({
      runRows: { 'run-summoner': { ...emitterRun('trusted'), ref: 'main' } },
    });

    expect(
      await presentedBranchFor({
        eventName: 'build.artifacts',
        db,
        summonedByRunId: 'run-summoner',
      }),
    ).toBe('main');
  });

  it('presents no branch when the emitting run ref is a commit sha', async () => {
    // An older run can hold the cron commit sha in `ref`; passing it on would
    // quote a sha as a branch, which the named-cause verdict exists to prevent.
    const { db } = makeFakeDb({
      rows: {
        kici_events: { source_run_id: 'run-1' },
        execution_runs: { ...emitterRun('trusted'), ref: 'd'.repeat(40) },
      },
    });

    expect(await presentedBranchFor({ eventName: 'deploy.requested', db })).toBe('');
  });

  it('presents no branch when the event names no emitting run', async () => {
    const { db } = makeFakeDb({ rows: { kici_events: { source_run_id: null } } });

    expect(await presentedBranchFor({ eventName: 'deploy.requested', db })).toBe('');
  });

  it('presents no branch when the emitting run row is gone', async () => {
    const { db } = makeFakeDb({
      rows: { kici_events: { source_run_id: 'run-1' }, execution_runs: undefined },
    });

    expect(await presentedBranchFor({ eventName: 'deploy.requested', db })).toBe('');
  });

  it('presents no branch when the lookup throws', async () => {
    const { db } = makeFakeDb({
      rows: { kici_events: { source_run_id: 'run-1' } },
      throwOnTable: 'execution_runs',
    });

    expect(await presentedBranchFor({ eventName: 'deploy.requested', db })).toBe('');
  });

  it('still inherits the branch when the emitting run tier is unreadable', async () => {
    // An unreadable tier isolates the caches; it says nothing about the branch.
    const { db } = makeFakeDb({
      rows: {
        kici_events: { source_run_id: 'run-1' },
        execution_runs: { trust_tier: 'not-a-tier', contributor_username: 'octocat', ref: 'main' },
      },
    });

    expect(await presentedBranchFor({ eventName: 'deploy.requested', db })).toBe('main');
  });

  it('a scaler event presents no branch — nothing caused it', async () => {
    const { db } = makeFakeDb({ rows: {} });

    expect(await presentedBranchFor({ eventName: SCALER_EVENT_NAMES.scaleUp, db })).toBe('');
  });

  it('a failure batch presents no branch — many runs on many branches caused it', async () => {
    const { db } = makeFakeDb({
      runRows: { 'run-a': { ...emitterRun('trusted'), ref: 'main' } },
    });

    expect(
      await presentedBranchFor({
        eventName: '__workflows_failed_batch',
        db,
        payload: { total: 1, runs: [{ runId: 'run-a' }] },
      }),
    ).toBe('');
  });
});

/**
 * The restrictiveness ranking must answer for EVERY tier the schema admits.
 *
 * An unranked tier fails open: it compares as less restrictive than `trusted`,
 * so a batch carrying one resolves `trusted`. `Record<TrustTier, number>` fails
 * the build on one; this reads the LIVE `TrustTierSchema.options` so a cast
 * cannot hide drift either.
 */
describe('trust tier restrictiveness ranking', () => {
  it('ranks every tier the schema admits', () => {
    expect(trustTierRanksCoverEverySchemaTier()).toBe(true);
  });
});
