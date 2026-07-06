import { describe, expect, it, vi } from 'vitest';
import { OrchRpcRegistry, ORCH_RPC_RESPONSE_TYPES } from './orch-rpc.js';

describe('OrchRpcRegistry', () => {
  it('resolves a pending request by requestId', async () => {
    const reg = new OrchRpcRegistry();
    const p = reg.register('r1', 1000);
    reg.resolve('r1', { type: 'oidc.mint.response', requestId: 'r1', ok: true });
    await expect(p).resolves.toEqual({ type: 'oidc.mint.response', requestId: 'r1', ok: true });
  });

  it('times out when no response arrives', async () => {
    vi.useFakeTimers();
    const reg = new OrchRpcRegistry();
    const p = reg.register('r2', 50);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });

  it('rejects all pending on rejectAll', async () => {
    const reg = new OrchRpcRegistry();
    const p = reg.register('r3', 1000);
    reg.rejectAll(new Error('connection closed'));
    await expect(p).rejects.toThrow(/connection closed/);
  });

  it('ignores resolve for an unknown requestId', () => {
    const reg = new OrchRpcRegistry();
    expect(() =>
      reg.resolve('nope', { type: 'oidc.mint.response', requestId: 'nope' }),
    ).not.toThrow();
  });

  it('lists oidc.mint.response as a known orch-rpc response type', () => {
    expect(ORCH_RPC_RESPONSE_TYPES.has('oidc.mint.response')).toBe(true);
  });
});
