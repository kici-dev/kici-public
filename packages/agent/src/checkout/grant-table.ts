/**
 * Live write grants for this job.
 *
 * `withWrite` adds a grant before running its callback and revokes it in a
 * `finally`; the TTL is a backstop so a step that crashes cannot leave one
 * standing. The credential helper consults this table to decide whether to ask
 * the broker for a read-only or an elevated credential.
 *
 * Scope note, stated because the name could mislead: a grant is scoped to a
 * REPOSITORY and a TIME WINDOW — not to a step. The agent forks one process per
 * job and `parallel()` runs its children inside that process, so a concurrent
 * sibling step can push to the same repository while a grant is live. It cannot
 * reach a different repository.
 */

import { randomUUID } from 'node:crypto';

export interface WriteGrant {
  /** `owner/repo`, however git spelled it. */
  repoPath: string;
  permissions: Readonly<Record<string, string>>;
  /** Epoch millis after which the grant is dead regardless of revocation. */
  expiresAt: number;
}

/** Git presents paths as `/owner/repo.git`; callers use `owner/repo`. Compare one form. */
function normalise(repoPath: string): string {
  return repoPath
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .toLowerCase();
}

export class GrantTable {
  private readonly grants = new Map<string, WriteGrant>();

  add(grant: WriteGrant): string {
    const id = randomUUID();
    this.grants.set(id, { ...grant, repoPath: normalise(grant.repoPath) });
    return id;
  }

  revoke(grantId: string): void {
    this.grants.delete(grantId);
  }

  lookup(repoPath: string, now: number = Date.now()): WriteGrant | null {
    const wanted = normalise(repoPath);
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= now) {
        this.grants.delete(id);
        continue;
      }
      if (grant.repoPath === wanted) return grant;
    }
    return null;
  }

  /** Live grant count, after reaping expired entries. Test and diagnostics use. */
  size(now: number = Date.now()): number {
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(id);
    }
    return this.grants.size;
  }
}
