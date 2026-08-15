import { describe, expect, it, vi } from 'vitest';
import type { LockJobOrFactory, LockWorkflow } from '@kici-dev/engine';
import {
  candidateKey,
  groupCandidates,
  partitionCandidates,
  runGlobalEvalRounds,
  truncateReasonText,
  MAX_ROUND_REASON_CHARS,
  MIN_GLOBAL_EVAL_AGENT_VERSION,
  type GlobalEvalCandidate,
  type GlobalEvalRoundArgs,
} from './global-eval-round.js';
import { GlobalEvalRoundCache } from '../cache/global-eval-round-cache.js';
import { PendingGlobalEvalTracker } from '../cache/pending-global-evals.js';
import type { RegisteredWorkflow } from '../registration/registration-index.js';
import type { ProviderBundle } from '../provider-registry.js';
import type { WebhookInfo } from '../webhook/handler.js';
import type { QueuedJobInput } from '../queue/job-queue.js';

const STATIC_JOB: LockJobOrFactory = { _type: 'static', name: 'build', steps: [] };
const DYNAMIC_JOB: LockJobOrFactory = {
  _type: 'dynamic',
  source: { file: '.kici/workflows/org.ts', index: 0 },
};

function lockWorkflow(
  name: string,
  overrides: Partial<LockWorkflow> & { jobs?: LockJobOrFactory[] } = {},
): LockWorkflow {
  return {
    name,
    triggers: [],
    jobs: [STATIC_JOB],
    source: { file: '.kici/workflows/org.ts' },
    ...overrides,
  } as LockWorkflow;
}

function registration(overrides: Partial<RegisteredWorkflow> = {}): RegisteredWorkflow {
  return {
    id: 'reg-1',
    repoIdentifier: 'org/pipelines',
    workflowName: 'org-ci',
    lockEntry: lockWorkflow('org-ci'),
    triggerTypes: ['push'],
    routingKey: 'github:1',
    providerContext: { installationId: 1 },
    disabled: false,
    isGlobal: true,
    customerId: 'cust-1',
    commitSha: 'sha1',
    sourceFile: '.kici/workflows/org.ts',
    ...overrides,
  };
}

/**
 * One candidate. `regOverrides` shapes the registration (repo, sha, routing
 * key); `workflowOverrides` shapes the lock entry (`hasFilter`, `jobs`).
 */
function candidate(
  name: string,
  opts: {
    hasFilter?: boolean;
    dynamic?: boolean;
    repo?: string;
    sha?: string;
    routingKey?: string;
    id?: string;
  } = {},
): GlobalEvalCandidate {
  const lockEntry = lockWorkflow(name, {
    ...(opts.hasFilter !== undefined ? { hasFilter: opts.hasFilter } : {}),
    jobs: opts.dynamic ? [DYNAMIC_JOB] : [STATIC_JOB],
  });
  const reg = registration({
    id: opts.id ?? `reg-${name}`,
    workflowName: name,
    lockEntry,
    ...(opts.repo !== undefined ? { repoIdentifier: opts.repo } : {}),
    ...(opts.sha !== undefined ? { commitSha: opts.sha } : {}),
    ...(opts.routingKey !== undefined ? { routingKey: opts.routingKey } : {}),
  });
  return { reg, lockEntry };
}

describe('partitionCandidates', () => {
  it('sends a plain static workflow straight to immediate dispatch', () => {
    const { immediate, needsRound } = partitionCandidates([candidate('plain')]);
    expect(immediate).toHaveLength(1);
    expect(needsRound).toHaveLength(0);
  });

  it('routes a filter-bearing workflow to the round', () => {
    const { immediate, needsRound } = partitionCandidates([candidate('f', { hasFilter: true })]);
    expect(needsRound.map((c) => c.lockEntry.name)).toEqual(['f']);
    expect(immediate).toHaveLength(0);
  });

  it('routes a workflow with a dynamic job to the round even without a filter', () => {
    const cand = candidate('d', { dynamic: true });
    expect(cand.lockEntry.hasFilter).toBeUndefined();
    const { immediate, needsRound } = partitionCandidates([cand]);
    expect(needsRound.map((c) => c.lockEntry.name)).toEqual(['d']);
    expect(immediate).toHaveLength(0);
  });

  it('keeps a hasFilter: false workflow on the immediate path', () => {
    const { immediate, needsRound } = partitionCandidates([candidate('nf', { hasFilter: false })]);
    expect(immediate).toHaveLength(1);
    expect(needsRound).toHaveLength(0);
  });
});

describe('groupCandidates', () => {
  it('groups by workflow repo, routing key, and sha', () => {
    const groups = groupCandidates([
      candidate('a', { hasFilter: true }),
      candidate('b', { hasFilter: true }),
      candidate('c', { hasFilter: true, repo: 'org/other' }),
    ]);
    expect(groups.size).toBe(2);
    const sizes = [...groups.values()].map((g) => g.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it('separates two registrations of the same repo at different shas', () => {
    const groups = groupCandidates([
      candidate('a', { hasFilter: true, sha: 'sha1' }),
      candidate('b', { hasFilter: true, sha: 'sha2' }),
    ]);
    expect(groups.size).toBe(2);
  });

  it('separates two registrations of the same repo under different routing keys', () => {
    const groups = groupCandidates([
      candidate('a', { hasFilter: true, routingKey: 'github:1' }),
      candidate('b', { hasFilter: true, routingKey: 'gitlab:9' }),
    ]);
    expect(groups.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Dispatch and await
// ---------------------------------------------------------------------------

const bundle = {
  repoUrlBuilder: { buildCloneUrl: (repo: string) => `https://git.example.com/${repo}.git` },
} as unknown as ProviderBundle;

const info = {
  deliveryId: 'delivery-1',
  provider: 'github',
  routingKey: 'github:1',
} as unknown as WebhookInfo;

/**
 * A dispatcher that records every input and resolves the tracker as soon as the
 * round job is dispatched, so a test never has to coordinate two promises.
 */
function harness(reply: (input: QueuedJobInput) => unknown) {
  const dispatched: QueuedJobInput[] = [];
  const pendingGlobalEvals = new PendingGlobalEvalTracker();
  let seq = 0;
  const dispatcher = {
    dispatch: vi.fn(async (input: QueuedJobInput) => {
      dispatched.push(input);
      const jobId = `job-${++seq}`;
      // Resolve on the next macrotask, not a microtask: the production path
      // calls `track()` only after `dispatch()` resolves, and a microtask
      // queued here runs *before* that await continuation, so the resolve
      // would land on an unregistered job id and hang.
      setTimeout(() => {
        const value = reply(input);
        if (value instanceof Error) pendingGlobalEvals.reject(jobId, value);
        else pendingGlobalEvals.resolve(jobId, value as never);
      }, 0);
      return { status: 'dispatched', jobId };
    }),
    cancelQueuedJob: vi.fn(async () => {}),
  };
  return { dispatched, dispatcher, pendingGlobalEvals };
}

function roundArgs(
  candidates: GlobalEvalCandidate[],
  h: ReturnType<typeof harness>,
  extra: Partial<GlobalEvalRoundArgs['deps']> = {},
  configOver: Partial<GlobalEvalRoundArgs['config']> = {},
): GlobalEvalRoundArgs {
  return {
    deps: {
      dispatcher: h.dispatcher,
      pendingGlobalEvals: h.pendingGlobalEvals,
      // Same-provider default: every routing key resolves to the one bundle the
      // event also travels on, which is the ordinary case.
      providerRegistry: { getByRoutingKey: () => bundle },
      ...extra,
    },
    info,
    event: { type: 'push', targetBranch: 'main' } as GlobalEvalRoundArgs['event'],
    candidates,
    repoIdentifier: 'org/app',
    ref: 'source-sha',
    dispatchBundle: bundle,
    dispatchCredentials: { token: 't' },
    config: {
      globalEvalRoundTimeoutMs: 120_000,
      globalEvalCandidateTimeoutMs: 20_000,
      globalEvalWaitTimeoutMs: 240_000,
      ...configOver,
    },
  };
}

/** The verdict half of the outcome — what most cases below assert on. */
async function runVerdicts(args: GlobalEvalRoundArgs) {
  return (await runGlobalEvalRounds(args)).verdicts;
}

describe('runGlobalEvalRounds', () => {
  it('dispatches nothing when there are no candidates', async () => {
    const h = harness(() => ({ candidates: [] }));
    const results = await runVerdicts(roundArgs([], h));
    expect(results.size).toBe(0);
    expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches one globalEvalRound job per group', async () => {
    // The correctness driver: a global workflow whose only job is a DynamicJobFn
    // and which declares no filter. Before the round existed, its generator was
    // never evaluated on this path at all.
    //
    // "…and never a dynamicJobFn job" is asserted in
    // `process-webhook-globals-eval-round.test.ts` instead, over the wired
    // dispatch where a `dynamicJobFn` job could actually be observed. Asserting
    // it here would be vacuous: this module emits exactly one job shape, so the
    // discriminant it does not set can never appear whatever the code does.
    const cand = candidate('org-ci', { dynamic: true });
    const h = harness(() => ({ candidates: [{ workflowName: 'org-ci', run: true, jobs: [] }] }));
    await runVerdicts(roundArgs([cand], h));

    expect(h.dispatched).toHaveLength(1);
    const config = h.dispatched[0].jobConfig;
    expect(config.globalEvalRound).toBe(true);
    expect(h.dispatched[0].jobName.startsWith('__globaleval__')).toBe(true);
    expect(h.dispatched[0].runsOnLabels).toEqual([
      'kici:role:init-runner',
      'kici:os:linux',
      'kici:arch:x64',
    ]);
  });

  it('sends the workflow-repo quartet and the per-candidate payload', async () => {
    const cand = candidate('org-ci', { hasFilter: true });
    const h = harness(() => ({ candidates: [{ workflowName: 'org-ci', run: true }] }));
    await runVerdicts(roundArgs([cand], h));

    const config = h.dispatched[0].jobConfig;
    expect(config.isGlobalWorkflow).toBe(true);
    expect(config.workflowRepoIdentifier).toBe('org/pipelines');
    expect(config.workflowSha).toBe('sha1');
    expect(config.workflowRef).toBe('');
    expect(config.workflowRoutingKey).toBe('github:1');
    expect(config.workflowRepoUrl).toBe('https://git.example.com/org/pipelines.git');
    expect(config.candidates).toEqual([
      { workflowName: 'org-ci', sourceFile: '.kici/workflows/org.ts', hasFilter: true },
    ]);
    // The source repo travels on the job envelope, not in the round config.
    expect(h.dispatched[0].repoUrl).toBe('https://git.example.com/org/app.git');
    expect(h.dispatched[0].sha).toBe('source-sha');
  });

  it('builds the workflow clone URL from the registration bundle, not the event bundle', async () => {
    // A local-source event (file:// URL builder) triggering a workflow authored
    // in a GitHub repo. The workflow URL must come from the GitHub bundle — the
    // local builder would produce `file:///srv/canary/acme/ci-pipelines`, a path
    // that does not exist, and the round dies at checkout before any filter runs.
    const githubBundle = {
      repoUrlBuilder: {
        buildCloneUrl: (repo: string) => `https://x-access-token:t@github.com/${repo}.git`,
      },
    } as unknown as ProviderBundle;
    const localBundle = {
      repoUrlBuilder: { buildCloneUrl: (repo: string) => `file:///srv/canary/${repo}` },
    } as unknown as ProviderBundle;

    const cand = candidate('org-ci', {
      hasFilter: true,
      repo: 'acme/ci-pipelines',
      routingKey: 'github:42',
    });
    const h = harness(() => ({ candidates: [{ workflowName: 'org-ci', run: true }] }));
    const args = roundArgs([cand], h, {
      providerRegistry: {
        getByRoutingKey: (key: string) => (key === 'github:42' ? githubBundle : undefined),
      },
    });
    await runVerdicts({ ...args, dispatchBundle: localBundle });

    expect(h.dispatched[0].jobConfig.workflowRepoUrl).toBe(
      'https://x-access-token:t@github.com/acme/ci-pipelines.git',
    );
    // The source repo still comes from the EVENT's bundle — do not swap both.
    expect(h.dispatched[0].repoUrl).toBe('file:///srv/canary/org/app');
  });

  it('leaves the workflow clone URL empty when the registration bundle is unresolvable', async () => {
    // Degrade to '' exactly as an absent `repoUrlBuilder` always has — never
    // fall back to the event's bundle, which is the defect above.
    const cand = candidate('org-ci', {
      hasFilter: true,
      repo: 'acme/ci-pipelines',
      routingKey: 'gitlab:9',
    });
    const h = harness(() => ({ candidates: [{ workflowName: 'org-ci', run: true }] }));
    await runVerdicts(
      roundArgs([cand], h, { providerRegistry: { getByRoutingKey: () => undefined } }),
    );

    expect(h.dispatched[0].jobConfig.workflowRepoUrl).toBe('');
    expect(h.dispatched[0].repoUrl).toBe('https://git.example.com/org/app.git');
  });

  it('reads both budgets per round from cluster settings', async () => {
    const getNumber = vi.fn(async (column: string) =>
      column === 'global_eval_round_timeout_ms' ? 55_000 : 7_000,
    );
    const h = harness(() => ({ candidates: [{ workflowName: 'org-ci', run: true }] }));
    await runVerdicts(
      roundArgs([candidate('org-ci', { hasFilter: true })], h, {
        clusterSettings: { getNumber } as never,
      }),
    );
    expect(h.dispatched[0].jobConfig.roundTimeoutMs).toBe(55_000);
    expect(h.dispatched[0].jobConfig.candidateTimeoutMs).toBe(7_000);
    expect(getNumber).toHaveBeenCalledWith('global_eval_round_timeout_ms', 120_000);
    expect(getNumber).toHaveBeenCalledWith('global_eval_candidate_timeout_ms', 20_000);
  });

  it('falls back to the configured budgets with no cluster settings', async () => {
    const h = harness(() => ({ candidates: [{ workflowName: 'org-ci', run: true }] }));
    await runVerdicts(roundArgs([candidate('org-ci', { hasFilter: true })], h));
    expect(h.dispatched[0].jobConfig.roundTimeoutMs).toBe(120_000);
    expect(h.dispatched[0].jobConfig.candidateTimeoutMs).toBe(20_000);
  });

  it('returns one verdict per candidate, keyed by candidateKey', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const b = candidate('b', { hasFilter: true, id: 'reg-b' });
    const h = harness(() => ({
      candidates: [
        { workflowName: 'a', run: true, jobs: [{ name: 'gen-a' }] },
        { workflowName: 'b', run: false },
      ],
    }));
    const results = await runVerdicts(roundArgs([a, b], h));

    expect(h.dispatched).toHaveLength(1); // one group — same repo, sha, routing key
    expect(results.get(candidateKey(a))).toEqual({
      workflowName: 'a',
      run: true,
      jobs: [{ name: 'gen-a' }],
    });
    expect(results.get(candidateKey(b))?.run).toBe(false);
  });

  it('runs one round per group when candidates span two workflow repos', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const b = candidate('b', { hasFilter: true, id: 'reg-b', repo: 'org/other' });
    const h = harness((input) => ({
      candidates: [
        {
          workflowName: input.jobConfig.workflowRepoIdentifier === 'org/other' ? 'b' : 'a',
          run: true,
        },
      ],
    }));
    const results = await runVerdicts(roundArgs([a, b], h));
    expect(h.dispatched).toHaveLength(2);
    expect(results.get(candidateKey(a))?.run).toBe(true);
    expect(results.get(candidateKey(b))?.run).toBe(true);
  });

  it('marks a candidate the round never reported on as indeterminate', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const b = candidate('b', { hasFilter: true, id: 'reg-b' });
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    const results = await runVerdicts(roundArgs([a, b], h));

    // Positive control: the reported sibling carries a real verdict, so the
    // assertion below cannot pass because nothing was collected at all.
    expect(results.get(candidateKey(a))).toEqual({ workflowName: 'a', run: true });
    const missing = results.get(candidateKey(b));
    expect(missing?.run).toBe(false);
    expect(missing?.indeterminate).toBe(true);
    expect(missing?.reason).toContain('no verdict');
  });

  it('fails a group closed when its round rejects, leaving other groups alone', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const b = candidate('b', { hasFilter: true, id: 'reg-b', repo: 'org/other' });
    const h = harness((input) =>
      input.jobConfig.workflowRepoIdentifier === 'org/other'
        ? new Error('agent gone')
        : { candidates: [{ workflowName: 'a', run: true }] },
    );
    const results = await runVerdicts(roundArgs([a, b], h));

    expect(results.get(candidateKey(a))?.run).toBe(true);
    const failed = results.get(candidateKey(b));
    expect(failed?.run).toBe(false);
    expect(failed?.indeterminate).toBe(true);
    expect(failed?.reason).toContain('agent gone');
  });

  it('fails a group closed when the dispatch is rejected outright', async () => {
    const pendingGlobalEvals = new PendingGlobalEvalTracker();
    const h = {
      dispatched: [] as QueuedJobInput[],
      dispatcher: { dispatch: vi.fn(async () => ({ status: 'rejected', jobId: 'x' })) },
      pendingGlobalEvals,
    } as unknown as ReturnType<typeof harness>;
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const results = await runVerdicts(roundArgs([a], h));
    expect(results.get(candidateKey(a))?.indeterminate).toBe(true);
    expect(results.get(candidateKey(a))?.reason).toContain('rejected');
  });

  it('does not trust the wire result: a nameless generated job fails the candidate closed', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const h = harness(() => ({
      candidates: [{ workflowName: 'a', run: true, jobs: [{ name: 'ok' }, { steps: [] }] }],
    }));
    const results = await runVerdicts(roundArgs([a], h));
    const verdict = results.get(candidateKey(a));
    expect(verdict?.run).toBe(false);
    expect(verdict?.indeterminate).toBe(true);
    expect(verdict?.reason).toContain('without a usable name');
    expect(verdict?.jobs).toBeUndefined();
  });

  it('does not trust the wire result: a non-boolean run never reads as true', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: 'yes' }] }));
    const results = await runVerdicts(roundArgs([a], h));
    expect(results.get(candidateKey(a))?.run).toBe(false);
  });

  it('serves a repeated delivery of the same three shas from the cache', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const globalEvalCache = new GlobalEvalRoundCache({ max: 10 });
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));

    const first = await runVerdicts(roundArgs([a], h, { globalEvalCache }));
    expect(h.dispatched).toHaveLength(1); // control: the first round really ran
    const second = await runVerdicts(roundArgs([a], h, { globalEvalCache }));

    expect(h.dispatched).toHaveLength(1); // no second dispatch
    expect(second.get(candidateKey(a))).toEqual(first.get(candidateKey(a)));
  });

  it('re-runs the round when the event differs at identical shas', async () => {
    // The wrong-hit case the three-sha key allowed: a push to `main` at commit
    // X and a pull-request synchronize whose head is commit X. Same workflow
    // repo, same workflow sha, same source sha — different verdicts.
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const globalEvalCache = new GlobalEvalRoundCache({ max: 10 });
    const h = harness((input) => ({
      candidates: [
        {
          workflowName: 'a',
          run: (input.jobConfig.event as { type: string }).type === 'push',
        },
      ],
    }));

    const push = await runVerdicts(roundArgs([a], h, { globalEvalCache }));
    expect(h.dispatched).toHaveLength(1); // control: the first round really ran
    const pr = await runVerdicts({
      ...roundArgs([a], h, { globalEvalCache }),
      event: {
        type: 'pull_request',
        targetBranch: 'main',
      } as GlobalEvalRoundArgs['event'],
    });

    expect(h.dispatched).toHaveLength(2);
    expect(push.get(candidateKey(a))?.run).toBe(true);
    expect(pr.get(candidateKey(a))?.run).toBe(false);
  });

  it('re-runs the round when the target branch differs at identical shas', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const globalEvalCache = new GlobalEvalRoundCache({ max: 10 });
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));

    await runVerdicts(roundArgs([a], h, { globalEvalCache }));
    await runVerdicts({
      ...roundArgs([a], h, { globalEvalCache }),
      event: { type: 'push', targetBranch: 'release' } as GlobalEvalRoundArgs['event'],
    });
    expect(h.dispatched).toHaveLength(2);
  });

  it('does not cache a round whose candidates are all indeterminate', async () => {
    // An agent-side round-budget breach reports success with this shape.
    // Caching it would make a webhook redelivery replay the failure forever.
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const globalEvalCache = new GlobalEvalRoundCache({ max: 10 });
    let reply: unknown = {
      candidates: [{ workflowName: 'a', run: false, indeterminate: true, reason: 'budget' }],
    };
    const h = harness(() => reply);

    const first = await runVerdicts(roundArgs([a], h, { globalEvalCache }));
    expect(first.get(candidateKey(a))?.indeterminate).toBe(true);
    // Two dispatches, not one: a round that decided nothing is a failure, so
    // the group's own retry ran before it was recorded indeterminate.
    expect(h.dispatched).toHaveLength(2);

    reply = { candidates: [{ workflowName: 'a', run: true }] };
    const second = await runVerdicts(roundArgs([a], h, { globalEvalCache }));
    expect(h.dispatched).toHaveLength(3); // the redelivery really re-ran
    expect(second.get(candidateKey(a))?.run).toBe(true);
  });

  it('does not cache a mixed round that left one candidate undecided', async () => {
    // A single candidate's budget breach must not be pinned for every
    // redelivery of the event: the cache read sits ahead of the round's own
    // retry, so a stored partial failure short-circuits the retry too.
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const b = candidate('b', { hasFilter: true, id: 'reg-b' });
    const globalEvalCache = new GlobalEvalRoundCache({ max: 10 });
    let reply: unknown = {
      candidates: [
        { workflowName: 'a', run: true },
        { workflowName: 'b', run: false, indeterminate: true, reason: 'threw' },
      ],
    };
    const h = harness(() => reply);

    const first = await runVerdicts(roundArgs([a, b], h, { globalEvalCache }));
    // Control: the first round really ran and really decided `a`, so the
    // re-run below is about the undecided sibling and not about a round that
    // produced nothing to store.
    expect(first.get(candidateKey(a))?.run).toBe(true);
    expect(h.dispatched).toHaveLength(1);

    reply = {
      candidates: [
        { workflowName: 'a', run: true },
        { workflowName: 'b', run: true },
      ],
    };
    const second = await runVerdicts(roundArgs([a, b], h, { globalEvalCache }));
    expect(h.dispatched).toHaveLength(2); // the re-run really happened
    expect(second.get(candidateKey(b))?.run).toBe(true);
  });

  it('caches a round only once every candidate is decided', async () => {
    // The other half of the predicate: a fully-decided round IS still cached,
    // so the change above did not simply disable the cache.
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const b = candidate('b', { hasFilter: true, id: 'reg-b' });
    const globalEvalCache = new GlobalEvalRoundCache({ max: 10 });
    const h = harness(() => ({
      candidates: [
        { workflowName: 'a', run: true },
        { workflowName: 'b', run: false },
      ],
    }));

    await runVerdicts(roundArgs([a, b], h, { globalEvalCache }));
    expect(h.dispatched).toHaveLength(1);
    await runVerdicts(roundArgs([a, b], h, { globalEvalCache }));
    expect(h.dispatched).toHaveLength(1);
  });

  it('re-runs the round when the source sha moves', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const globalEvalCache = new GlobalEvalRoundCache({ max: 10 });
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));

    await runVerdicts(roundArgs([a], h, { globalEvalCache }));
    await runVerdicts({
      ...roundArgs([a], h, { globalEvalCache }),
      ref: 'another-source-sha',
    });
    expect(h.dispatched).toHaveLength(2);
  });

  it('retries a failed round once before giving up', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    let call = 0;
    const h = harness(() =>
      ++call === 1 ? new Error('agent gone') : { candidates: [{ workflowName: 'a', run: true }] },
    );

    const results = await runVerdicts(roundArgs([a], h));

    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    // Without the retry the first rejection is the group's final word, so this
    // verdict is unreachable: the candidate would be indeterminate.
    expect(results.get(candidateKey(a))?.run).toBe(true);
  });

  it('gives up after two attempts and does not retry forever', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const h = harness(() => new Error('agent gone'));

    const results = await runVerdicts(roundArgs([a], h));

    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    const verdict = results.get(candidateKey(a));
    expect(verdict?.run).toBe(false);
    expect(verdict?.indeterminate).toBe(true);
    expect(verdict?.reason).toContain('agent gone');
  });

  it('reports exactly one failure per failed round, naming every affected candidate', async () => {
    // One record, not one per candidate: the round exists to collapse N
    // candidate workflows into one pre-run job, so fanning its failure back out
    // would undo that.
    const a = candidate('org-ci', { hasFilter: true, id: 'reg-a' });
    const b = candidate('org-lint', { hasFilter: true, id: 'reg-b' });
    const h = harness(() => new Error('agent gone'));

    const { verdicts, failures } = await runGlobalEvalRounds(roundArgs([a, b], h));

    expect(failures).toHaveLength(1);
    expect(failures[0].workflowNames).toEqual(['org-ci', 'org-lint']);
    expect(failures[0].workflowRepoIdentifier).toBe('org/pipelines');
    expect(failures[0].error).toContain('agent gone');
    expect(failures[0].attempts).toBe(2);
    // The last attempt's run id, so the errored run row lands on the queue row
    // whose attempt actually failed last.
    expect(failures[0].runId).toBe(h.dispatched[h.dispatched.length - 1].runId);
    // Positive control: both candidates really were in this round, and neither
    // is dispatchable afterwards.
    expect(verdicts.size).toBe(2);
    expect([...verdicts.values()].every((v) => v.run === false)).toBe(true);
  });

  it('reports one failure per failed group, and none for a group that succeeded', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const b = candidate('b', { hasFilter: true, id: 'reg-b', repo: 'org/other' });
    const h = harness((input) =>
      input.jobConfig.workflowRepoIdentifier === 'org/other'
        ? new Error('agent gone')
        : { candidates: [{ workflowName: 'a', run: true }] },
    );

    const { verdicts, failures } = await runGlobalEvalRounds(roundArgs([a, b], h));

    expect(failures).toHaveLength(1);
    expect(failures[0].workflowRepoIdentifier).toBe('org/other');
    // Control: the healthy group produced a real verdict, so the single failure
    // above is a per-group record and not a per-delivery one.
    expect(verdicts.get(candidateKey(a))?.run).toBe(true);
  });

  it('treats a round that decided nothing as a failure, and retries it', async () => {
    // The most likely production failure mode: the agent's round runner never
    // throws on its own budget breach — it returns `success` with every
    // candidate padded `indeterminate`. Read as a success it would produce no
    // retry, no errored run, and no check.
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const b = candidate('b', { hasFilter: true, id: 'reg-b' });
    const h = harness(() => ({
      candidates: [
        { workflowName: 'a', run: false, indeterminate: true, reason: 'round budget exceeded' },
        { workflowName: 'b', run: false, indeterminate: true, reason: 'round budget exceeded' },
      ],
    }));

    const { verdicts, failures } = await runGlobalEvalRounds(roundArgs([a, b], h));

    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    expect(failures).toHaveLength(1);
    expect(failures[0].workflowNames).toEqual(['a', 'b']);
    // The agent's own reason survives into the failure, so the errored run row
    // and the check say why rather than just that.
    expect(failures[0].error).toContain('round budget exceeded');
    expect(verdicts.get(candidateKey(a))?.run).toBe(false);
  });

  it('dispatches the decided half of a partial round without retrying it', async () => {
    // The other side of the same line: a partially indeterminate round is a
    // real result. Its decided workflows must still dispatch, and it must not
    // burn the retry — re-running it would double-dispatch what it decided.
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const b = candidate('b', { hasFilter: true, id: 'reg-b' });
    const h = harness(() => ({
      candidates: [
        { workflowName: 'a', run: true },
        { workflowName: 'b', run: false, indeterminate: true, reason: 'candidate budget' },
      ],
    }));

    const { verdicts, failures } = await runGlobalEvalRounds(roundArgs([a, b], h));

    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(verdicts.get(candidateKey(a))?.run).toBe(true);
    expect(verdicts.get(candidateKey(b))?.indeterminate).toBe(true);

    // …and it is still reported. Whether a broken filter is visible must not
    // depend on how many unrelated global workflows share a workflow repo: the
    // identical fault in a group of ONE already produced a failure record, and
    // without this one a group of two produced nothing at all.
    expect(failures).toHaveLength(1);
    expect(failures[0].partial).toBe(true);
    // Only the undecided candidate — `a` ran, so naming it would be false.
    expect(failures[0].workflowNames).toEqual(['b']);
    expect(failures[0].error).toContain('candidate budget');
    expect(failures[0].attempts).toBe(1);
  });

  it('reports no partial failure when every candidate is decided', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const b = candidate('b', { hasFilter: true, id: 'reg-b' });
    const h = harness(() => ({
      candidates: [
        { workflowName: 'a', run: true },
        // A `filter` that ran and said no is a DECISION, not an absence of one.
        { workflowName: 'b', run: false },
      ],
    }));
    const { failures } = await runGlobalEvalRounds(roundArgs([a, b], h));
    expect(failures).toEqual([]);
  });

  it('reports no failure when every round succeeds', async () => {
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    const { verdicts, failures } = await runGlobalEvalRounds(roundArgs([a], h));
    expect(failures).toEqual([]);
    expect(verdicts.get(candidateKey(a))?.run).toBe(true);
  });

  it('gives each attempt its own run id', async () => {
    // Two queue rows must never share a run id — the errored run row is written
    // under the last attempt's id, so a shared id would attribute the failure
    // to the wrong queue row.
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const h = harness(() => new Error('agent gone'));
    await runVerdicts(roundArgs([a], h));

    expect(h.dispatched).toHaveLength(2);
    expect(new Set(h.dispatched.map((d) => d.runId)).size).toBe(2);
  });

  it('bounds the wait on a round that is accepted as queued and never settles', async () => {
    // The exposure this ceiling closes: an empty init-runner fleet makes the
    // dispatch `queued`, which counts as accepted, and nothing ever reports a
    // terminal status for the job. Webhook processing awaits the round inline,
    // so an unbounded wait blocks the delivery forever — and because
    // `dedup.claim` already recorded the delivery id, the provider's redelivery
    // is dropped as a duplicate rather than retried.
    const pendingGlobalEvals = new PendingGlobalEvalTracker();
    const h = {
      dispatched: [] as QueuedJobInput[],
      // Never resolves or rejects the tracker: the round job is queued and no
      // agent ever picks it up.
      dispatcher: { dispatch: vi.fn(async () => ({ status: 'queued', jobId: 'stuck-1' })) },
      pendingGlobalEvals,
    } as unknown as ReturnType<typeof harness>;
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });

    // The round budget is set below the ceiling because the ceiling is raised
    // to twice the round budget when it does not exceed it — a 20ms ceiling
    // under the default 120s budget is exactly the misconfiguration
    // `clampWaitCeiling` refuses, so it would never be the value under test.
    const results = await runVerdicts(
      roundArgs([a], h, {}, { globalEvalRoundTimeoutMs: 10, globalEvalWaitTimeoutMs: 20 }),
    );

    // Positive control: the round really was dispatched and really was tracked,
    // so the verdict below comes from the ceiling rather than from a path that
    // never got as far as awaiting anything. Twice, because the ceiling applies
    // per attempt and a breach is a failure the retry gets to answer.
    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(2);
    const verdict = results.get(candidateKey(a));
    expect(verdict?.run).toBe(false);
    expect(verdict?.indeterminate).toBe(true);
    expect(verdict?.reason).toContain('did not settle');
    // The bound rejects the tracker entry rather than racing the promise, so a
    // round nobody will ever report on leaves nothing behind.
    expect(pendingGlobalEvals.size).toBe(0);
  });

  it('cancels the queue row when it abandons the wait', async () => {
    // Giving up on the wait does not stop the job: it stays queued, later runs
    // a full dual checkout plus author code with nobody left to receive the
    // verdict, and holds an init-runner slot the retry's own round then queues
    // behind. Each breach makes the next one likelier.
    const cancelQueuedJob = vi.fn(async () => {});
    const pendingGlobalEvals = new PendingGlobalEvalTracker();
    let seq = 0;
    const h = {
      dispatched: [] as QueuedJobInput[],
      dispatcher: {
        dispatch: vi.fn(async () => ({ status: 'queued', jobId: `stuck-${++seq}` })),
        cancelQueuedJob,
      },
      pendingGlobalEvals,
    } as unknown as ReturnType<typeof harness>;

    await runVerdicts(
      roundArgs(
        [candidate('a', { hasFilter: true, id: 'reg-a' })],
        h,
        {},
        { globalEvalRoundTimeoutMs: 10, globalEvalWaitTimeoutMs: 20 },
      ),
    );

    // Once per attempt, each naming that attempt's own queue row — a retry must
    // not leave the previous attempt's orphan behind.
    expect(cancelQueuedJob).toHaveBeenCalledTimes(2);
    expect(cancelQueuedJob.mock.calls.map((c) => (c as unknown as string[])[0])).toEqual([
      'stuck-1',
      'stuck-2',
    ]);
  });

  it('does not cancel a round that settled inside the ceiling', async () => {
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    await runVerdicts(roundArgs([candidate('a', { hasFilter: true })], h));
    expect(h.dispatcher.cancelQueuedJob).not.toHaveBeenCalled();
  });

  it('still reports the timeout when the cancel itself fails', async () => {
    // The cancel is best-effort cleanup; it must never replace the verdict the
    // caller is about to record.
    const pendingGlobalEvals = new PendingGlobalEvalTracker();
    const h = {
      dispatched: [] as QueuedJobInput[],
      dispatcher: {
        dispatch: vi.fn(async () => ({ status: 'queued', jobId: 'stuck-1' })),
        cancelQueuedJob: vi.fn(async () => {
          throw new Error('queue unreachable');
        }),
      },
      pendingGlobalEvals,
    } as unknown as ReturnType<typeof harness>;
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });

    const results = await runVerdicts(
      roundArgs([a], h, {}, { globalEvalRoundTimeoutMs: 10, globalEvalWaitTimeoutMs: 20 }),
    );
    expect(results.get(candidateKey(a))?.reason).toContain('did not settle');
  });

  it('reads the wait ceiling from cluster settings', async () => {
    // Both halves of the pair are overridden: a 15ms ceiling over the default
    // 120s round budget would be raised by `clampWaitCeiling` before it was
    // ever used, so the override under test has to carry a budget below it.
    const getNumber = vi.fn(async (column: string, fallback: number) => {
      if (column === 'global_eval_wait_timeout_ms') return 15;
      if (column === 'global_eval_round_timeout_ms') return 5;
      return fallback;
    });
    const pendingGlobalEvals = new PendingGlobalEvalTracker();
    const h = {
      dispatched: [] as QueuedJobInput[],
      dispatcher: { dispatch: vi.fn(async () => ({ status: 'queued', jobId: 'stuck-2' })) },
      pendingGlobalEvals,
    } as unknown as ReturnType<typeof harness>;
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });

    const results = await runVerdicts(
      // A configured ceiling far past the test's own timeout, so only the
      // cluster override can let this resolve at all.
      roundArgs(
        [a],
        h,
        { clusterSettings: { getNumber } as never },
        {
          globalEvalWaitTimeoutMs: 10 * 60_000,
        },
      ),
    );

    expect(getNumber).toHaveBeenCalledWith('global_eval_wait_timeout_ms', 10 * 60_000);
    expect(results.get(candidateKey(a))?.reason).toContain('15ms');
  });

  it('clears the wait timer when the round settles normally', async () => {
    // A settled round must not leave a live timer that could later reject an id
    // the tracker has since re-issued.
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    const results = await runVerdicts(
      roundArgs([a], h, {}, { globalEvalRoundTimeoutMs: 10, globalEvalWaitTimeoutMs: 30 }),
    );
    expect(results.get(candidateKey(a))?.run).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    // Still the resolved verdict, and nothing pending for the fired-timer id.
    expect(results.get(candidateKey(a))?.run).toBe(true);
    expect(h.pendingGlobalEvals.size).toBe(0);
  });

  it('picks the round platform labels from a registered init-runner', async () => {
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    await runVerdicts(
      roundArgs([candidate('a', { hasFilter: true })], h, {
        agentRegistry: { findAvailable: () => [{ platform: 'darwin', arch: 'arm64' }] },
      }),
    );
    expect(h.dispatched[0].runsOnLabels).toEqual([
      'kici:role:init-runner',
      'kici:os:darwin',
      'kici:arch:arm64',
    ]);
  });
});

/**
 * A customer upgrades their orchestrator and their agents on their own
 * schedule, so an orchestrator ahead of its fleet is a supported state. An
 * agent below {@link MIN_GLOBAL_EVAL_AGENT_VERSION} has no round branch at all,
 * and the damage is not confined to the new feature: a global workflow that
 * merely contains a generator now routes through the round, so its STATIC jobs
 * stop running too.
 */
describe('too-old agent fleet', () => {
  const oldFleet = (...versions: Array<string | null>) => ({
    findAvailable: () => versions.map((version) => ({ platform: 'linux', arch: 'x64', version })),
  });

  it('does not dispatch when every init-runner predates the round', async () => {
    const a = candidate('a', { hasFilter: true });
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    const { verdicts, failures } = await runGlobalEvalRounds(
      roundArgs([a], h, { agentRegistry: oldFleet('0.4.0', '0.4.0') }),
    );

    expect(h.dispatcher.dispatch).not.toHaveBeenCalled();
    expect(verdicts.get(candidateKey(a))?.indeterminate).toBe(true);
    // Actionability is the whole point: a bare timeout tells the operator
    // nothing about which knob to turn.
    expect(verdicts.get(candidateKey(a))?.reason).toContain('Upgrade your agents');
    expect(verdicts.get(candidateKey(a))?.reason).toContain(MIN_GLOBAL_EVAL_AGENT_VERSION);
    expect(failures).toHaveLength(1);
    // Never attempted, so it must not claim an attempt an operator could go
    // looking for logs from.
    expect(failures[0].attempts).toBe(0);
    expect(failures[0].workflowNames).toEqual(['a']);
  });

  it('dispatches when at least one init-runner is new enough', async () => {
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    const results = await runVerdicts(
      roundArgs([candidate('a', { hasFilter: true })], h, {
        agentRegistry: oldFleet('0.4.0', MIN_GLOBAL_EVAL_AGENT_VERSION),
      }),
    );
    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect([...results.values()][0].run).toBe(true);
  });

  it('targets the capable agent rather than the first one indexed', async () => {
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    await runVerdicts(
      roundArgs([candidate('a', { hasFilter: true })], h, {
        agentRegistry: {
          findAvailable: () => [
            { platform: 'windows', arch: 'x64', version: '0.4.0' },
            { platform: 'darwin', arch: 'arm64', version: '0.6.1' },
          ],
        },
      }),
    );
    expect(h.dispatched[0].runsOnLabels).toContain('kici:os:darwin');
  });

  it('treats a dev-registry prerelease of the minimum as new enough', async () => {
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    await runVerdicts(
      roundArgs([candidate('a', { hasFilter: true })], h, {
        agentRegistry: oldFleet(`${MIN_GLOBAL_EVAL_AGENT_VERSION}-9159`),
      }),
    );
    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('still dispatches on an empty fleet — that is a capacity problem, not a version one', async () => {
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    await runVerdicts(
      roundArgs([candidate('a', { hasFilter: true })], h, {
        agentRegistry: { findAvailable: () => [] },
      }),
    );
    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('still dispatches when no agent reports a version at all', async () => {
    // An agent that reports nothing proves nothing. Refusing on ignorance would
    // suppress every global workflow on a fleet that may well be fine.
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    await runVerdicts(
      roundArgs([candidate('a', { hasFilter: true })], h, { agentRegistry: oldFleet(null, null) }),
    );
    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('still dispatches when even one agent of an otherwise-old fleet is unreadable', async () => {
    // The bar is "every agent reports a version and every one is too old", not
    // "no agent proved itself capable". Refusing suppresses every global
    // workflow for the delivery, so it has to rest on proof rather than on
    // ignorance about part of the fleet — the unreadable agent may be the one
    // that could have decided the round.
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    await runVerdicts(
      roundArgs([candidate('a', { hasFilter: true })], h, {
        agentRegistry: oldFleet('0.4.0', null),
      }),
    );
    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });

  it('still dispatches when an agent reports an unparseable version', async () => {
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    await runVerdicts(
      roundArgs([candidate('a', { hasFilter: true })], h, {
        agentRegistry: oldFleet('0.4.0', 'nightly'),
      }),
    );
    expect(h.dispatcher.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('wait-ceiling clamp', () => {
  /**
   * The pairing that must hold: the orchestrator's ceiling has to outlive the
   * agent's own round budget, which only starts once the round job is RUNNING.
   * A ceiling at or below it fires on every round that merely queued.
   *
   * The admin route refuses the pairing on the values it is handed and the CLI
   * warns, but neither sees a `cluster-settings reset` that nulls one knob while
   * the other stays stored, nor the env pair, which has no cross-field check.
   */
  it('raises a ceiling that does not exceed the round budget', async () => {
    // The round settles at 60ms. The configured ceiling is 20ms — below the
    // 100ms round budget — so without the clamp the wait is abandoned 40ms
    // BEFORE the round settles and the candidate comes back indeterminate. The
    // clamp raises it to twice the budget (200ms), 140ms AFTER it settles.
    // Both margins are wide enough that a loaded box cannot flip the outcome.
    const pendingGlobalEvals = new PendingGlobalEvalTracker();
    const h = {
      dispatched: [] as QueuedJobInput[],
      dispatcher: vi.fn(),
      pendingGlobalEvals,
    } as unknown as ReturnType<typeof harness>;
    h.dispatcher = {
      dispatch: vi.fn(async () => {
        setTimeout(
          () =>
            pendingGlobalEvals.resolve('slow-1', {
              candidates: [{ workflowName: 'a', run: true }],
            } as never),
          60,
        );
        return { status: 'dispatched', jobId: 'slow-1' };
      }),
    } as unknown as ReturnType<typeof harness>['dispatcher'];
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });

    const results = await runVerdicts(
      roundArgs([a], h, {}, { globalEvalRoundTimeoutMs: 100, globalEvalWaitTimeoutMs: 20 }),
    );

    expect(results.get(candidateKey(a))?.run).toBe(true);
  });

  it('leaves a coherent pair alone', async () => {
    // Positive control for the case above: with the ceiling already above the
    // budget the clamp must not move it, so a stuck round gives up at the
    // configured 25ms.
    //
    // 25, not 20: the clamp would raise a 10ms budget to exactly 20ms, so a
    // 20ms ceiling asserts the same string whether or not the clamp fired —
    // the test would pass either way and prove nothing.
    const pendingGlobalEvals = new PendingGlobalEvalTracker();
    const h = {
      dispatched: [] as QueuedJobInput[],
      dispatcher: { dispatch: vi.fn(async () => ({ status: 'queued', jobId: 'stuck-3' })) },
      pendingGlobalEvals,
    } as unknown as ReturnType<typeof harness>;
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });

    const results = await runVerdicts(
      roundArgs([a], h, {}, { globalEvalRoundTimeoutMs: 10, globalEvalWaitTimeoutMs: 25 }),
    );

    expect(results.get(candidateKey(a))?.reason).toContain('25ms');
    // The value the clamp WOULD have produced, asserted absent — this is what
    // makes the case above and this one distinguishable.
    expect(results.get(candidateKey(a))?.reason).not.toContain('20ms');
  });

  it('refuses to raise past the relay force-release window', async () => {
    // A 300s round budget with the wait left at its 240s default: doubling
    // would hold the delivery for 600s, twice, per delivery — past the point
    // the relay stops waiting for it. The raise is capped, and since the cap
    // cannot exceed the budget the configured ceiling is left alone, so the
    // round fails fast and visibly instead of slowly and quietly.
    const pendingGlobalEvals = new PendingGlobalEvalTracker();
    const h = {
      dispatched: [] as QueuedJobInput[],
      dispatcher: { dispatch: vi.fn(async () => ({ status: 'queued', jobId: 'stuck-4' })) },
      pendingGlobalEvals,
    } as unknown as ReturnType<typeof harness>;
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });

    // The ceiling is read straight back out of the timeout message, so the
    // effective value is observable without waiting it out: a 1ms ceiling under
    // a 300_000ms budget is left at 1ms rather than raised to 600_000ms.
    const results = await runVerdicts(
      roundArgs([a], h, {}, { globalEvalRoundTimeoutMs: 300_000, globalEvalWaitTimeoutMs: 1 }),
    );

    expect(results.get(candidateKey(a))?.reason).toContain('within 1ms');
    expect(results.get(candidateKey(a))?.reason).not.toContain('600000');
  });

  it('refuses a raise that clears the round budget by only a sliver', async () => {
    // The dead band the ratio closes. `raised = min(round * 2, 300_000)` at
    // `round = 299_000` buys ONE second of headroom, and the old fail-fast test
    // (`raised <= round`) was false there — so this band took the success path
    // and logged as if it had fixed something, while no ceiling under the cap
    // could outlive the budget and every round failed.
    const pendingGlobalEvals = new PendingGlobalEvalTracker();
    const h = {
      dispatched: [] as QueuedJobInput[],
      dispatcher: { dispatch: vi.fn(async () => ({ status: 'queued', jobId: 'stuck-5' })) },
      pendingGlobalEvals,
    } as unknown as ReturnType<typeof harness>;
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });

    const results = await runVerdicts(
      roundArgs([a], h, {}, { globalEvalRoundTimeoutMs: 299_000, globalEvalWaitTimeoutMs: 2 }),
    );

    // Left at the configured 2ms — fails fast and visibly — rather than raised
    // to a 300_000ms ceiling that would hold the delivery for five minutes and
    // still time out.
    expect(results.get(candidateKey(a))?.reason).toContain('within 2ms');
    expect(results.get(candidateKey(a))?.reason).not.toContain('300000');
  });

  it('raises a configured ceiling that clears the budget by only a sliver', async () => {
    // The same defect reached from the other side: `wait > round` reads as a
    // coherent pair to a bare `>`, but a ceiling one percent above the budget
    // fails every round that waited at all for a free agent.
    const pendingGlobalEvals = new PendingGlobalEvalTracker();
    const h = {
      dispatched: [] as QueuedJobInput[],
      dispatcher: { dispatch: vi.fn(async () => ({ status: 'queued', jobId: 'stuck-6' })) },
      pendingGlobalEvals,
    } as unknown as ReturnType<typeof harness>;
    const a = candidate('a', { hasFilter: true, id: 'reg-a' });

    const results = await runVerdicts(
      roundArgs([a], h, {}, { globalEvalRoundTimeoutMs: 40, globalEvalWaitTimeoutMs: 41 }),
    );

    // Raised to 2 × the 40ms budget, not left at the configured 41ms.
    expect(results.get(candidateKey(a))?.reason).toContain('within 80ms');
  });
});

describe('candidate-budget clamp', () => {
  /**
   * The axis adjacent to the wait ceiling, unguarded until now. A per-candidate
   * budget at or above the whole round's lets ONE candidate consume the entire
   * round; the agent's deadline check then returns and every sibling is padded
   * indeterminate — and because the group WAS decided in part, nothing retries.
   */
  it('lowers a candidate budget that can consume the whole round', async () => {
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    await runVerdicts(
      roundArgs(
        [candidate('a', { hasFilter: true })],
        h,
        {},
        { globalEvalRoundTimeoutMs: 120_000, globalEvalCandidateTimeoutMs: 300_000 },
      ),
    );
    expect(h.dispatched[0].jobConfig.candidateTimeoutMs).toBe(60_000);
  });

  it('leaves the shipped pairing alone', async () => {
    // Positive control: 20s per candidate under a 120s round is the pairing the
    // system is designed around and must pass through untouched.
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    await runVerdicts(
      roundArgs(
        [candidate('a', { hasFilter: true })],
        h,
        {},
        { globalEvalRoundTimeoutMs: 120_000, globalEvalCandidateTimeoutMs: 20_000 },
      ),
    );
    expect(h.dispatched[0].jobConfig.candidateTimeoutMs).toBe(20_000);
  });

  it('clamps a candidate budget that came from cluster settings', async () => {
    // The clamp lives on the EFFECTIVE values because that is the pair the
    // admin route cannot see: a `cluster-settings reset` nulls one knob while
    // the other stays stored.
    const getNumber = vi.fn(async (column: string, fallback: number) => {
      if (column === 'global_eval_candidate_timeout_ms') return 200_000;
      return fallback;
    });
    const h = harness(() => ({ candidates: [{ workflowName: 'a', run: true }] }));
    await runVerdicts(
      roundArgs([candidate('a', { hasFilter: true })], h, {
        clusterSettings: { getNumber } as never,
      }),
    );
    expect(h.dispatched[0].jobConfig.candidateTimeoutMs).toBe(60_000);
  });
});

describe('truncateReasonText', () => {
  /**
   * The agent authors these strings, so their length is unbounded — and they
   * travel verbatim into a commit check's `output.summary`, which GitHub caps at
   * 65535 characters and rejects with a 422 the best-effort post swallows. The
   * check would disappear in exactly the case it exists for.
   */
  it('caps an oversize string and says it was cut', () => {
    const out = truncateReasonText('x'.repeat(500), 100);
    expect(out).toHaveLength(100);
    expect(out.endsWith('… (truncated)')).toBe(true);
  });

  it('leaves a string within the cap byte-identical', () => {
    const text = 'the filter threw: boom';
    expect(truncateReasonText(text, MAX_ROUND_REASON_CHARS)).toBe(text);
  });

  it('bounds the reasons a decided-nothing round reports', async () => {
    // Every candidate carries a distinct oversize reason, so the joined string
    // is ~3x the cap before truncation.
    const huge = (n: number) => `${'r'.repeat(MAX_ROUND_REASON_CHARS)}-${n}`;
    const h = harness(() => ({
      candidates: [
        { workflowName: 'a', run: false, indeterminate: true, reason: huge(1) },
        { workflowName: 'b', run: false, indeterminate: true, reason: huge(2) },
        { workflowName: 'c', run: false, indeterminate: true, reason: huge(3) },
      ],
    }));
    const group = [
      candidate('a', { hasFilter: true, id: 'reg-a' }),
      candidate('b', { hasFilter: true, id: 'reg-b' }),
      candidate('c', { hasFilter: true, id: 'reg-c' }),
    ];

    const { failures } = await runGlobalEvalRounds(roundArgs(group, h));

    expect(failures).toHaveLength(1);
    // Positive control: the reason really did reach the error (so the assertion
    // below is measuring a truncated string, not an absent one).
    expect(failures[0].error).toContain('rrr');
    expect(failures[0].error.length).toBeLessThanOrEqual(MAX_ROUND_REASON_CHARS + 200);
  });
});

describe('truncateReasonText edges', () => {
  it('never returns more than max, even below the marker length', () => {
    // A max under the marker's own length made the naive form return a string
    // LONGER than max — the one thing the cap exists to prevent.
    for (const max of [1, 5, 13, 14]) {
      expect(truncateReasonText('x'.repeat(200), max).length).toBeLessThanOrEqual(max);
    }
  });

  it('does not split a surrogate pair', () => {
    // '𝍢' is a surrogate pair (2 UTF-16 units), so every odd cut index lands
    // between its halves and a naive slice leaves a lone high surrogate — not
    // valid text, and not something an API will accept.
    const text = '𝍢'.repeat(50);
    let oddCuts = 0;
    for (let max = 14; max < 40; max++) {
      const out = truncateReasonText(text, max);
      const body = out.slice(0, out.length - '… (truncated)'.length);
      const last = body.charCodeAt(body.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      expect(out.length).toBeLessThanOrEqual(max);
      if ((max - 13) % 2 === 1) oddCuts++;
    }
    // Positive control: the loop really did exercise the cuts that land
    // mid-pair, so the assertion above had something to catch.
    expect(oddCuts).toBeGreaterThan(0);
  });

  it('returns empty for a non-positive max', () => {
    expect(truncateReasonText('anything', 0)).toBe('');
  });
});
