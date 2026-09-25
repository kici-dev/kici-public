import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { Signer } from './signer.js';

// The warning under test goes through this module's own logger; no other test
// in this file inspects logging, so a warn-spying stub is safe.
const mockWarn = vi.hoisted(() => vi.fn());
vi.mock('@kici-dev/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kici-dev/shared')>();
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
  };
});

import {
  createOrchestratorOidcTokenHandler,
  MINT_DEFER_WARN_INTERVAL_MS,
  MINT_DEFERRED_NO_SIGNER_MESSAGE,
} from './orchestrator-mint.js';
import { selectOidcMintRegistration } from './oidc-mint-registration.js';

const PARAMS = { jobId: 'job-1', audience: 'kici-provenance' };

/** The handler reaches the database only after a signer resolves. */
const unusedDb = {} as Kysely<Database>;

function handlerWith(opts: {
  resolveSigner: () => Promise<Signer | null>;
  isLeader?: () => boolean;
}) {
  return createOrchestratorOidcTokenHandler({
    dispatcher: { resolveOwnedJob: (_agentId, jobId) => ({ runId: `run-of-${jobId}` }) },
    resolveSigner: opts.resolveSigner,
    ...(opts.isLeader ? { isLeader: opts.isLeader } : {}),
    mint: { db: unusedDb, issuer: 'https://orch.example', orchestratorId: 'orch-1' },
  });
}

describe('mint deferral warning', () => {
  beforeEach(() => {
    mockWarn.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('warns once, naming the job, run and leadership, when a mint defers for want of a key', async () => {
    const handler = handlerWith({ resolveSigner: async () => null, isLeader: () => false });
    await expect(handler('agent-x', PARAMS)).resolves.toEqual({
      deferred: true,
      code: 'unavailable',
    });
    // fails-when: the deferral is silent — the operator sees only the job's
    // deferred result and no line saying the signing key is missing.
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith(MINT_DEFERRED_NO_SIGNER_MESSAGE, {
      jobId: 'job-1',
      runId: 'run-of-job-1',
      agentId: 'agent-x',
      deferredSinceLastWarning: 0,
      nodeIsLeader: false,
      hint: expect.stringContaining('not the Raft leader'),
    });
    // fails-when: the non-leader hint says only that the node waits on the
    // leader — past the grace the node creates the key itself, so a deferral
    // there is a load or create failure the earlier error lines explain.
    expect(mockWarn.mock.calls[0]![1].hint).toMatch(/errors logged before this line/);
  });

  it('rate-limits repeated deferrals and counts the suppressed ones into the next warning', async () => {
    const handler = handlerWith({ resolveSigner: async () => null, isLeader: () => true });
    await handler('agent-x', PARAMS);
    await handler('agent-x', { ...PARAMS, jobId: 'job-2' });
    await handler('agent-x', { ...PARAMS, jobId: 'job-3' });
    // fails-when: every deferral warns — one line per job for as long as the key is missing.
    expect(mockWarn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MINT_DEFER_WARN_INTERVAL_MS);
    await handler('agent-x', { ...PARAMS, jobId: 'job-4' });
    expect(mockWarn).toHaveBeenCalledTimes(2);
    expect(mockWarn.mock.calls[1]![1]).toMatchObject({
      jobId: 'job-4',
      runId: 'run-of-job-4',
      deferredSinceLastWarning: 2,
      nodeIsLeader: true,
      hint: expect.stringContaining('is the Raft leader'),
    });
  });

  it('warns again at once after a signer was available in between', async () => {
    // breaks-if-wrong: a fresh outage must not stay silent for the rest of the
    // previous outage's interval.
    let signer: Signer | null = null;
    const handler = handlerWith({ resolveSigner: async () => signer });
    await handler('agent-x', PARAMS);
    expect(mockWarn).toHaveBeenCalledTimes(1);

    signer = { getKid: async () => 'kid-1' } as unknown as Signer;
    await handler('agent-x', PARAMS).catch(() => undefined);
    signer = null;
    await handler('agent-x', PARAMS);
    expect(mockWarn).toHaveBeenCalledTimes(2);
    // No leadership source was wired, so no leadership fields.
    expect(mockWarn.mock.calls[1]![1]).not.toHaveProperty('nodeIsLeader');
  });

  it('the registered agent.api handler carries the node leadership into the warning', async () => {
    // fails-when: the registration drops isLeader, so the warning cannot say
    // whether this node was waiting on the leader.
    const reg = selectOidcMintRegistration({
      independentIdentity: false,
      resolveOrchestratorSigner: async () => null,
      isLeader: () => false,
      provenanceSigningIssuer: 'https://orch.example',
      dispatcher: {
        resolveOwnedJob: () => ({ runId: 'run-1' }),
      } as unknown as Parameters<typeof selectOidcMintRegistration>[0]['dispatcher'],
      db: unusedDb,
      orchestratorId: 'orch-1',
    });
    await reg!.handler('agent-x', PARAMS);
    expect(mockWarn.mock.calls[0]![1]).toMatchObject({ runId: 'run-1', nodeIsLeader: false });
  });

  it('does not warn when the mint gets a signer', async () => {
    const signer = { getKid: async () => 'kid-1' } as unknown as Signer;
    const handler = handlerWith({ resolveSigner: async () => signer });
    await handler('agent-x', PARAMS).catch(() => undefined);
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
