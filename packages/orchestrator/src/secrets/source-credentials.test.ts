/**
 * Tests for the source-scoped credential helper.
 *
 * Exercises the thin glue around SecretResolver.resolveNamed to ensure:
 *   - scope construction uses the canonical `__source__/<sourceId>` prefix.
 *   - not-found results are returned as structured failures (not thrown).
 *   - missing explicit backends surface as `store_missing` failures.
 *   - successful resolutions expose backend provenance for audit downstream.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SecretResolver } from './secret-resolver.js';
import { resolveSourceCredential, sourceCredentialScope } from './source-credentials.js';

function mockResolver(overrides: Partial<SecretResolver>): SecretResolver {
  return overrides as unknown as SecretResolver;
}

describe('sourceCredentialScope', () => {
  it('returns __source__/<sourceId>', () => {
    expect(sourceCredentialScope('abc-123')).toBe('__source__/abc-123');
  });

  it('throws when sourceId is empty', () => {
    expect(() => sourceCredentialScope('')).toThrow();
  });
});

describe('resolveSourceCredential', () => {
  it('delegates to resolveNamed with the canonical scope', async () => {
    const resolveNamed = vi.fn().mockResolvedValue('hunter2');
    const resolver = mockResolver({ resolveNamed });

    const result = await resolveSourceCredential(resolver, 'org-1', 'src-123', {
      key: 'forgejo-pat',
    });

    expect(result).toEqual({ ok: true, value: 'hunter2', backend: 'pg' });
    expect(resolveNamed).toHaveBeenCalledWith(
      'org-1',
      '__source__/src-123',
      'forgejo-pat',
      expect.objectContaining({ store: undefined }),
    );
  });

  it('passes the credentialRef.store through when set', async () => {
    const resolveNamed = vi.fn().mockResolvedValue('vault-value');
    const resolver = mockResolver({ resolveNamed });

    const result = await resolveSourceCredential(resolver, 'org-1', 'src-123', {
      key: 'forgejo-pat',
      store: 'vault-prod',
    });

    expect(result).toEqual({ ok: true, value: 'vault-value', backend: 'vault-prod' });
    expect(resolveNamed).toHaveBeenCalledWith(
      'org-1',
      '__source__/src-123',
      'forgejo-pat',
      expect.objectContaining({ store: 'vault-prod' }),
    );
  });

  it('returns { ok:false, reason:"not_found" } when the key is missing', async () => {
    const resolveNamed = vi.fn().mockResolvedValue(null);
    const resolver = mockResolver({ resolveNamed });

    const result = await resolveSourceCredential(resolver, 'org-1', 'src-123', {
      key: 'missing-key',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
      expect(result.message).toContain('__source__/src-123');
      expect(result.message).toContain('missing-key');
    }
  });

  it('returns { ok:false, reason:"store_missing" } when the explicit backend is not registered', async () => {
    const resolveNamed = vi
      .fn()
      .mockRejectedValue(new Error("Secret backend 'missing-backend' is not registered (...)"));
    const resolver = mockResolver({ resolveNamed });

    const result = await resolveSourceCredential(resolver, 'org-1', 'src-123', {
      key: 'k',
      store: 'missing-backend',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('store_missing');
    }
  });

  it('rethrows unexpected errors that are not backend-missing', async () => {
    const resolveNamed = vi.fn().mockRejectedValue(new Error('unrelated failure'));
    const resolver = mockResolver({ resolveNamed });

    await expect(
      resolveSourceCredential(resolver, 'org-1', 'src-123', { key: 'k' }),
    ).rejects.toThrow(/unrelated failure/);
  });

  it('forwards runId / jobId to resolveNamed for audit correlation', async () => {
    const resolveNamed = vi.fn().mockResolvedValue('v');
    const resolver = mockResolver({ resolveNamed });

    await resolveSourceCredential(
      resolver,
      'org-1',
      'src-123',
      { key: 'k' },
      { runId: 'run-1', jobId: 'job-1' },
    );

    expect(resolveNamed).toHaveBeenCalledWith(
      'org-1',
      '__source__/src-123',
      'k',
      expect.objectContaining({ runId: 'run-1', jobId: 'job-1' }),
    );
  });
});
