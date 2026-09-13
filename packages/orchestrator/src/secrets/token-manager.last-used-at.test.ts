import { describe, it, expect, vi } from 'vitest';
import { TokenManager } from './token-manager.js';

/**
 * A Kysely stand-in: the SELECT resolves a live token row, the UPDATE rejects.
 * That is the read-only-replica / lock-timeout / full-disk shape -- the read
 * succeeded and the credential is genuinely valid, so authentication must
 * succeed regardless of the bookkeeping write.
 */
function dbWithFailingTouch(updateRejection: Error) {
  const row = {
    id: 'tok-1',
    role: 'admin',
    routing_key: null,
    label: 'ci',
    token_hash: 'x',
    revoked: false,
    expires_at: null,
  };
  return {
    selectFrom: () => ({
      selectAll: () => ({
        where: function () {
          return this;
        },
        executeTakeFirst: async () => row,
      }),
    }),
    updateTable: () => ({
      set: () => ({
        where: () => ({ execute: () => Promise.reject(updateRejection) }),
      }),
    }),
  } as never;
}

describe('TokenManager.validate -- the last_used_at touch is best-effort', () => {
  it('returns the token info even when the last_used_at update fails', async () => {
    const mgr = new TokenManager(dbWithFailingTouch(new Error('read-only transaction')));

    const info = await mgr.validate('any-token');

    expect(info).toMatchObject({ id: 'tok-1', role: 'admin', routingKey: null, label: 'ci' });
  });

  it('does not surface the touch failure as an unhandled rejection', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const mgr = new TokenManager(dbWithFailingTouch(new Error('lock timeout')));
      await mgr.validate('any-token');
      // Let the microtask queue drain so a missing `.catch()` would surface.
      await new Promise((r) => setTimeout(r, 10));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
