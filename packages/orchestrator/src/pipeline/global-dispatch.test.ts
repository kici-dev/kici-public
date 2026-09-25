import { describe, expect, it, vi } from 'vitest';
import type { LockJob, LockWorkflow, SimulatedEvent, WorkflowDecision } from '@kici-dev/engine';
import {
  dispatchMatchedWorkflow,
  type WorkflowDispatchContext,
} from './dispatch-matched-workflow.js';
import { dispatchGlobalCandidateViaPipeline, globalRunLockFile } from './global-dispatch.js';
import { makeGateTracker, makeJobContextRow } from './dispatch-matched-workflow.test-helpers.js';
import type { ProcessingDeps } from './processor.js';
import type { ProviderBundle, ProviderRegistry } from '../provider-registry.js';
import { resolveDispatchCloneAuth } from '../git/dispatch-git-auth.js';
import type { QueuedJobInput } from '../queue/job-queue.js';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import type { DepCacheKey } from '@kici-dev/shared';
import type { WebhookInfo } from '../webhook/handler.js';

const WORKFLOW_REPO = 'org/ci';
const SOURCE_REPO = 'org/app';
const CONTEXT_NAME = 'deploy';
const INBOUND_ROUTING_KEY = 'rk-B';
const WORKFLOW_ROUTING_KEY = 'rk-A';
const SOURCE_CREDENTIALS = { installationId: 3 };
const REG_PROVIDER_CONTEXT = { installationId: 9 };

/**
 * A global workflow's job config fields that name which repository a dispatch
 * acted on or was defined in. Everything else must be identical between a
 * same-repo and a cross-repo dispatch of the same workflow.
 */
const IDENTITY_FIELDS = new Set([
  'isGlobalWorkflow',
  'workflowRepoUrl',
  'workflowRef',
  'workflowSha',
  'workflowRepoIdentifier',
  'workflowRoutingKey',
  'workflowProviderContext',
  'cacheRepoId',
]);

/**
 * Top-level `QueuedJobInput` fields that name the checkout (the source
 * repository and its credentials) or the run. `jobConfig` is compared on its
 * own, field by field.
 */
const INPUT_IDENTITY_FIELDS = new Set([
  'repoUrl',
  'providerContext',
  'routingKey',
  'runId',
  'jobConfig',
]);

/**
 * A job config with its identity fields removed. The event envelope stays in
 * the comparison except for `sourceRepo`, which names the repository the event
 * came from and so differs by design.
 */
function comparableJobConfig(jobConfig: Record<string, unknown>): Record<string, unknown> {
  const rest = omit(jobConfig, IDENTITY_FIELDS);
  const event = jobConfig.event as Record<string, unknown> | undefined;
  return { ...rest, ...(event && { event: { ...event, sourceRepo: undefined } }) };
}

/**
 * Positional `onExecutionStarted` arguments that name the run or its source
 * repository: the run id and the source repository. The workflow-repository
 * provenance argument is located by its shape.
 */
const RUN_ROW_IDENTITY_ARGS = new Set([0, 3]);

/** Index of the `{ identifier, sha, branch }` provenance argument of an `onExecutionStarted` call. */
function provenanceIndex(args: unknown[]): number {
  return args.findIndex(
    (a) => typeof a === 'object' && a !== null && 'identifier' in a && 'branch' in a,
  );
}

function omit(obj: Record<string, unknown>, keys: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.has(k)));
}

/** A bundle that builds `https://git.example/<repo>.git` and mints `${label}:${repo}`. */
function makeBundle(label: string) {
  const createCloneToken = vi.fn(async (repo: string) => `${label}:${repo}`);
  const bundle = {
    normalizer: { provider: 'github' },
    repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://git.example/${repo}.git` },
    cloneTokenProvider: { createCloneToken },
  } as unknown as ProviderBundle;
  return { bundle, createCloneToken };
}

/**
 * A global workflow whose jobs exercise every field the job-config builder
 * reads: container, env, timeout, resources, runsOnPick, matrix, contexts,
 * gitCredentials and needs. No approval, so nothing is held.
 */
function richGlobalLockEntry(): LockWorkflow {
  const publish: LockJob = {
    _type: 'static',
    name: 'publish',
    runsOn: [{ kind: 'exact', value: 'linux' }],
    runsOnPick: 'any',
    needs: [],
    steps: [{ name: 'publish', run: 'npm publish' }],
    contexts: [{ value: CONTEXT_NAME, dynamic: false }],
    env: { STAGE: 'prod' },
    timeout: 600_000,
    resources: { requests: { cpus: 2, memory: '2Gi' } },
    container: { image: 'node:22' },
    gitCredentials: { default: { tokenSecret: `${CONTEXT_NAME}:GIT_TOKEN` } },
    matrix: { _type: 'static', values: { node: ['20', '22'] } },
  } as unknown as LockJob;
  const test: LockJob = {
    _type: 'static',
    name: 'test',
    runsOn: [{ kind: 'exact', value: 'linux' }],
    needs: [],
    steps: [{ name: 'test', run: 'npm test' }],
  } as unknown as LockJob;
  return {
    name: 'release',
    source: { file: '.kici/workflows/release.ts', export: '#default' },
    contentHash: 'wf-hash',
    triggers: [],
    jobs: [test, publish],
  } as unknown as LockWorkflow;
}

const event: SimulatedEvent = {
  type: 'push',
  action: undefined,
  targetBranch: 'main',
  sourceBranch: undefined,
  payload: { ref: 'refs/heads/main' },
  changedFiles: undefined,
};

const info: WebhookInfo = {
  routingKey: INBOUND_ROUTING_KEY,
  deliveryId: 'delivery-1',
  event: 'push',
  action: null,
  provider: 'github',
  payload: { ref: 'refs/heads/main' },
};

const decision = {
  workflowName: 'release',
  matched: true,
  checks: [],
  summary: 'matched',
} as unknown as WorkflowDecision;

const NO_DEP_KEY: DepCacheKey = { lockfileHash: null, siblingsDigest: null };
const DEP_KEY: DepCacheKey = { lockfileHash: 'lock-hash-1', siblingsDigest: 'siblings-1' };
const DEPS_URL = 'https://cache.example/deps/linux-x64/deps-hash-1.tar.gz';

/** A dependency cache that holds a tarball for every key it is asked about. */
function makeDepCache() {
  return {
    has: vi.fn(async () => true),
    getUrlAndHash: vi.fn(async () => ({ url: DEPS_URL, hash: 'deps-hash-1' })),
  };
}

/** The dependency-cache setup of one dispatch: the lock-file key and the cache it probes. */
interface DepSetup {
  key: DepCacheKey;
  depCache: ReturnType<typeof makeDepCache>;
  /** Further cache deps: a source cache, a build coordinator. */
  extraDeps?: Record<string, unknown>;
}

/** Deps shared by both sides: a capturing dispatcher, a tracker, the context and secret stubs. */
function makeDeps(workflowBundle: ProviderBundle, dep?: Omit<DepSetup, 'key'>) {
  const dispatched: QueuedJobInput[] = [];
  // A build job registers the run and waits for its registration window to land.
  const tracker = {
    ...makeGateTracker(),
    registrationWindowSettled: vi.fn().mockResolvedValue(undefined),
  };
  const deps = {
    dispatcher: {
      dispatch: async (input: QueuedJobInput) => {
        dispatched.push(input);
        return { status: 'dispatched' as const, agentId: 'a1', jobId: `job-${dispatched.length}` };
      },
    },
    executionTracker: tracker,
    contextStore: {
      matchContext: async (_org: string, n: string) =>
        n === CONTEXT_NAME
          ? makeJobContextRow(n, {} as never, { repo_patterns: [WORKFLOW_REPO] })
          : null,
    },
    secretResolver: {
      resolveForContext: async () => ({ GIT_TOKEN: 'secret-value' }),
      resolveNamedInternal: async () => null,
      resolveForContextWithMeta: async () => ({ GIT_TOKEN: 'secret-value' }),
    },
    providerRegistry: {
      getByRoutingKey: (key: string) => (key === WORKFLOW_ROUTING_KEY ? workflowBundle : undefined),
    },
    // Present so a workflow `filter` would defer its jobs to an init job.
    pendingInits: {
      track: vi.fn(async () => ({})),
      resolve: vi.fn(),
      reject: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      cleanup: vi.fn(),
    },
    ...(dep && { depCache: dep.depCache, ...dep.extraDeps }),
  } as unknown as ProcessingDeps;
  return { deps, dispatched, tracker };
}

function registration(lockEntry: LockWorkflow, key: DepCacheKey = NO_DEP_KEY): RegisteredWorkflow {
  return {
    id: 'reg-1',
    repoIdentifier: WORKFLOW_REPO,
    workflowName: lockEntry.name,
    lockEntry,
    triggerTypes: ['push'],
    routingKey: WORKFLOW_ROUTING_KEY,
    providerContext: REG_PROVIDER_CONTEXT,
    disabled: false,
    isGlobal: true,
    customerId: 'org-1',
    commitSha: 'a1',
    defaultBranch: 'main',
    sourceFile: '.kici/workflows/release.ts',
    ...key,
  };
}

/** The workflow dispatched by an event from its own repository, through the per-repo pipeline. */
async function dispatchSameRepo(lockEntry: LockWorkflow, dep?: DepSetup) {
  const { bundle } = makeBundle('A');
  const { deps, dispatched, tracker } = makeDeps(bundle, dep);
  const ctx: WorkflowDispatchContext = {
    info,
    deps,
    bundle,
    payload: info.payload,
    repoIdentifier: WORKFLOW_REPO,
    workflowRepoIdentifier: WORKFLOW_REPO,
    credentials: SOURCE_CREDENTIALS,
    event: { ...event, sourceRepo: WORKFLOW_REPO },
    eventWithFiles: { ...event, sourceRepo: WORKFLOW_REPO },
    ref: 's1',
    fullLockFile: {
      workflows: [lockEntry],
      lockfileHash: dep?.key.lockfileHash ?? undefined,
      ...(dep?.key.siblingsDigest && { siblingsDigest: dep.key.siblingsDigest }),
      source: { file: '.kici/workflows/release.ts' },
    },
    resolvedOrgId: 'org-1',
    workflow: lockEntry,
    decision,
    runId: 'run-same',
    trustResolution: undefined,
    lockFileSource: undefined,
    localWorkingTree: false,
    crossSource: false,
    securityDecision: { action: 'pass' },
  };
  await dispatchMatchedWorkflow(ctx);
  return { dispatched, tracker };
}

/** The same workflow dispatched by an event from another repository, through the global path. */
async function dispatchCrossRepo(
  lockEntry: LockWorkflow,
  inbound = makeBundle('B'),
  dep?: DepSetup,
) {
  const workflowSide = makeBundle('A');
  const { deps, dispatched, tracker } = makeDeps(workflowSide.bundle, dep);
  const crossEvent = { ...event, sourceRepo: SOURCE_REPO };
  const runId = await dispatchGlobalCandidateViaPipeline({
    info,
    deps,
    payload: info.payload,
    sourceBundle: inbound.bundle,
    sourceRepoIdentifier: SOURCE_REPO,
    sourceCredentials: SOURCE_CREDENTIALS,
    event: crossEvent,
    eventWithFiles: crossEvent,
    ref: 's1',
    resolvedOrgId: 'org-1',
    trustResolution: undefined,
    securityDecision: { action: 'pass' },
    resolved: {
      candidate: { reg: registration(lockEntry, dep?.key), lockEntry, decision },
      jobs: lockEntry.jobs as LockJob[],
    },
  });
  return { runId, dispatched, tracker, workflowSide, inbound };
}

describe('dispatchGlobalCandidateViaPipeline', () => {
  /**
   * A global workflow dispatched for an event from its own repository and for an event from
   * another repository produces the same job configs, except the identity fields.
   * fails-when: any job-config or run-row field outside IDENTITY_FIELDS differs — including a
   *   field a future feature adds to only one path.
   * breaks-if-wrong: the same-repo side is the unmodified per-repo pipeline; if it changes,
   *   the existing DMW suite fails too.
   */
  it('same-repo and cross-repo dispatch of one global workflow differ only in identity fields', async () => {
    const lockEntry = richGlobalLockEntry();
    const sameRepo = await dispatchSameRepo(lockEntry);
    const crossRepo = await dispatchCrossRepo(lockEntry);
    // Positive control: the rich entry fans out and binds its context on both sides, so the
    // comparison below runs over populated configs rather than two empty lists.
    expect(sameRepo.dispatched.map((j) => j.jobName)).toHaveLength(3);
    expect(sameRepo.dispatched.some((j) => j.jobConfig.secrets)).toBe(true);
    expect(crossRepo.dispatched.map((j) => j.jobName)).toEqual(
      sameRepo.dispatched.map((j) => j.jobName),
    );
    for (const [i, job] of crossRepo.dispatched.entries()) {
      const same = sameRepo.dispatched[i];
      expect(comparableJobConfig(job.jobConfig)).toEqual(comparableJobConfig(same.jobConfig));
      // The queue input around the config: selectors, resources, timeouts, cache
      // artefacts and pins must match too.
      const a = omit(same as unknown as Record<string, unknown>, INPUT_IDENTITY_FIELDS);
      const b = omit(job as unknown as Record<string, unknown>, INPUT_IDENTITY_FIELDS);
      expect(b).toEqual(a);
    }
    // The exempt event field is the only event difference, and it names each side's source.
    expect((crossRepo.dispatched[0].jobConfig.event as { sourceRepo?: string }).sourceRepo).toBe(
      SOURCE_REPO,
    );
    const sameRow = sameRepo.tracker.onExecutionStarted.mock.calls[0] as unknown[];
    const crossRow = crossRepo.tracker.onExecutionStarted.mock.calls[0] as unknown[];
    const provenanceAt = provenanceIndex(crossRow);
    const rowFields = (args: unknown[]) =>
      args.filter((_, i) => !RUN_ROW_IDENTITY_ARGS.has(i) && i !== provenanceAt);
    expect(rowFields(crossRow)).toEqual(rowFields(sameRow));
    // The excluded positions carry what they claim to: the source repo and the provenance,
    // which a same-repo run leaves unset.
    expect(crossRow[3]).toBe(SOURCE_REPO);
    expect(crossRow[provenanceAt]).toEqual({
      identifier: WORKFLOW_REPO,
      sha: 'a1',
      branch: 'main',
    });
    expect(sameRow[provenanceAt] ?? undefined).toBeUndefined();
  });

  it("cross-provider global mints A's credentials from A's bundle and B's from the inbound bundle", async () => {
    // fails-when: the workflow clone token is minted from the inbound (B) bundle
    const lockEntry = richGlobalLockEntry();
    const { dispatched, workflowSide, inbound } = await dispatchCrossRepo(lockEntry);
    const job = dispatched[0];
    expect(job.jobConfig.workflowProviderContext).toMatchObject(REG_PROVIDER_CONTEXT);
    expect(workflowSide.createCloneToken).toHaveBeenCalledWith(WORKFLOW_REPO, REG_PROVIDER_CONTEXT);
    expect(inbound.createCloneToken).not.toHaveBeenCalledWith(WORKFLOW_REPO, expect.anything());
    expect(job.providerContext).toEqual(SOURCE_CREDENTIALS);
    expect(job.repoUrl).toBe(`https://git.example/${SOURCE_REPO}.git`);
  });

  it('skips the candidate without a run when its workflow credentials cannot be minted', async () => {
    // fails-when: a mint failure dispatches the global run anyway, or throws out of the pass
    const lockEntry = richGlobalLockEntry();
    const workflowSide = makeBundle('A');
    workflowSide.createCloneToken.mockRejectedValueOnce(new Error('installation suspended'));
    const { deps, dispatched, tracker } = makeDeps(workflowSide.bundle);
    const runId = await dispatchGlobalCandidateViaPipeline({
      info,
      deps,
      payload: info.payload,
      sourceBundle: makeBundle('B').bundle,
      sourceRepoIdentifier: SOURCE_REPO,
      sourceCredentials: SOURCE_CREDENTIALS,
      event,
      eventWithFiles: event,
      ref: 's1',
      resolvedOrgId: 'org-1',
      trustResolution: undefined,
      securityDecision: { action: 'pass' },
      resolved: {
        candidate: { reg: registration(lockEntry), lockEntry, decision },
        jobs: lockEntry.jobs as LockJob[],
      },
    });
    expect(runId).toBeUndefined();
    expect(dispatched).toHaveLength(0);
    expect(tracker.onExecutionStarted).not.toHaveBeenCalled();
  });

  it('dispatches nothing and creates no run for a candidate with no jobs', async () => {
    // fails-when: an empty job list reaches the pipeline and records a run that never completes
    const lockEntry = richGlobalLockEntry();
    const workflowSide = makeBundle('A');
    const { deps, dispatched, tracker } = makeDeps(workflowSide.bundle);
    const runId = await dispatchGlobalCandidateViaPipeline({
      info,
      deps,
      payload: info.payload,
      sourceBundle: makeBundle('B').bundle,
      sourceRepoIdentifier: SOURCE_REPO,
      sourceCredentials: SOURCE_CREDENTIALS,
      event,
      eventWithFiles: event,
      ref: 's1',
      resolvedOrgId: 'org-1',
      trustResolution: undefined,
      securityDecision: { action: 'pass' },
      resolved: { candidate: { reg: registration(lockEntry), lockEntry, decision }, jobs: [] },
    });
    expect(runId).toBeUndefined();
    expect(dispatched).toHaveLength(0);
    expect(tracker.onExecutionStarted).not.toHaveBeenCalled();
    expect(workflowSide.createCloneToken).not.toHaveBeenCalled();
  });

  it('drops the workflow filter the eval round already decided', async () => {
    // fails-when: hasFilter reaches the pipeline, deferring every job to a second filter evaluation
    // breaks-if-wrong: the jobs of a filtered workflow must still dispatch directly
    const lockEntry = { ...richGlobalLockEntry(), hasFilter: true } as LockWorkflow;
    const { dispatched } = await dispatchCrossRepo(lockEntry);
    expect(dispatched.map((j) => j.jobName)).toHaveLength(3);
    expect(dispatched.every((j) => j.jobConfig.initOnly !== true)).toBe(true);
  });
});

describe('the dependency cache of a global run', () => {
  it("probes the cache with the registration's lock-file key and dispatches the cached tarball", async () => {
    // fails-when: the global path passes no lockfileHash or siblingsDigest, so the probe never runs
    //   or reads a pointer the build job never publishes
    const depCache = makeDepCache();
    const { dispatched } = await dispatchCrossRepo(richGlobalLockEntry(), makeBundle('B'), {
      key: DEP_KEY,
      depCache,
    });

    expect(depCache.has).toHaveBeenCalledWith('lock-hash-1', 'linux', 'x64', 'siblings-1');
    expect(depCache.getUrlAndHash).toHaveBeenCalledWith(
      'lock-hash-1',
      'linux',
      'x64',
      'siblings-1',
    );
    expect(dispatched).toHaveLength(3);
    for (const job of dispatched) {
      expect(job.depsUrl).toBe(DEPS_URL);
      expect(job.depsHash).toBe('deps-hash-1');
    }
  });

  it('makes the same lookup and dispatches the same tarball as a per-repo run of the same lock', async () => {
    // fails-when: the global run keys the dependency cache differently from the per-repo run,
    //   so the two never share an entry
    // breaks-if-wrong: the per-repo side is the unchanged pipeline; it must keep probing with its
    //   own lock file's key
    const sameCache = makeDepCache();
    const crossCache = makeDepCache();
    const lockEntry = richGlobalLockEntry();
    const sameRepo = await dispatchSameRepo(lockEntry, { key: DEP_KEY, depCache: sameCache });
    const crossRepo = await dispatchCrossRepo(lockEntry, makeBundle('B'), {
      key: DEP_KEY,
      depCache: crossCache,
    });

    expect(sameCache.has).toHaveBeenCalledWith('lock-hash-1', 'linux', 'x64', 'siblings-1');
    expect(crossCache.has.mock.calls).toEqual(sameCache.has.mock.calls);
    expect(crossCache.getUrlAndHash.mock.calls).toEqual(sameCache.getUrlAndHash.mock.calls);
    expect(crossRepo.dispatched.map((j) => [j.jobName, j.depsUrl, j.depsHash])).toEqual(
      sameRepo.dispatched.map((j) => [j.jobName, j.depsUrl, j.depsHash]),
    );
  });

  it('builds the dependencies under the registration key on a miss', async () => {
    // fails-when: the global build job carries no lockfileHash / siblingsDigest or no
    //   buildDepsNeeded, so a miss never fills the cache and every run installs
    const depCache = { ...makeDepCache(), has: vi.fn(async () => false) };
    const { dispatched } = await dispatchCrossRepo(richGlobalLockEntry(), makeBundle('B'), {
      key: DEP_KEY,
      depCache,
      extraDeps: {
        buildCoordinator: {
          ensureBuild: async (_key: string, build: () => Promise<unknown>) => build(),
        },
      },
    });

    expect(depCache.has).toHaveBeenCalledWith('lock-hash-1', 'linux', 'x64', 'siblings-1');
    const build = dispatched.find((j) => j.jobName === '__build__release');
    expect(build?.jobConfig).toMatchObject({
      buildOnly: true,
      lockfileHash: 'lock-hash-1',
      siblingsDigest: 'siblings-1',
      buildDepsNeeded: true,
    });
    // The build packs the workflow repository at the registered commit, whose lock file
    // the key was read from.
    expect(build?.repoUrl).toBe(`https://git.example/${WORKFLOW_REPO}.git`);
    expect(build?.sha).toBe('a1');
    // breaks-if-wrong: after the build the jobs still dispatch, with the tarball it uploaded
    const jobs = dispatched.filter((j) => j.jobName !== '__build__release');
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.depsUrl === DEPS_URL)).toBe(true);
  });

  it('does not consult the cache for a registration that recorded no key', async () => {
    // breaks-if-wrong: a registration written before the key existed installs as it always did
    const depCache = makeDepCache();
    const { dispatched } = await dispatchCrossRepo(richGlobalLockEntry(), makeBundle('B'), {
      key: NO_DEP_KEY,
      depCache,
    });

    // Positive control: the run dispatched, so the absent probe is not an absent run.
    expect(dispatched).toHaveLength(3);
    expect(depCache.has).not.toHaveBeenCalled();
    expect(depCache.getUrlAndHash).not.toHaveBeenCalled();
    expect(dispatched.every((j) => j.depsUrl === undefined)).toBe(true);
  });
});

describe('globalRunLockFile', () => {
  it("carries the registration's dependency-cache key", () => {
    // fails-when: the lock file a global run hands the pipeline drops either key field
    const lockEntry = richGlobalLockEntry();
    expect(globalRunLockFile(lockEntry, registration(lockEntry, DEP_KEY))).toEqual({
      workflows: [lockEntry],
      lockfileHash: 'lock-hash-1',
      siblingsDigest: 'siblings-1',
      source: { file: '.kici/workflows/release.ts' },
    });
  });

  it('carries no key for a registration that recorded none', () => {
    const lockEntry = richGlobalLockEntry();
    expect(globalRunLockFile(lockEntry, registration(lockEntry))).toEqual({
      workflows: [lockEntry],
      lockfileHash: undefined,
      source: { file: '.kici/workflows/release.ts' },
    });
  });
});

/**
 * An evaluation job (a deferred init job, a generator evaluation) of a global run
 * checks out the workflow repository and the source repository in the global
 * layout, and restores its dependencies into the workflow repository's checkout.
 * A global run's dependencies are the workflow repository's, so they reach that
 * job with or without the workflow repository's source pack.
 */
describe('the dependency tarball of a global evaluation job', () => {
  /** A global workflow whose one job has a dynamic env, so it dispatches through an init job. */
  function dynamicEnvEntry(): LockWorkflow {
    return {
      name: 'release',
      source: { file: '.kici/workflows/release.ts', export: '#default' },
      contentHash: 'wf-hash',
      triggers: [],
      jobs: [
        {
          _type: 'static',
          name: 'deploy',
          runsOn: [{ kind: 'exact', value: 'linux' }],
          needs: [],
          steps: [{ name: 'deploy', run: 'true' }],
          dynamicEnv: true,
        },
      ],
    } as unknown as LockWorkflow;
  }

  const SOURCE_TAR_URL = 'https://cache.example/source/wf-hash.tar.gz';
  const sourceCacheHit = () => ({
    has: vi.fn(async () => true),
    getUrlAndDigest: vi.fn(async () => ({ url: SOURCE_TAR_URL, digest: 'src-digest' })),
  });
  const initJob = (dispatched: QueuedJobInput[]) =>
    dispatched.find((j) => j.jobName.startsWith('__init__'));

  /** The workflow-repository fields the agent lays the global checkout out from. */
  const WORKFLOW_CHECKOUT = {
    isGlobalWorkflow: true,
    workflowRepoUrl: `https://git.example/${WORKFLOW_REPO}.git`,
    workflowSha: 'a1',
    workflowRepoIdentifier: WORKFLOW_REPO,
    workflowRoutingKey: WORKFLOW_ROUTING_KEY,
    workflowProviderContext: REG_PROVIDER_CONTEXT,
  };

  it("hands the init job the workflow repository's tarball and checkout with no source pack", async () => {
    // fails-when: an init job with no source pack loses its dependency-cache hit, or is not
    //   told to check out the workflow repository its dependencies belong to
    const depCache = makeDepCache();
    const { dispatched } = await dispatchCrossRepo(dynamicEnvEntry(), makeBundle('B'), {
      key: DEP_KEY,
      depCache,
    });

    const init = initJob(dispatched);
    expect(depCache.has).toHaveBeenCalled();
    expect(init?.sourceTarUrl).toBeUndefined();
    expect(init?.jobConfig).toMatchObject(WORKFLOW_CHECKOUT);
    // The source repository stays the job's checkout target, under `source/`.
    expect(init?.repoUrl).toBe(`https://git.example/${SOURCE_REPO}.git`);
    expect(init?.depsUrl).toBe(DEPS_URL);
    expect(init?.depsHash).toBe('deps-hash-1');
  });

  it("mints the init job's workflow-repository clone credential from that repository's bundle", async () => {
    // fails-when: the init job's workflow clone is sent the source repository's credential
    const workflowSide = makeBundle('A');
    const inbound = makeBundle('B');
    const { dispatched } = await dispatchCrossRepo(dynamicEnvEntry(), inbound, {
      key: DEP_KEY,
      depCache: makeDepCache(),
    });
    const init = initJob(dispatched)!;
    const providerRegistry = {
      getByRoutingKey: (key: string) =>
        key === WORKFLOW_ROUTING_KEY ? workflowSide.bundle : undefined,
    } as unknown as ProviderRegistry;

    const result = await resolveDispatchCloneAuth({
      providerRegistry,
      bundle: inbound.bundle,
      repoIdentifier: SOURCE_REPO,
      job: {
        id: 'init-job',
        repoUrl: init.repoUrl,
        routingKey: init.routingKey,
        providerContext: init.providerContext,
        jobConfig: init.jobConfig,
      },
    });

    expect('auth' in result && result.auth.workflowAuth?.secret).toBe(`A:${WORKFLOW_REPO}`);
    expect('auth' in result && result.auth.sourceAuth?.secret).toBe(`B:${SOURCE_REPO}`);
    expect(workflowSide.createCloneToken).toHaveBeenCalledWith(WORKFLOW_REPO, REG_PROVIDER_CONTEXT);
  });

  it("hands the init job the workflow repository's tarball with that repository's source pack", async () => {
    // breaks-if-wrong: an init job that restores the workflow repository's pack must keep
    //   its cached dependencies
    const { dispatched } = await dispatchCrossRepo(dynamicEnvEntry(), makeBundle('B'), {
      key: DEP_KEY,
      depCache: makeDepCache(),
      extraDeps: { sourceCache: sourceCacheHit() },
    });

    const init = initJob(dispatched);
    expect(init?.sourceTarUrl).toBe(SOURCE_TAR_URL);
    expect(init?.depsUrl).toBe(DEPS_URL);
    expect(init?.depsHash).toBe('deps-hash-1');
  });

  it("hands a generator evaluation the workflow repository's tarball and checkout with no source pack", async () => {
    // fails-when: a generator evaluation with no source pack loses its dependency-cache hit
    const depCache = makeDepCache();
    const entry = {
      ...dynamicEnvEntry(),
      jobs: [{ _type: 'dynamic', source: { file: '.kici/workflows/release.ts', index: 0 } }],
    } as unknown as LockWorkflow;
    const { dispatched } = await dispatchCrossRepo(entry, makeBundle('B'), {
      key: DEP_KEY,
      depCache,
      extraDeps: {
        pendingDynamics: {
          track: vi.fn(async () => []),
          resolve: vi.fn(),
          reject: vi.fn(),
          has: vi.fn().mockReturnValue(false),
          cleanup: vi.fn(),
        },
      },
    });

    const evalJob = dispatched.find((j) => j.jobName.startsWith('__dynamic__'));
    expect(depCache.has).toHaveBeenCalled();
    expect(evalJob?.sourceTarUrl).toBeUndefined();
    expect(evalJob?.jobConfig).toMatchObject(WORKFLOW_CHECKOUT);
    expect(evalJob?.repoUrl).toBe(`https://git.example/${SOURCE_REPO}.git`);
    expect(evalJob?.depsUrl).toBe(DEPS_URL);
    expect(evalJob?.depsHash).toBe('deps-hash-1');
  });

  it('keeps the tarball on a same-repo init job, whose clone is the workflow repository', async () => {
    // breaks-if-wrong: a per-repository init job must keep restoring cached dependencies
    //   into its single checkout
    const { dispatched } = await dispatchSameRepo(dynamicEnvEntry(), {
      key: DEP_KEY,
      depCache: makeDepCache(),
    });

    const init = initJob(dispatched);
    expect(init?.sourceTarUrl).toBeUndefined();
    expect(init?.depsUrl).toBe(DEPS_URL);
    expect(init?.jobConfig.isGlobalWorkflow).toBeUndefined();
  });
});
