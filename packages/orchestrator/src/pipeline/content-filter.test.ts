import { describe, it, expect } from 'vitest';
import type { FileContentsFetcher, LockContentRequirement } from '@kici-dev/engine';
import { filterByContentRequirements, type ContentFilterCandidate } from './content-filter.js';
import { ContentRequirementsCache } from '../content-requirements-cache.js';

function newCache(): ContentRequirementsCache {
  return new ContentRequirementsCache({ max: 100, ttl: 60_000 });
}

function cand(name: string, requires: LockContentRequirement[]): ContentFilterCandidate {
  return { name, requires };
}

function evt(repo: string, sha: string): { repo: string; sha: string } {
  return { repo, sha };
}

/** Fake fetcher keyed by `${owner}/${repo}@${ref}:${path}` → the getFileContents result. */
function fakeFetcher(
  map: Record<string, { present: boolean; bytes?: string }>,
): FileContentsFetcher {
  return {
    provider: 'github',
    async getFileContents(owner, repo, path, ref) {
      const key = `${owner}/${repo}@${ref}:${path}`;
      return map[key] ?? { present: false };
    },
  };
}

/** Fetcher that counts calls, returning one fixed present-with-bytes result. */
function countingFetcher(bytes: string): FileContentsFetcher & { calls: number } {
  const f = {
    provider: 'github' as const,
    calls: 0,
    async getFileContents() {
      f.calls++;
      return { present: true, bytes };
    },
  };
  return f;
}

describe('filterByContentRequirements', () => {
  it('drops a candidate whose requires does not match and keeps one that does', async () => {
    const fetcher = fakeFetcher({
      'o/r@sha:package.json': { present: true, bytes: '{"scripts":{}}' },
    });
    const { survivors, dropped } = await filterByContentRequirements(
      [
        cand('A', [{ file: 'package.json', format: 'json', exists: ['$.scripts.ci'] }]),
        cand('B', []),
      ],
      evt('o/r', 'sha'),
      { fetcher, cache: newCache() },
    );
    expect(survivors.map((c) => c.name)).toEqual(['B']);
    // A definite content mismatch: the requirement WAS evaluated and said no.
    // This is the one drop shape that is not indeterminate, and the trace
    // renders it as an exclusion the author's own requirement caused.
    expect(dropped[0]).toMatchObject({ name: 'A', indeterminate: false });
  });

  it('keeps a candidate whose requires matches', async () => {
    const fetcher = fakeFetcher({
      'o/r@sha:package.json': { present: true, bytes: '{"scripts":{"ci":"vitest"}}' },
    });
    const { survivors, dropped } = await filterByContentRequirements(
      [cand('A', [{ file: 'package.json', format: 'json', exists: ['$.scripts.ci'] }])],
      evt('o/r', 'sha'),
      { fetcher, cache: newCache() },
    );
    expect(survivors.map((c) => c.name)).toEqual(['A']);
    expect(dropped).toHaveLength(0);
  });

  it('fetches each (repo,sha,path) once even across candidates and cache calls', async () => {
    const fetcher = countingFetcher('{"a":1,"b":2}');
    const cache = newCache();
    await filterByContentRequirements(
      [
        cand('A', [{ file: 'p', format: 'json', exists: ['$.a'] }]),
        cand('B', [{ file: 'p', format: 'json', exists: ['$.b'] }]),
      ],
      evt('o/r', 'sha'),
      { fetcher, cache },
    );
    expect(fetcher.calls).toBe(1);

    // A second filter call for the same key hits the cache — still one fetch total.
    await filterByContentRequirements(
      [cand('C', [{ file: 'p', format: 'json', exists: ['$.a'] }])],
      evt('o/r', 'sha'),
      { fetcher, cache },
    );
    expect(fetcher.calls).toBe(1);
  });

  it('drops an indeterminate (unparseable) candidate and never passes it', async () => {
    const fetcher = fakeFetcher({ 'o/r@sha:package.json': { present: true, bytes: '{bad' } });
    const { survivors, dropped } = await filterByContentRequirements(
      [cand('A', [{ file: 'package.json', format: 'json', exists: ['$.a'] }])],
      evt('o/r', 'sha'),
      { fetcher, cache: newCache() },
    );
    expect(survivors).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/parse/i);
    expect(dropped[0]?.indeterminate).toBe(true);
  });

  it('drops a present-without-bytes (oversize) candidate as indeterminate, not absent', async () => {
    // The over-1-MiB case: present, but no inline bytes. A byte-reading query
    // must NOT treat this as an absent/empty file — it drops as indeterminate.
    const fetcher = fakeFetcher({ 'o/r@sha:big.json': { present: true } });
    const { survivors, dropped } = await filterByContentRequirements(
      [cand('A', [{ file: 'big.json', format: 'json', exists: ['$.a'] }])],
      evt('o/r', 'sha'),
      { fetcher, cache: newCache() },
    );
    expect(survivors).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/unavailable|size/i);
    expect(dropped[0]?.indeterminate).toBe(true);
  });

  it('drops a contains-only requirement as indeterminate when bytes are unavailable', async () => {
    // A raw-text `contains` query reads bytes, so a present-without-bytes (oversize)
    // file must drop as indeterminate — not slip through as a bare existence check.
    const fetcher = fakeFetcher({ 'o/r@sha:big.txt': { present: true } });
    const { survivors, dropped } = await filterByContentRequirements(
      [cand('A', [{ file: 'big.txt', contains: ['x'] }])],
      evt('o/r', 'sha'),
      { fetcher, cache: newCache() },
    );
    expect(survivors).toHaveLength(0);
    expect(dropped[0]?.indeterminate).toBe(true);
    expect(dropped[0]?.reason).toMatch(/unavailable|size/i);
  });

  it('passes a bare existence check even when the file is present without inline bytes', async () => {
    // A `{ file }` existence check needs no bytes — a present-without-bytes file
    // still satisfies "the file exists".
    const fetcher = fakeFetcher({ 'o/r@sha:big.bin': { present: true } });
    const { survivors } = await filterByContentRequirements(
      [cand('A', [{ file: 'big.bin' }])],
      evt('o/r', 'sha'),
      { fetcher, cache: newCache() },
    );
    expect(survivors.map((c) => c.name)).toEqual(['A']);
  });

  it('honors an absent requirement (passes when the file is missing)', async () => {
    const fetcher = fakeFetcher({});
    const { survivors } = await filterByContentRequirements(
      [cand('A', [{ file: 'legacy.json', absent: true }])],
      evt('o/r', 'sha'),
      { fetcher, cache: newCache() },
    );
    expect(survivors.map((c) => c.name)).toEqual(['A']);
  });

  it('drops a candidate when a fetch throws (indeterminate, fail-visible)', async () => {
    const fetcher: FileContentsFetcher = {
      provider: 'github',
      async getFileContents() {
        throw new Error('boom');
      },
    };
    const { survivors, dropped } = await filterByContentRequirements(
      [cand('A', [{ file: 'package.json', format: 'json', exists: ['$.a'] }])],
      evt('o/r', 'sha'),
      { fetcher, cache: newCache() },
    );
    expect(survivors).toHaveLength(0);
    expect(dropped[0]?.reason).toMatch(/fetch failed/i);
    expect(dropped[0]?.indeterminate).toBe(true);
  });

  it('drops a requires-bearing candidate when no fetcher is available', async () => {
    const { survivors, dropped } = await filterByContentRequirements(
      [cand('A', [{ file: 'package.json', format: 'json', exists: ['$.a'] }]), cand('B', [])],
      evt('o/r', 'sha'),
      { fetcher: undefined, cache: newCache() },
    );
    expect(survivors.map((c) => c.name)).toEqual(['B']);
    // Nothing ever read the requirement — a provider with no file-contents
    // fetcher is an infrastructure gap, not the author's filter saying no.
    expect(dropped[0]).toMatchObject({ name: 'A', indeterminate: true });
  });

  it('does not fetch at all when no candidate has requires', async () => {
    const fetcher = countingFetcher('{}');
    const { survivors } = await filterByContentRequirements(
      [cand('A', []), cand('B', [])],
      evt('o/r', 'sha'),
      { fetcher, cache: newCache() },
    );
    expect(survivors.map((c) => c.name)).toEqual(['A', 'B']);
    expect(fetcher.calls).toBe(0);
  });
});
