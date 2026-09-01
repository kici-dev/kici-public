import { describe, it, expect, vi } from 'vitest';
import { elevateForWrite, missingPermissions } from './write-elevation.js';
import { GrantTable } from './grant-table.js';

describe('missingPermissions', () => {
  it('finds a requested permission the forge did not grant', () => {
    expect(
      missingPermissions({ contents: 'write', workflows: 'write' }, { contents: 'write' }),
    ).toEqual(['workflows=write']);
  });

  it('treats a downgrade from write to read as missing', () => {
    expect(missingPermissions({ contents: 'write' }, { contents: 'read' })).toEqual([
      'contents=write',
    ]);
  });

  it('is satisfied by an exact match', () => {
    expect(missingPermissions({ contents: 'write' }, { contents: 'write' })).toEqual([]);
  });

  it('ignores extra permissions the forge granted beyond the request', () => {
    expect(
      missingPermissions({ contents: 'write' }, { contents: 'write', issues: 'read' }),
    ).toEqual([]);
  });
});

describe('elevateForWrite', () => {
  it('adds a grant and returns what was granted', async () => {
    const grants = new GrantTable();
    const request = vi.fn().mockResolvedValue({
      grant: { scoped: true, permissions: { contents: 'write' } },
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const result = await elevateForWrite({
      repository: 'kici-dev/tester',
      permissions: { contents: 'write' },
      grants,
      request,
    });

    expect(result.granted).toEqual({ scoped: true, permissions: { contents: 'write' } });
    expect(grants.lookup('kici-dev/tester')).not.toBeNull();
  });

  it('throws at entry naming the missing permission, and adds no grant', async () => {
    const grants = new GrantTable();
    const request = vi.fn().mockResolvedValue({
      grant: { scoped: true, permissions: { contents: 'write' } },
      expiresAt: null,
    });

    await expect(
      elevateForWrite({
        repository: 'kici-dev/tester',
        permissions: { contents: 'write', pull_requests: 'write' },
        grants,
        request,
      }),
    ).rejects.toThrow(/pull_requests=write/);
    expect(grants.size()).toBe(0);
  });

  it('grants unscoped for a static credential without pretending it was narrowed', async () => {
    const grants = new GrantTable();
    const request = vi.fn().mockResolvedValue({ grant: { scoped: false }, expiresAt: null });
    const result = await elevateForWrite({
      repository: 'acme/app',
      permissions: { contents: 'write' },
      grants,
      request,
    });
    // A read-write deploy key cannot be narrowed. Report the truth, do not throw.
    expect(result.granted).toEqual({ scoped: false });
    expect(grants.lookup('acme/app')).not.toBeNull();
  });

  it('falls back to a bounded window when the credential reports no expiry', async () => {
    const grants = new GrantTable();
    const request = vi.fn().mockResolvedValue({ grant: { scoped: false }, expiresAt: null });
    await elevateForWrite({
      repository: 'acme/app',
      permissions: { contents: 'write' },
      grants,
      request,
    });
    // Bounded, not indefinite — a crashed step must not leave a standing grant.
    expect(grants.lookup('acme/app', Date.now() + 61 * 60 * 1000)).toBeNull();
  });

  it('ignores an unparseable expiry rather than making the grant instantly dead', async () => {
    const grants = new GrantTable();
    const request = vi
      .fn()
      .mockResolvedValue({ grant: { scoped: false }, expiresAt: 'not-a-date' });
    await elevateForWrite({
      repository: 'acme/app',
      permissions: { contents: 'write' },
      grants,
      request,
    });
    expect(grants.lookup('acme/app')).not.toBeNull();
  });
});
