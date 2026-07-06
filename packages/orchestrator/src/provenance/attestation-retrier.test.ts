import { describe, expect, it, vi } from 'vitest';
import { AttestationRetrier } from './attestation-retrier.js';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    run_id: 'r1',
    job_id: 'j1',
    subject_name: 'art',
    subject_digest: 'a'.repeat(64),
    audience: 'kici-provenance',
    dsse_envelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: 'eyJ4Ijoxf',
      signatures: [{ keyid: 'k', sig: 's' }],
    },
    public_key: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
    media_type: 'application/vnd.kici.provenance.bundle+json;version=0.1',
    statement_hash: 'b'.repeat(64),
    origin_kind: 'deferred',
    attempt_count: 0,
    created_at: new Date(),
    last_attempt_at: null,
    last_error: null,
    ...over,
  };
}

function deps(over: Record<string, unknown> = {}) {
  return {
    repo: {
      list: vi.fn(async () => [row()]),
      recordAttempt: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      countAndOldest: vi.fn(async () => ({ count: 0, oldestCreatedAt: null })),
      countRejected: vi.fn(async () => 0),
      markRejected: vi.fn(async () => {}),
      clearRejected: vi.fn(async () => 0),
    },
    requestMint: vi.fn(async () => ({ token: 'jwt', expiresIn: 600, jti: 'r1:j1' })),
    uploadBundle: vi.fn(async () => {}),
    computeVerdict: vi.fn(async () => ({
      verifyStatus: 'verified',
      verifyReason: null,
      verifiedAt: new Date(),
    })),
    recordAttestation: vi.fn(async () => {}),
    backfillRun: vi.fn(async () => {}),
    setMetrics: vi.fn(),
    isLeader: () => true,
    orchestratorId: 'o1',
    intervalMs: 60_000,
    provenanceStorageKey: (r: string, j: string, d: string) =>
      `provenance/${r}/${j}/${d}.kici.json`,
    ...over,
  };
}

describe('AttestationRetrier.fulfilOne', () => {
  it('mints, uploads, records, deletes for a transient (deferred) row', async () => {
    const d = deps();
    const r = new AttestationRetrier(d as never);
    const outcome = await r.fulfilOne(row() as never);
    expect(outcome).toBe('minted');
    expect(d.backfillRun).not.toHaveBeenCalled(); // transient: no backfill
    expect(d.requestMint).toHaveBeenCalledWith(
      expect.objectContaining({
        deferred: { statementHash: 'b'.repeat(64), origin: 'deferred' },
      }),
    );
    expect(d.recordAttestation).toHaveBeenCalledOnce();
    expect(d.repo.delete).toHaveBeenCalledWith('p1');
  });

  it('backfills before minting for an offline-backfill row', async () => {
    const d = deps();
    const r = new AttestationRetrier(d as never);
    await r.fulfilOne(row({ origin_kind: 'offline-backfill' }) as never);
    expect(d.backfillRun).toHaveBeenCalledWith('r1');
    const backfillFirst =
      d.backfillRun.mock.invocationCallOrder[0] < d.requestMint.mock.invocationCallOrder[0];
    expect(backfillFirst).toBe(true);
    expect(d.requestMint).toHaveBeenCalledWith(
      expect.objectContaining({
        deferred: { statementHash: 'b'.repeat(64), origin: 'offline-backfill' },
      }),
    );
  });

  it('keeps the row and records the error on a still-failing mint', async () => {
    const d = deps({
      requestMint: vi.fn(async () => {
        throw new Error('mint 404');
      }),
    });
    const r = new AttestationRetrier(d as never);
    const outcome = await r.fulfilOne(row() as never);
    expect(outcome).toBe('deferred');
    expect(d.repo.recordAttempt).toHaveBeenCalledWith('p1', 'mint 404');
    expect(d.repo.delete).not.toHaveBeenCalled();
  });

  it('leaves the row when the mint still returns a transient deferral', async () => {
    const d = deps({ requestMint: vi.fn(async () => ({ deferred: true, code: 'unavailable' })) });
    const r = new AttestationRetrier(d as never);
    const outcome = await r.fulfilOne(row() as never);
    expect(outcome).toBe('deferred');
    expect(d.repo.recordAttempt).toHaveBeenCalledWith('p1', 'mint still unavailable');
    expect(d.uploadBundle).not.toHaveBeenCalled();
    expect(d.repo.delete).not.toHaveBeenCalled();
  });

  it('marks the row terminally rejected and returns "rejected" on a definitive rejection', async () => {
    const d = deps({
      requestMint: vi.fn(async () => ({ rejected: true, reason: 'run r1 not found for org o1' })),
    });
    const r = new AttestationRetrier(d as never);
    const outcome = await r.fulfilOne(row() as never);
    expect(outcome).toBe('rejected');
    expect(d.repo.markRejected).toHaveBeenCalledWith('p1', 'run r1 not found for org o1');
    // A terminal rejection never touches the mint bundle path or the transient
    // retry counter — the row is parked, not re-attempted.
    expect(d.uploadBundle).not.toHaveBeenCalled();
    expect(d.repo.delete).not.toHaveBeenCalled();
    expect(d.repo.recordAttempt).not.toHaveBeenCalled();
  });
});

describe('AttestationRetrier.tick', () => {
  it('is a no-op when not the leader and reports metrics when leader', async () => {
    const notLeader = deps({ isLeader: () => false });
    const rn = new AttestationRetrier(notLeader as never);
    await rn.tick();
    expect(notLeader.repo.list).not.toHaveBeenCalled();

    const leader = deps();
    const rl = new AttestationRetrier(leader as never);
    await rl.tick();
    expect(leader.repo.list).toHaveBeenCalled();
    expect(leader.setMetrics).toHaveBeenCalledWith(0, null, 0);
  });

  it('passes the rejected count as the third setMetrics arg', async () => {
    const repo = {
      list: vi.fn(async () => []),
      recordAttempt: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      countAndOldest: vi.fn(async () => ({ count: 0, oldestCreatedAt: null })),
      countRejected: vi.fn(async () => 3),
      markRejected: vi.fn(async () => {}),
      clearRejected: vi.fn(async () => 0),
    };
    const d = deps({ repo });
    const rl = new AttestationRetrier(d as never);
    await rl.tick();
    expect(d.setMetrics).toHaveBeenCalledWith(0, null, 3);
  });
});

describe('AttestationRetrier.runOnce', () => {
  it('tallies minted / stillPending / rejected across a mixed batch', async () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const requestMint = vi
      .fn()
      .mockResolvedValueOnce({ token: 'jwt', expiresIn: 600, jti: 'a' }) // minted
      .mockResolvedValueOnce({ deferred: true, code: 'unavailable' }) // stillPending
      .mockResolvedValueOnce({ rejected: true, reason: 'job c not found' }); // rejected
    const repo = {
      list: vi.fn(async () => rows),
      recordAttempt: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      countAndOldest: vi.fn(async () => ({ count: 1, oldestCreatedAt: null })),
      countRejected: vi.fn(async () => 1),
      markRejected: vi.fn(async () => {}),
      clearRejected: vi.fn(async () => 0),
    };
    const d = deps({ requestMint, repo });
    const r = new AttestationRetrier(d as never);
    const res = await r.runOnce();
    expect(res).toEqual({ minted: 1, stillPending: 1, rejected: 1 });
  });

  it('clears rejected rows before listing when includeRejected is set', async () => {
    const d = deps();
    const r = new AttestationRetrier(d as never);
    await r.runOnce({ includeRejected: true });
    expect(d.repo.clearRejected).toHaveBeenCalledWith({});
    const clearFirst =
      d.repo.clearRejected.mock.invocationCallOrder[0] < d.repo.list.mock.invocationCallOrder[0];
    expect(clearFirst).toBe(true);
  });

  it('scopes the re-arm to a run when runId + includeRejected are given', async () => {
    const d = deps();
    const r = new AttestationRetrier(d as never);
    await r.runOnce({ runId: 'r9', includeRejected: true });
    expect(d.repo.clearRejected).toHaveBeenCalledWith({ runId: 'r9' });
    expect(d.repo.list).toHaveBeenCalledWith({ runId: 'r9' });
  });

  it('does not clear rejected rows when includeRejected is absent', async () => {
    const d = deps();
    const r = new AttestationRetrier(d as never);
    await r.runOnce();
    expect(d.repo.clearRejected).not.toHaveBeenCalled();
  });
});
