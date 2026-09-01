/**
 * Cache of the Platform-owned approval directory.
 *
 * The Platform pushes three documents next to the trust policy on
 * `trust_policy.update`: the org's identity links (an array), each member's CI
 * trust level (a user-id-keyed map), and the operator-defined teams (an array).
 * They feed approval authorization: the `/kici approve` comment handler
 * resolves a commenter to a KiCI user through the identity links and reads that
 * user's CI trust level, and the approval resolver matches a `{team}` clause
 * against the team memberships.
 *
 * Held only in memory, all three are empty after a restart until the next push
 * lands, so a `/kici approve` comment in that window cannot be attributed to
 * anyone and is refused. This store persists them so the directory survives the
 * restart.
 *
 * Wherever a Platform is attached it is the sole writer, exactly as it is for
 * `TrustPolicyStore`'s platform-sourced rows: a push replaces the cached
 * directory wholesale. An independent orchestrator has no Platform and so no
 * upstream authority, which is where `upsertLocalMember` / `removeLocalMember`
 * come in — the operator registers approvers themselves. The two writers never
 * overlap, because the admin route refuses the local write on any
 * Platform-attached orchestrator, so a row still only ever has one writer for
 * the lifetime of a deployment.
 *
 * ## The staleness trade-off
 *
 * Persisting the directory trades a fail-closed default for availability, and
 * the trade runs in both directions.
 *
 * The gain: approvals keep working across a restart instead of being refused
 * until the Platform reconnects.
 *
 * The cost: a restart restores whoever the last push named, so a member whose
 * CI trust the Platform revoked while this orchestrator was down can still
 * approve until the next push overwrites the cache. The Platform sends that
 * push immediately after the orchestrator's WebSocket authenticates, so the
 * window is normally the handshake — but an orchestrator that cannot reach the
 * Platform at all never gets the push, so during a Platform outage the window
 * is unbounded.
 *
 * The cache is deliberately not bounded by a TTL. An expired directory would
 * fail closed exactly when the Platform is unreachable, which is when frozen
 * approvals hurt most, and it would undo the restart-survival this store
 * exists for. `TrustPolicyStore` caches the policy on the same terms.
 * `updated_at` is stored, and read today only to order `loadLastPushed` and to
 * report the cache's age in the boot log line — nothing compares it against a
 * deadline — so a bound can be added later without a migration.
 */
import { Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { type CiTrustLevel, trustPolicyUpdateSchema } from '@kici-dev/engine';
import type { Database } from '../db/types.js';

/**
 * The three directory fields of `trust_policy.update`, taken from the wire
 * schema itself.
 *
 * What that pins: these three field *names*. Rename one upstream or drop it and
 * this schema stops compiling, because the `.shape` lookup no longer resolves.
 * A change *inside* one of them — an element gaining, losing, or retyping a
 * field — compiles fine and propagates through `z.infer`, so the persisted
 * document follows the pushed one automatically rather than by a compile error.
 *
 * What it does not pin: the field *set*. A fourth directory field added to
 * `trustPolicyUpdateSchema` is not picked up here, and `server.ts` hand-builds
 * the value it passes to `upsertFromPlatform`, so nothing would fail — the new
 * field would simply go unpersisted. Adding one means extending this object and
 * that literal together.
 */
export const trustDirectorySchema = z.object({
  identityLinks: trustPolicyUpdateSchema.shape.identityLinks,
  memberCiTrustLevels: trustPolicyUpdateSchema.shape.memberCiTrustLevels,
  teamMemberships: trustPolicyUpdateSchema.shape.teamMemberships,
});
export type TrustDirectory = z.infer<typeof trustDirectorySchema>;

/** A directory as stored, with the write timestamp. */
export interface StoredTrustDirectory extends TrustDirectory {
  updatedAt: Date;
}

/** A stored directory carrying the org id it was written under. */
export interface KeyedTrustDirectory extends StoredTrustDirectory {
  orgId: string;
}

/**
 * A directory with nothing in it — what an org with no stored row starts from.
 *
 * A factory rather than a shared constant: the merge helpers below pass
 * `teamMemberships` through by reference, so a single shared instance would
 * hand every caller the same array and let one of them mutate what the next
 * one reads as empty.
 */
export function emptyTrustDirectory(): TrustDirectory {
  return { identityLinks: [], memberCiTrustLevels: {}, teamMemberships: [] };
}

/**
 * Namespace for the per-org advisory lock taken by the two local writers, so
 * the key cannot collide with another feature's advisory lock in the same
 * database. Distinct from `TrustPolicyStore`'s namespace: the two write
 * different tables and must not serialise against each other.
 */
const LOCAL_WRITE_LOCK_NAMESPACE = 'org-trust-directory-upsert';

/**
 * One member's approval registration, as an operator supplies it on an
 * independent orchestrator.
 *
 * `providerUserId` is REQUIRED here, unlike the nullish field on a pushed link.
 * `findIdentityLink` matches on `(provider, providerUserId)` and never falls
 * back to the mutable username, so a link registered without a numeric id would
 * be inert — accepted, stored, and silently unable to authorize anyone. The
 * caller is made to supply one rather than discover that from a refused
 * approval.
 */
export interface DirectoryMemberRegistration {
  /** KiCI user id the approval is attributed to. */
  userId: string;
  /** Provider the link is for, e.g. `github`. */
  provider: string;
  /** Provider-side username. Display only — never matched on. */
  providerUsername: string;
  /** Immutable provider-side numeric id. The only field a link is matched on. */
  providerUserId: string;
  /** CI trust level to record for `userId`. `write` or `admin` may approve. */
  ciTrust: CiTrustLevel;
}

/**
 * Register one member into a directory, returning a new directory.
 *
 * Two existing links are displaced, not one. The obvious key is
 * `(provider, providerUserId)` — the pair `findIdentityLink` matches on — but
 * `(provider, userId)` has to go too: re-registering a member whose provider
 * account changed would otherwise leave their OLD numeric id in the directory,
 * still resolving to their user id and still carrying their CI trust. Whoever
 * holds that id at the provider now would inherit the ability to approve.
 *
 * `teamMemberships` is passed through untouched — teams are not operator-
 * writable here, and dropping them would silently break every `{team}` clause.
 */
export function applyMemberRegistration(
  current: TrustDirectory,
  registration: DirectoryMemberRegistration,
): TrustDirectory {
  const { userId, provider, providerUsername, providerUserId, ciTrust } = registration;
  const identityLinks = current.identityLinks.filter(
    (link) =>
      link.provider !== provider ||
      (link.providerUserId !== providerUserId && link.userId !== userId),
  );
  identityLinks.push({ userId, provider, providerUsername, providerUserId });
  return {
    identityLinks,
    memberCiTrustLevels: { ...current.memberCiTrustLevels, [userId]: ciTrust },
    teamMemberships: current.teamMemberships,
  };
}

/**
 * Remove one member from a directory, returning a new directory and whether
 * anything was actually removed.
 *
 * The inverse of {@link applyMemberRegistration}: every link the member holds
 * on every provider goes, together with their CI trust level. Leaving the trust
 * level behind would be harmless only until the member is re-registered on a
 * different provider account, at which point the revoked level would silently
 * come back with them.
 */
export function removeMemberFromDirectory(
  current: TrustDirectory,
  userId: string,
): { directory: TrustDirectory; removed: boolean } {
  const identityLinks = current.identityLinks.filter((link) => link.userId !== userId);
  const memberCiTrustLevels = { ...current.memberCiTrustLevels };
  const hadTrust = Object.hasOwn(memberCiTrustLevels, userId);
  delete memberCiTrustLevels[userId];
  return {
    directory: {
      identityLinks,
      memberCiTrustLevels,
      teamMemberships: current.teamMemberships,
    },
    removed: hadTrust || identityLinks.length !== current.identityLinks.length,
  };
}

export class TrustDirectoryStore {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Replace the cached directory for `orgId`.
   *
   * Needs no lock and no read-merge: a push carries all three lists in full, so
   * concurrent pushes correctly settle on the last one — the same reasoning as
   * `TrustPolicyStore.upsertFromPlatform`.
   */
  async upsertFromPlatform(orgId: string, directory: TrustDirectory): Promise<void> {
    await this.write(orgId, directory);
  }

  /**
   * Register (or re-register) one member in an operator-owned directory.
   *
   * Only reachable in independent mode — the admin route refuses on a
   * Platform-attached orchestrator, because the next push replaces the whole
   * document and would clobber the write.
   *
   * The read-merge-write is serialised per org by a transaction-scoped advisory
   * lock, for the same reason `TrustPolicyStore.upsertLocal` takes one: the
   * transaction alone gives nothing under READ COMMITTED, so two concurrent
   * registrations would both read the pre-existing document and the second
   * would overwrite the first's member out of its own stale copy.
   *
   * `onWrite` receives the same transaction and the merged directory, so an
   * audit row written there commits or rolls back with the directory itself — a
   * self-granted `write` level can never land unattributed.
   *
   * Returns the merged directory so the caller does not need a second read
   * (which would be outside the transaction and could observe a later write).
   */
  async upsertLocalMember(
    orgId: string,
    registration: DirectoryMemberRegistration,
    onWrite?: (trx: Transaction<Database>, merged: TrustDirectory) => Promise<void>,
  ): Promise<TrustDirectory> {
    const { merged } = await this.mergeLocally(
      orgId,
      (current) => ({ merged: applyMemberRegistration(current, registration), removed: false }),
      onWrite,
    );
    return merged;
  }

  /**
   * Remove one member from an operator-owned directory. Same mode restriction,
   * locking, and audit contract as {@link upsertLocalMember}.
   *
   * `removed` is false when the member held no link and no CI trust level, so
   * the caller can tell "revoked" from "was never registered" — the row is
   * still rewritten either way, which keeps the operation idempotent. It is
   * handed to `onWrite` as well as returned, because the audit row is written
   * before this method returns and cannot read its own result.
   */
  async removeLocalMember(
    orgId: string,
    userId: string,
    onWrite?: (
      trx: Transaction<Database>,
      merged: TrustDirectory,
      removed: boolean,
    ) => Promise<void>,
  ): Promise<{ directory: TrustDirectory; removed: boolean }> {
    const { merged, removed } = await this.mergeLocally(
      orgId,
      (current) => {
        const result = removeMemberFromDirectory(current, userId);
        return { merged: result.directory, removed: result.removed };
      },
      onWrite,
    );
    return { directory: merged, removed };
  }

  /** Read the cached directory for `orgId`, or null when nothing was ever pushed. */
  async load(orgId: string): Promise<StoredTrustDirectory | null> {
    const row = await this.db
      .selectFrom('org_trust_directory')
      .selectAll()
      .where('customer_id', '=', orgId)
      .executeTakeFirst();
    return row ? parseRow(row) : null;
  }

  /**
   * Read the most recently written cached directory together with the org id it
   * is keyed by.
   *
   * At process start the orchestrator has no org id in hand to call `load()`
   * with: none is configured, and the DB-derived resolution that exists is
   * written inline in `server.ts`'s auth path rather than extracted. The row
   * itself carries one — the org of the last push, which is by construction the
   * org this directory belongs to — so the boot-time seed is keyed by real data
   * instead of a hardcoded or invented id. An
   * orchestrator serves exactly one org, so ordering by `updated_at` is a
   * tiebreak that in practice never has to break a tie; it keeps the read
   * deterministic if a row for a second org is ever present.
   */
  async loadLastPushed(): Promise<KeyedTrustDirectory | null> {
    const row = await this.db
      .selectFrom('org_trust_directory')
      .selectAll()
      .orderBy('updated_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return row ? { orgId: row.customer_id, ...parseRow(row) } : null;
  }

  /**
   * The shared read-merge-write both local writers run: take the per-org
   * advisory lock, read the current document (an absent row reads as
   * {@link emptyTrustDirectory}), apply `merge`, write it back, then invoke
   * `onWrite` inside the same transaction.
   *
   * The lock MUST precede the read: it is what orders this merge against a
   * concurrent one, so taking it after the SELECT would order nothing.
   */
  private async mergeLocally(
    orgId: string,
    merge: (current: TrustDirectory) => { merged: TrustDirectory; removed: boolean },
    onWrite?: (
      trx: Transaction<Database>,
      merged: TrustDirectory,
      removed: boolean,
    ) => Promise<void>,
  ): Promise<{ merged: TrustDirectory; removed: boolean }> {
    return await this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`${LOCAL_WRITE_LOCK_NAMESPACE}|${orgId}`}))`.execute(
        trx,
      );
      const row = await trx
        .selectFrom('org_trust_directory')
        .selectAll()
        .where('customer_id', '=', orgId)
        .executeTakeFirst();
      const current: TrustDirectory = row ? parseRow(row) : emptyTrustDirectory();
      const { merged, removed } = merge(current);
      await this.write(orgId, merged, trx);
      await onWrite?.(trx, merged, removed);
      return { merged, removed };
    });
  }

  /** Replace the whole stored document for `orgId`. */
  private async write(
    orgId: string,
    directory: TrustDirectory,
    executor: Kysely<Database> | Transaction<Database> = this.db,
  ): Promise<void> {
    const columns = {
      identity_links: JSON.stringify(directory.identityLinks),
      member_ci_trust: JSON.stringify(directory.memberCiTrustLevels),
      team_memberships: JSON.stringify(directory.teamMemberships),
      updated_at: sql<Date>`now()`,
    };
    await executor
      .insertInto('org_trust_directory')
      .values({ customer_id: orgId, ...columns })
      .onConflict((oc) => oc.column('customer_id').doUpdateSet(columns))
      .execute();
  }
}

/**
 * Validate one row's three JSONB documents against the wire schema. Throws a
 * `ZodError` on a document that does not match, so a corrupt or hand-edited
 * cache surfaces at the caller rather than silently seeding a partial
 * directory.
 */
function parseRow(row: {
  identity_links: unknown;
  member_ci_trust: unknown;
  team_memberships: unknown;
  updated_at: Date;
}): StoredTrustDirectory {
  const parsed = trustDirectorySchema.parse({
    identityLinks: row.identity_links,
    memberCiTrustLevels: row.member_ci_trust,
    teamMemberships: row.team_memberships,
  });
  return { ...parsed, updatedAt: row.updated_at };
}
