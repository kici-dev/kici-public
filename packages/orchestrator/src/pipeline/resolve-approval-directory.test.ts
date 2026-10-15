/**
 * `resolveApprovalDirectory` decides which directory a `/kici approve` comment is
 * authorized against. Precedence: a Platform-pushed in-memory directory is newer
 * than its persisted row, so it wins; every other `ProcessingDeps` assembly must
 * read the row, the only home of an independent orchestrator's registrations.
 *
 * The second block is a registration-seam test: a correct resolver is worthless
 * if `app.ts` never hands it the store.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { resolveApprovalDirectory } from './process-webhook.js';
import type { ProcessingDeps } from './processor.js';
import type { StoredTrustDirectory } from '../security/trust-directory-store.js';

const STORED: StoredTrustDirectory = {
  identityLinks: [
    { userId: 'user-1', provider: 'github', providerUsername: 'alice', providerUserId: '4242' },
  ],
  memberCiTrustLevels: { 'user-1': 'write' },
  teamMemberships: [],
  updatedAt: new Date('2026-08-28T00:00:00Z'),
};

function depsWith(partial: Partial<ProcessingDeps>): ProcessingDeps {
  return partial as unknown as ProcessingDeps;
}

describe('resolveApprovalDirectory', () => {
  it('reads the persisted directory when no in-memory one was supplied', async () => {
    const load = vi.fn().mockResolvedValue(STORED);
    const resolved = await resolveApprovalDirectory(
      depsWith({ trustDirectoryStore: { load } as never }),
      'org-1',
    );
    expect(load).toHaveBeenCalledWith('org-1');
    expect(resolved.identityLinks).toEqual(STORED.identityLinks);
    // The map is what the handler's `ciTrust` check reads; an object would
    // silently answer `none` for every user.
    expect(resolved.orgMemberPermissions.get('user-1')).toBe('write');
  });

  it('prefers an in-memory directory over the persisted row', async () => {
    // The row can be a revision behind `server.ts`'s in-memory copy; reading it
    // would resurrect a member whose CI trust the Platform already revoked.
    const load = vi.fn().mockResolvedValue(STORED);
    const resolved = await resolveApprovalDirectory(
      depsWith({
        identityLinks: [],
        orgMemberPermissions: new Map(),
        trustDirectoryStore: { load } as never,
      }),
      'org-1',
    );
    expect(load).not.toHaveBeenCalled();
    expect(resolved.identityLinks).toEqual([]);
  });

  it('treats either in-memory field alone as an in-memory directory', async () => {
    const load = vi.fn().mockResolvedValue(STORED);
    for (const partial of [{ identityLinks: [] }, { orgMemberPermissions: new Map() }]) {
      await resolveApprovalDirectory(
        depsWith({ ...partial, trustDirectoryStore: { load } as never }),
        'org-1',
      );
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('resolves empty when the org has no stored directory', async () => {
    const resolved = await resolveApprovalDirectory(
      depsWith({ trustDirectoryStore: { load: vi.fn().mockResolvedValue(null) } as never }),
      'org-1',
    );
    expect(resolved.identityLinks).toEqual([]);
    expect(resolved.orgMemberPermissions.size).toBe(0);
  });

  it('resolves empty when no store is wired at all', async () => {
    const resolved = await resolveApprovalDirectory(depsWith({}), 'org-1');
    expect(resolved.identityLinks).toEqual([]);
    expect(resolved.orgMemberPermissions.size).toBe(0);
  });

  it('fails closed on a read error rather than throwing at the caller', async () => {
    // Mid-delivery, a throw aborts the whole webhook; refusing this one command
    // leaves the hold intact and retryable.
    const load = vi.fn().mockRejectedValue(new Error('connection reset'));
    const resolved = await resolveApprovalDirectory(
      depsWith({ trustDirectoryStore: { load } as never }),
      'org-1',
    );
    expect(resolved.identityLinks).toEqual([]);
  });
});

describe('direct-ingress ProcessingDeps assembly', () => {
  const appSource = readFileSync(fileURLToPath(new URL('../app.ts', import.meta.url)), 'utf8');

  it('assembles its bag through the shared factory, not a hand-rolled second copy', () => {
    // `direct-ingress-deps.test.ts` asserts what the bag CONTAINS. It cannot see
    // `app.ts` reverting to an inline literal, leaving the factory correct and
    // unused, so only that seam is asserted here.
    expect(appSource).toMatch(
      /const \{ build: buildProcessingDeps \} =\s*createDirectIngressProcessingDeps\(/,
    );
    expect(appSource).not.toMatch(/const buildProcessingDeps = \(\): ProcessingDeps =>/);
  });
});
