import { describe, it, expect, vi } from 'vitest';
import type { SimulatedEvent } from '@kici-dev/engine';
import { normalizeRoundEvent, withChangedFiles } from './rerun-inputs.js';
import type { OriginalRunRow } from './rerun.js';
import type { WebhookInfo } from '../webhook/handler.js';

type Bundle = Parameters<typeof withChangedFiles>[0]['bundle'];

const event: SimulatedEvent = {
  type: 'push',
  targetBranch: 'main',
  payload: { before: 'a'.repeat(40), after: 'b'.repeat(40) },
};
const info = { event: 'push' } as WebhookInfo;

function bundleWith(fetcher?: Bundle['changedFilesFetcher']): Bundle {
  return {
    normalizer: { provider: 'github' },
    ...(fetcher && { changedFilesFetcher: fetcher }),
  } as unknown as Bundle;
}

describe('withChangedFiles', () => {
  it('a bundle with no fetcher stamps unavailable and the source repo', async () => {
    const out = await withChangedFiles({
      event,
      bundle: bundleWith(),
      info,
      payload: event.payload,
      credentials: {},
      repoIdentifier: 'o/r',
    });
    expect(out).toMatchObject({
      changedFiles: [],
      changedFilesStatus: 'unavailable',
      sourceRepo: 'o/r',
    });
  });

  // fails-when: the rerun resolve is gated on a lock file it does not have
  it('resolves unconditionally through the fetcher', async () => {
    const getChangedFiles = vi.fn().mockResolvedValue({ files: ['a'], status: 'fetched' });
    const out = await withChangedFiles({
      event,
      bundle: bundleWith({ provider: 'github', getChangedFiles }),
      info,
      payload: event.payload,
      credentials: { token: 't' },
      repoIdentifier: 'o/r',
    });
    expect(getChangedFiles).toHaveBeenCalledWith('o/r', 'push', event.payload, { token: 't' });
    expect(out).toMatchObject({
      changedFiles: ['a'],
      changedFilesStatus: 'fetched',
      sourceRepo: 'o/r',
    });
  });

  it('a fetcher failure stamps unavailable', async () => {
    const getChangedFiles = vi.fn().mockRejectedValue(new Error('boom'));
    const out = await withChangedFiles({
      event,
      bundle: bundleWith({ provider: 'github', getChangedFiles }),
      info,
      payload: event.payload,
      credentials: {},
      repoIdentifier: 'o/r',
    });
    expect(out.changedFilesStatus).toBe('unavailable');
  });

  it('stamps the default branch the normalizer names', async () => {
    const out = await withChangedFiles({
      event,
      bundle: bundleWith(),
      info,
      payload: { ...event.payload, repository: { default_branch: 'trunk' } },
      credentials: {},
      repoIdentifier: 'o/r',
    });
    expect(out.defaultBranch).toBe('trunk');
  });
});

describe('normalizeRoundEvent', () => {
  // The re-run dispatches this event, not the stamped copy withChangedFiles
  // returns, so an init job's new-branch diff reads the default branch from it.
  // fails-when: the re-run event carries no defaultBranch and a GitLab new branch reads as range-less
  it('stamps the default branch the normalizer names', () => {
    const normalizer = {
      provider: 'gitlab',
      normalizeEvent: () => ({ type: 'push', targetBranch: 'feature', payload: {} }),
      extractDefaultBranch: (p: Record<string, unknown>) =>
        (p.project as { default_branch?: string } | undefined)?.default_branch ?? null,
    };
    const out = normalizeRoundEvent(
      { run_id: 'r1' } as OriginalRunRow,
      { normalizer } as unknown as Parameters<typeof normalizeRoundEvent>[1],
      { event: 'push', action: null },
      { project: { default_branch: 'trunk' } },
    );
    expect(out.defaultBranch).toBe('trunk');
  });
});
