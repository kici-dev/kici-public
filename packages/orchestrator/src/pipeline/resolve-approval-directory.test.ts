/**
 * Unit tests for `resolveApprovalDirectory` — the reader that decides which
 * directory a `/kici approve` comment is authorized against.
 *
 * The precedence it implements is the whole point: a Platform-pushed directory
 * held in memory is newer than the row it was persisted into, so it wins; every
 * other assembly of `ProcessingDeps` has no in-memory directory at all and must
 * read the row, which on an independent orchestrator is the only place the
 * operator's own registrations exist.
 *
 * The second block is a registration-seam test. The resolver being correct is
 * worth nothing if `app.ts` never hands it the store — that omission is exactly
 * the shape of the defect this whole change exists to fix. What the bag
 * CONTAINS is now asserted behaviourally in `direct-ingress-deps.test.ts`,
 * which constructs it and reads the fields; what remains here is the one thing
 * that test cannot see, namely `app.ts` still routing through that factory.
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
    // `server.ts` refreshes its in-memory copy on every push, so the row can be
    // a revision behind. Reading it anyway would resurrect a member whose CI
    // trust the Platform has already revoked.
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
    // The caller is mid-delivery. A thrown read would abort the whole webhook,
    // where refusing this one command leaves the hold intact and retryable.
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
    // What the bag CONTAINS is asserted behaviourally in
    // `direct-ingress-deps.test.ts`, which constructs it and reads the fields.
    // The one thing that test cannot see is `app.ts` quietly reverting to an
    // inline object literal, which would leave the factory correct and unused —
    // the exact shape of the defect this whole change exists to fix. So the
    // seam itself is asserted here, and only the seam.
    expect(appSource).toMatch(
      /const \{ build: buildProcessingDeps \} =\s*createDirectIngressProcessingDeps\(/,
    );
    expect(appSource).not.toMatch(/const buildProcessingDeps = \(\): ProcessingDeps =>/);
  });
});
