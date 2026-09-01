import { sha256 } from '@kici-dev/shared';
import { describe, it, expect, vi } from 'vitest';

import { makeFakeScalerStateStore } from '../__test-helpers__/fake-scaler-state-store.js';
import type { ClaimSpec } from './claim-store.js';
import { ClaimStore } from './claim-store.js';
import type { ScalerStateStore } from './scaler-state-store.js';

function makeStateStore(overrides: Record<string, unknown> = {}) {
  return {
    registerClaim: vi.fn().mockResolvedValue(undefined),
    redeemClaim: vi.fn().mockResolvedValue(null),
    describeClaim: vi.fn().mockResolvedValue(null),
    invalidateClaimsForAgent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeSpec(overrides: Partial<ClaimSpec> = {}): ClaimSpec {
  return {
    agentId: 'a1',
    labels: ['x'],
    mandatoryLabels: [],
    agentTokenTtlSeconds: 600,
    orchestratorUrl: 'wss://h/ws',
    ...overrides,
  };
}

const REDEEMED = {
  agentId: 'a1',
  labels: ['x'],
  agentTokenTtlMs: 600000,
  orchestratorUrl: 'wss://h/ws',
};

describe('ClaimStore', () => {
  it('persists only the hash of the code it returns', async () => {
    const stateStore = makeStateStore();
    const store = new ClaimStore({
      createEphemeral: vi.fn(),
      stateStore: stateStore as never,
      scalerName: 'github-actions',
      now: () => 1000,
      ttlDefaultSec: 300,
    });

    const code = await store.register(makeSpec());

    expect(code).toMatch(/^[0-9a-f]{64}$/);
    const row = stateStore.registerClaim.mock.calls[0][0];
    expect(row.claimHash).toBe(sha256(code));
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row.expiresAt.getTime()).toBe(1000 + 300_000);
  });

  it('records the scaler name, prefix, and ms-scaled token TTL on the row', async () => {
    const stateStore = makeStateStore();
    const store = new ClaimStore({
      createEphemeral: vi.fn(),
      stateStore: stateStore as never,
      scalerName: 'github-actions',
      now: () => 1000,
      ttlDefaultSec: 300,
    });

    const code = await store.register(makeSpec({ agentId: 'a9', labels: ['x', 'y'] }));

    expect(stateStore.registerClaim).toHaveBeenCalledWith({
      claimHash: sha256(code),
      claimPrefix: code.slice(0, 12),
      agentId: 'a9',
      scalerName: 'github-actions',
      labels: ['x', 'y'],
      // 600 s -> 600000 ms.
      agentTokenTtlMs: 600000,
      orchestratorUrl: 'wss://h/ws',
      expiresAt: new Date(1000 + 300_000),
    });
  });

  it('refuses to register without a scaler name', async () => {
    const stateStore = makeStateStore();
    const store = new ClaimStore({
      createEphemeral: vi.fn(),
      stateStore: stateStore as never,
      now: () => 1000,
      ttlDefaultSec: 300,
    });

    await expect(store.register(makeSpec())).rejects.toThrow(/scalerName/);
    expect(stateStore.registerClaim).not.toHaveBeenCalled();
  });

  it('claims once and mints a bound ephemeral token', async () => {
    const mint = vi.fn().mockResolvedValue('kat_deadbeef');
    const stateStore = makeStateStore({
      redeemClaim: vi.fn().mockResolvedValue({ ...REDEEMED }),
    });
    const store = new ClaimStore({
      createEphemeral: mint,
      stateStore: stateStore as never,
      scalerName: 'github-actions',
      now: () => 1000,
      ttlDefaultSec: 300,
    });

    const creds = await store.claim('some-code');

    expect(creds.agentToken).toBe('kat_deadbeef');
    expect(creds.agentId).toBe('a1');
    expect(creds.orchestratorUrl).toBe('wss://h/ws');
    expect(creds.labels).toEqual(['x']);
    expect(mint).toHaveBeenCalledWith('a1', ['x'], 600000);
    expect(stateStore.redeemClaim).toHaveBeenCalledWith(sha256('some-code'));
  });

  it('does not describe a claim it successfully redeemed (one round trip)', async () => {
    const stateStore = makeStateStore({
      redeemClaim: vi.fn().mockResolvedValue({ ...REDEEMED }),
    });
    const store = new ClaimStore({
      createEphemeral: vi.fn().mockResolvedValue('kat_deadbeef'),
      stateStore: stateStore as never,
      scalerName: 'github-actions',
      now: () => 1000,
      ttlDefaultSec: 300,
    });

    await store.claim('some-code');

    expect(stateStore.redeemClaim).toHaveBeenCalledOnce();
    expect(stateStore.describeClaim).not.toHaveBeenCalled();
  });

  it('reports a consumed code distinctly from an unknown one', async () => {
    const stateStore = makeStateStore({
      describeClaim: vi.fn().mockResolvedValue({ consumed: true, expired: false }),
    });
    const store = new ClaimStore({
      createEphemeral: vi.fn(),
      stateStore: stateStore as never,
      scalerName: 'github-actions',
      now: () => 1000,
      ttlDefaultSec: 300,
    });
    await expect(store.claim('dead-code')).rejects.toThrow(/consumed/);
    expect(stateStore.describeClaim).toHaveBeenCalledWith(sha256('dead-code'));
  });

  it('reports an expired code distinctly', async () => {
    const stateStore = makeStateStore({
      describeClaim: vi.fn().mockResolvedValue({ consumed: false, expired: true }),
    });
    const store = new ClaimStore({
      createEphemeral: vi.fn(),
      stateStore: stateStore as never,
      scalerName: 'github-actions',
      now: () => 1000,
      ttlDefaultSec: 300,
    });
    await expect(store.claim('old-code')).rejects.toThrow(/expired/);
  });

  it('rejects an unknown claim code without minting', async () => {
    const mint = vi.fn();
    const store = new ClaimStore({
      createEphemeral: mint,
      stateStore: makeStateStore() as never,
      scalerName: 'github-actions',
      now: () => 1000,
      ttlDefaultSec: 300,
    });
    await expect(store.claim('not-a-real-code')).rejects.toThrow(/invalid/);
    expect(mint).not.toHaveBeenCalled();
  });

  it('fails closed: a mint error does not reopen the code', async () => {
    const stateStore = makeStateStore({
      redeemClaim: vi.fn().mockResolvedValue({ ...REDEEMED }),
    });
    const store = new ClaimStore({
      createEphemeral: vi.fn().mockRejectedValue(new Error('db down')),
      stateStore: stateStore as never,
      scalerName: 'github-actions',
      now: () => 1000,
      ttlDefaultSec: 300,
    });
    await expect(store.claim('code')).rejects.toThrow(/db down/);
    // The consumption already committed inside redeemClaim; nothing reopens it.
    expect(stateStore.registerClaim).not.toHaveBeenCalled();
  });

  it('invalidate drops every claim for the agent, on any instance', async () => {
    const stateStore = makeStateStore();
    const store = new ClaimStore({
      createEphemeral: vi.fn(),
      stateStore: stateStore as never,
      scalerName: 'github-actions',
      now: () => 1000,
      ttlDefaultSec: 300,
    });

    await store.invalidate('a9');

    expect(stateStore.invalidateClaimsForAgent).toHaveBeenCalledWith('a9');
  });
});

/**
 * Round trips against `makeFakeScalerStateStore`, which enforces single-use
 * consumption and the TTL the way the real table does. These execute the
 * properties the design rests on, rather than hand-feeding a `describeClaim`
 * answer to a stub.
 */
describe('ClaimStore round trips against a shared pending-claim store', () => {
  function makeStore(
    stateStore: ScalerStateStore,
    now: () => number,
    createEphemeral = vi.fn().mockResolvedValue('kat_1'),
  ) {
    const store = new ClaimStore({
      createEphemeral,
      stateStore,
      scalerName: 'github-actions',
      now,
      ttlDefaultSec: 300,
    });
    return { store, mint: createEphemeral };
  }

  it('rejects a second claim of the same code as already consumed', async () => {
    const now = () => 1000;
    const { store, mint } = makeStore(makeFakeScalerStateStore(now), now);

    const code = await store.register(makeSpec());
    await expect(store.claim(code)).resolves.toMatchObject({ agentToken: 'kat_1' });
    await expect(store.claim(code)).rejects.toThrow(/consumed/);
    expect(mint).toHaveBeenCalledOnce();
  });

  it('rejects a claim after the TTL elapsed', async () => {
    let clock = 1000;
    const now = () => clock;
    const { store, mint } = makeStore(makeFakeScalerStateStore(now), now);

    const code = await store.register(makeSpec());
    clock = 1000 + 301 * 1000; // past the 300 s claim TTL
    await expect(store.claim(code)).rejects.toThrow(/expired/);
    expect(mint).not.toHaveBeenCalled();
  });

  it('invalidate(agentId) makes a subsequent claim of its code unknown', async () => {
    const now = () => 1000;
    const { store, mint } = makeStore(makeFakeScalerStateStore(now), now);

    const code = await store.register(makeSpec({ agentId: 'a9' }));
    await store.invalidate('a9');
    await expect(store.claim(code)).rejects.toThrow(/invalid/);
    expect(mint).not.toHaveBeenCalled();
  });

  it('does not double-mint under two concurrent claims of one code', async () => {
    let resolveMint: (token: string) => void = () => {};
    const mint = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveMint = resolve;
        }),
    );
    const now = () => 1000;
    const { store } = makeStore(makeFakeScalerStateStore(now), now, mint);

    const code = await store.register(makeSpec());
    const first = store.claim(code);
    // The second claim starts before the first mint resolves; the consumption
    // committed inside redeemClaim, so it must already read as consumed.
    await expect(store.claim(code)).rejects.toThrow(/consumed/);
    resolveMint('kat_only');
    await expect(first).resolves.toMatchObject({ agentToken: 'kat_only' });
    expect(mint).toHaveBeenCalledOnce();
  });

  it('redeems on a different instance than the one that registered the claim', async () => {
    // The property this whole change exists for: behind one shared endpoint the
    // redemption lands on whichever coordinator the provisioning workflow
    // reaches, which is not the one that minted the code. Near-tautological
    // while ClaimStore holds no state — and that is the point: it goes red the
    // day an instance-local cache comes back.
    const now = () => 1000;
    const stateStore = makeFakeScalerStateStore(now);
    const mintA = vi.fn().mockResolvedValue('kat_a');
    const mintB = vi.fn().mockResolvedValue('kat_b');
    const { store: instanceA } = makeStore(stateStore, now, mintA);
    const { store: instanceB } = makeStore(stateStore, now, mintB);

    const code = await instanceA.register(makeSpec());
    const creds = await instanceB.claim(code);

    expect(creds.agentToken).toBe('kat_b');
    expect(creds.agentId).toBe('a1');
    expect(creds.labels).toEqual(['x']);
    expect(mintB).toHaveBeenCalledOnce();
    expect(mintA).not.toHaveBeenCalled();

    // Single-use spans instances too: A cannot redeem what B already consumed.
    await expect(instanceA.claim(code)).rejects.toThrow(/consumed/);
    expect(mintA).not.toHaveBeenCalled();
  });
});
