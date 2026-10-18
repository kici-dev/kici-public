import { describe, it, expect, vi } from 'vitest';
import { resolveRunRef } from './run-ref.js';

const FULL = '709c899a-b06f-45d0-a3e2-d0a14fa62094';
const OTHER = '709c899a-0000-4000-8000-000000000000';

function client(runIds: string[], hasMore = false) {
  return {
    listRuns: vi.fn(async () => ({
      runs: runIds.map((runId) => ({ runId })),
      hasMore,
      nextCursor: null,
      prevCursor: null,
      approxTotal: runIds.length,
      pageSize: 20,
    })),
  } as never as Parameters<typeof resolveRunRef>[0] & { listRuns: ReturnType<typeof vi.fn> };
}

describe('resolveRunRef', () => {
  it('uses a full run id as typed, with no lookup', async () => {
    const c = client([]);
    // breaks-if-wrong: the common case costs no extra request
    expect(await resolveRunRef(c, FULL)).toBe(FULL);
    expect(c.listRuns).not.toHaveBeenCalled();
  });

  it('resolves the short id people copy to the one run it names', async () => {
    const c = client([FULL]);
    // fails-when: the short id is passed on as a run id and the Platform answers 404
    expect(await resolveRunRef(c, '709c899a')).toBe(FULL);
    // breaks-if-wrong: an archived run with the same prefix is not hidden from the lookup
    expect(c.listRuns).toHaveBeenCalledWith({ runIdPrefix: '709c899a', includeArchived: true });
  });

  it('names every match of an ambiguous prefix', async () => {
    // fails-when: the first match is picked silently
    await expect(resolveRunRef(client([FULL, OTHER]), '709c899a')).rejects.toThrow(
      `Run id prefix '709c899a' is ambiguous: it matches ${FULL}, ${OTHER}.`,
    );
    await expect(resolveRunRef(client([FULL], true), '709c899a')).rejects.toThrow('and 1 more');
  });

  it('says when no run starts with the prefix, and where full ids are', async () => {
    await expect(resolveRunRef(client([]), 'deadbeef')).rejects.toThrow(
      "No run id starts with 'deadbeef' ('kici runs list' shows full run ids).",
    );
  });

  it('falls back to the local run history when the list has no match', async () => {
    // breaks-if-wrong: a run only the local history knows still resolves
    expect(await resolveRunRef(client([]), '709c899a', [FULL])).toBe(FULL);
  });

  it('names a Platform that ignores the prefix filter instead of trusting one page', async () => {
    const unrelated = '11111111-0000-4000-8000-000000000000';
    // fails-when: one match on a page of unrelated runs is picked, though more pages exist
    await expect(resolveRunRef(client([unrelated, FULL], true), '709c899a')).rejects.toThrow(
      "The Platform cannot look up the run id prefix '709c899a'",
    );
    // breaks-if-wrong: an unfiltered list that holds every run still resolves its match
    expect(await resolveRunRef(client([unrelated, FULL]), '709c899a')).toBe(FULL);
  });

  it('refuses text that cannot be a run id before any request', async () => {
    const c = client([]);
    await expect(resolveRunRef(c, 'not-a-run')).rejects.toThrow("Invalid run id 'not-a-run'");
    expect(c.listRuns).not.toHaveBeenCalled();
  });
});
