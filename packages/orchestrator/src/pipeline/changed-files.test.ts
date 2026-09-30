import { describe, it, expect, vi } from 'vitest';
import type { ChangedFilesFetcher, LockWorkflow, SimulatedEvent } from '@kici-dev/engine';
import {
  DEFERRED_PATHS_SUMMARY_SUFFIX,
  UnavailablePathsTrace,
  diffRangeKindSchema,
} from '@kici-dev/engine';
import {
  resolveEventChangedFiles,
  stampChangedFiles,
  withDefaultBranch,
  withoutCrossSourcePrDeferral,
} from './changed-files.js';

const Kind = diffRangeKindSchema.enum;
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const event: SimulatedEvent = {
  type: 'push',
  targetBranch: 'main',
  payload: { before: SHA_A, after: SHA_B },
};
const pathWorkflow = {
  name: 'wf',
  contentHash: '',
  compileSchemaVersion: 0,
  triggers: [{ _type: 'push', branches: [], paths: ['src/**'] }],
  jobs: [],
} as unknown as LockWorkflow;
const noPathWorkflow = {
  ...pathWorkflow,
  triggers: [{ _type: 'push', branches: [], paths: [] }],
} as unknown as LockWorkflow;

function fetcher(impl: ChangedFilesFetcher['getChangedFiles']): ChangedFilesFetcher {
  return { provider: 'github', getChangedFiles: vi.fn(impl) };
}
const base = {
  credentials: {},
  repoIdentifier: 'o/r',
  eventName: 'push',
  payload: event.payload,
  event,
};

describe('resolveEventChangedFiles', () => {
  it('skips the fetch when no workflow has path patterns', async () => {
    const f = fetcher(async () => ({ files: ['x'], status: 'fetched' }));
    const r = await resolveEventChangedFiles({
      ...base,
      bundle: { changedFilesFetcher: f },
      workflows: [noPathWorkflow],
    });
    expect(r).toEqual({
      files: [],
      status: 'skipped',
      range: { kind: Kind['two-dot'], base: SHA_A, head: SHA_B },
    });
    expect(f.getChangedFiles).not.toHaveBeenCalled();
  });

  it('resolves when workflows is omitted (a re-evaluation with no lock file)', async () => {
    const f = fetcher(async () => ({ files: ['src/a.ts'], status: 'fetched' }));
    const r = await resolveEventChangedFiles({ ...base, bundle: { changedFilesFetcher: f } });
    expect(r.status).toBe('fetched');
  });

  // fails-when: a bundle with no fetcher reports `skipped` (the local-provider defect)
  it('a bundle with no fetcher is unavailable, never skipped', async () => {
    const r = await resolveEventChangedFiles({ ...base, bundle: {}, workflows: [pathWorkflow] });
    expect(r.status).toBe('unavailable');
  });

  it('a deleted branch is fetched + [] without calling the fetcher', async () => {
    const f = fetcher(async () => ({ files: ['x'], status: 'fetched' }));
    const deleted = { ...event, payload: { before: SHA_A, after: '0'.repeat(40) } };
    const r = await resolveEventChangedFiles({
      ...base,
      event: deleted,
      bundle: { changedFilesFetcher: f },
      workflows: [pathWorkflow],
    });
    expect(r).toMatchObject({ files: [], status: 'fetched' });
    expect(f.getChangedFiles).not.toHaveBeenCalled();
  });

  // fails-when: a fetch failure propagates and fails the delivery
  it('a fetcher failure becomes unavailable and keeps the range', async () => {
    const f = fetcher(async () => {
      throw new Error('changed-files fetch failed — trigger evaluation degraded: 502');
    });
    const r = await resolveEventChangedFiles({
      ...base,
      bundle: { changedFilesFetcher: f },
      workflows: [pathWorkflow],
    });
    expect(r).toEqual({
      files: [],
      status: 'unavailable',
      range: { kind: Kind['two-dot'], base: SHA_A, head: SHA_B },
    });
  });

  it('passes the fetcher result through', async () => {
    const f = fetcher(async () => ({ files: ['src/a.ts'], status: 'fetched' }));
    const r = await resolveEventChangedFiles({
      ...base,
      bundle: { changedFilesFetcher: f },
      workflows: [pathWorkflow],
    });
    expect(r.files).toEqual(['src/a.ts']);
    expect(f.getChangedFiles).toHaveBeenCalledWith('o/r', 'push', event.payload, {});
  });
});

describe('stampChangedFiles', () => {
  it('copies files and status onto the event', () => {
    const e = stampChangedFiles(event, {
      files: ['a'],
      status: 'fetched',
      range: { kind: Kind.none },
    });
    expect(e.changedFiles).toEqual(['a']);
    expect(e.changedFilesStatus).toBe('fetched');
  });
});

describe('withDefaultBranch', () => {
  const normalizerWith = (hook?: (p: Record<string, unknown>) => string | null) =>
    ({ ...(hook && { extractDefaultBranch: hook }) }) as never;

  it('stamps payload.repository.default_branch', () => {
    const e = withDefaultBranch(
      event,
      { repository: { default_branch: 'main' } },
      normalizerWith(),
    );
    expect(e.defaultBranch).toBe('main');
  });

  it('prefers the normalizer hook (GitLab project.default_branch)', () => {
    const e = withDefaultBranch(
      event,
      { project: { default_branch: 'trunk' } },
      normalizerWith((p) => (p.project as { default_branch: string }).default_branch),
    );
    expect(e.defaultBranch).toBe('trunk');
  });

  it('leaves the event unchanged when nothing names a default branch', () => {
    expect(withDefaultBranch(event, {}, normalizerWith())).toBe(event);
  });
});

describe('withoutCrossSourcePrDeferral', () => {
  const deferred = {
    workflowName: 'wf',
    matched: true,
    matchedTrigger: 0,
    summary: `Matched trigger 1 (pr)${DEFERRED_PATHS_SUMMARY_SUFFIX}`,
    checks: [
      {
        check: 'paths',
        pattern: 'include: [src/**] exclude: []',
        value: UnavailablePathsTrace.DecidedOnAgent,
        passed: true,
      },
    ],
    deferredPaths: [['src/**']],
  };
  const prEvent: SimulatedEvent = {
    type: 'pull_request',
    targetBranch: 'main',
    baseBranch: 'main',
    payload: {},
    changedFilesStatus: 'unavailable',
  };

  // fails-when: a cross-source PR keeps its deferral and the agent diffs the registration commit
  it('turns a pull-request deferral into a conservative match', () => {
    const d = withoutCrossSourcePrDeferral(deferred, prEvent);
    expect(d.matched).toBe(true);
    expect(d.deferredPaths).toBeUndefined();
    expect(d.checks[0]?.value).toBe(UnavailablePathsTrace.Conservative);
    expect(d.summary).toBe('Matched trigger 1 (pr)');
  });

  // breaks-if-wrong: a push diffs explicit commits, so its deferral must stay
  it('keeps a push deferral', () => {
    expect(withoutCrossSourcePrDeferral(deferred, event)).toBe(deferred);
  });

  it('leaves a decision with nothing deferred unchanged', () => {
    const { deferredPaths: _none, ...plain } = deferred;
    expect(withoutCrossSourcePrDeferral(plain, prEvent)).toBe(plain);
  });
});
