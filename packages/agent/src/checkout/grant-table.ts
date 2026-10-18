/**
 * Live write grants for this job.
 *
 * `withWrite` adds a grant before its callback and revokes it in a `finally`;
 * the TTL is a backstop so a crashed step cannot leave one standing. The
 * credential helper consults this table to choose a read-only or an elevated
 * credential from the broker.
 *
 * A grant is scoped to a REPOSITORY and a TIME WINDOW, not to a step. The agent
 * forks one process per job and `parallel()` runs its children inside it, so a
 * concurrent sibling step can push to the same repository while a grant is
 * live, but never to a different one.
 */

import { randomUUID } from 'node:crypto';

export interface WriteGrant {
  /** `owner/repo`, however git spelled it. */
  repoPath: string;
  permissions: Readonly<Record<string, string>>;
  /**
   * The job's `gitCredentials` entry the window named, or undefined for the
   * map's `default`. The credential helper asks the broker for this one.
   */
  credentialName?: string;
  /** Epoch millis; the grant is dead after it, revoked or not. */
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

  /** Reaps expired entries first. For tests and diagnostics. */
  size(now: number = Date.now()): number {
    for (const [id, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(id);
    }
    return this.grants.size;
  }
}
