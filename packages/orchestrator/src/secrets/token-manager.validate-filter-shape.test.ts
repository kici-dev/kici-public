/**
 * regression: `TokenManager.validate` MUST filter against `token_hash`
 * AND `revoked = false` AND (`expires_at IS NULL OR expires_at > now()`)
 * on every call. Removing any of these three filters would create:
 *
 *  - Without `revoked = false`: a revoked token would still authenticate
 *    until the row is hard-deleted (revocation becomes a no-op).
 *  - Without the `expires_at` filter: an expired token would still
 *    authenticate (TTL becomes a no-op).
 *  - Without the `token_hash` equality: any random caller would receive
 *    the first row in the table (catastrophic — every request would
 *    appear authenticated as the first-listed token's owner).
 *
 * Trust model (must hold):
 *   For attacker model A1 (external, unauthenticated) and A10 (stolen
 *   credential), the orchestrator's bearer-token validate path is the
 *   sole identity gate. Defense-in-depth requires ALL three filters
 *   apply to ALL validate calls — caching, fast paths, or "quick
 *   checks" that omit any filter widen the attack surface beyond what
 *   the catalog assumes.
 *
 *   The handler returns the same 401 ("Invalid or expired token") for
 *   every failure mode (`admin.ts:151`), so an attacker can't tell
 *   from the response whether the token was unknown, revoked, or
 *   expired — no enumeration oracle.
 */
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { TokenManager } from './token-manager.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

describe('§4.1 TokenManager.validate query-shape invariant', () => {
  it('filters by token_hash, revoked=false, and expires_at on every validate call', async () => {
    const plaintext = 'a'.repeat(64);
    const expectedHash = createHash('sha256').update(plaintext).digest('hex');
    const row = {
      id: 'tok-shape-1',
      token_hash: expectedHash,
      label: 'shape-test',
      role: 'admin',
      routing_key: null,
      created_at: new Date(),
      expires_at: null,
      last_used_at: null,
      revoked: false,
    };

    const { db, mocks } = createMockDb({ selectFirstRow: row });
    const tm = new TokenManager(db as any);

    const result = await tm.validate(plaintext);
    expect(result).not.toBeNull();

    // The validate path's chain:
    //   db.selectFrom('admin_tokens')
    //     .selectAll()
    //     .where('token_hash', '=', tokenHash)
    //     .where('revoked', '=', false)
    //     .where(<expires_at OR predicate>)
    //     .executeTakeFirst()
    //
    // Three .where() calls on the chain. Spy on the terminal's `where`
    // mock to assert all three are present.
    const whereCalls = (mocks.selectWhere as ReturnType<typeof vi.fn>).mock.calls;
    expect(whereCalls.length).toBeGreaterThanOrEqual(3);

    // 1. token_hash equality with the SHA-256 of the plaintext.
    const hashCall = whereCalls.find((c) => c[0] === 'token_hash');
    expect(hashCall).toBeDefined();
    expect(hashCall![1]).toBe('=');
    expect(hashCall![2]).toBe(expectedHash);

    // 2. revoked=false. Without this, revocation becomes a no-op — a
    //    revoked token would still authenticate.
    const revokedCall = whereCalls.find((c) => c[0] === 'revoked');
    expect(revokedCall).toBeDefined();
    expect(revokedCall![1]).toBe('=');
    expect(revokedCall![2]).toBe(false);

    // 3. expires_at filter. Passed as a function (the OR predicate
    //    builder); we just assert one of the .where() calls is a
    //    function (the only call shape that's not a literal triple).
    //    Removing this entire filter would manifest as no
    //    function-shaped where call — the test fails.
    const exprCall = whereCalls.find((c) => typeof c[0] === 'function');
    expect(exprCall).toBeDefined();
  });

  it('always hashes the plaintext before lookup (no plaintext compare)', async () => {
    // Belt-and-suspenders: assert that the where call for token_hash
    // never receives the plaintext directly. If a future refactor
    // accidentally compared plaintext against token_hash, this test
    // would fail loudly (the value would equal the plaintext, not the
    // SHA-256 hash).
    const plaintext = 'b'.repeat(64);
    const expectedHash = createHash('sha256').update(plaintext).digest('hex');
    const { db, mocks } = createMockDb({ selectFirstRow: undefined });
    const tm = new TokenManager(db as any);

    await tm.validate(plaintext);

    const whereCalls = (mocks.selectWhere as ReturnType<typeof vi.fn>).mock.calls;
    const hashCall = whereCalls.find((c) => c[0] === 'token_hash');
    expect(hashCall).toBeDefined();
    expect(hashCall![2]).toBe(expectedHash);
    expect(hashCall![2]).not.toBe(plaintext);
  });
});
