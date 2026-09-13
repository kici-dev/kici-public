import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../db/migration-provider.js';
import {
  applyMemberRegistration,
  emptyTrustDirectory,
  removeMemberFromDirectory,
  TrustDirectoryStore,
  type DirectoryMemberRegistration,
  type TrustDirectory,
} from './trust-directory-store.js';
import { findIdentityLink } from './identity-link.js';
import type { Database } from '../db/types.js';

/**
 * Real-Postgres test for TrustDirectoryStore. The store exists so the approval
 * directory SURVIVES a restart, which a mocked query builder cannot show: a
 * fake proves the code called `insertInto`, not that the row reads back.
 * Gated on `KICI_TEST_ADMIN_DATABASE_URL`.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_trustdir_test_${process.pid}_${Date.now()}`;

/** A payload shaped exactly like the three directory fields of `trust_policy.update`. */
const DIRECTORY: TrustDirectory = {
  identityLinks: [
    { userId: 'user-1', provider: 'github', providerUsername: 'octocat', providerUserId: '583231' },
    { userId: 'user-2', provider: 'github', providerUsername: 'hubot', providerUserId: '1234567' },
  ],
  memberCiTrustLevels: { 'user-1': 'admin', 'user-2': 'read' },
  teamMemberships: [
    { teamName: 'sre', memberUserIds: ['user-1'] },
    { teamName: 'reviewers', memberUserIds: ['user-1', 'user-2'] },
  ],
};

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/**
 * The operator-supplied merge, unit-tested without a database.
 *
 * These are the halves of the independent-mode write path that decide WHAT is
 * stored; `upsertLocalMember` / `removeLocalMember` only add the lock, the
 * transaction, and the audit hook around them. Pure functions, so they run in
 * every `pnpm test` rather than only where a Postgres is reachable — which is
 * the layer the DB-gated suite below cannot cover on its own.
 */
describe('directory merge helpers', () => {
  const ALICE: DirectoryMemberRegistration = {
    userId: 'user-1',
    provider: 'github',
    providerUsername: 'alice',
    providerUserId: '4242',
    ciTrust: 'write',
  };

  it('registers a member into an empty directory', () => {
    const merged = applyMemberRegistration(emptyTrustDirectory(), ALICE);
    expect(merged.identityLinks).toEqual([
      { userId: 'user-1', provider: 'github', providerUsername: 'alice', providerUserId: '4242' },
    ]);
    expect(merged.memberCiTrustLevels).toEqual({ 'user-1': 'write' });
  });

  it('produces a link `findIdentityLink` actually matches', () => {
    // The point of the whole write path: a registered member has to resolve
    // through the same numeric-id-only matcher `/kici approve` uses. A merge
    // that stored a shape the matcher refuses would be silently inert.
    const merged = applyMemberRegistration(emptyTrustDirectory(), ALICE);
    expect(findIdentityLink(merged.identityLinks, 'github', 'alice', '4242')?.userId).toBe(
      'user-1',
    );
    // …and it stays refused when the event carries no numeric id, which is the
    // security property the matcher exists for.
    expect(findIdentityLink(merged.identityLinks, 'github', 'alice', undefined)).toBeNull();
  });

  it('does not mutate the directory it was handed', () => {
    const before = emptyTrustDirectory();
    applyMemberRegistration(before, ALICE);
    expect(before).toEqual(emptyTrustDirectory());
  });

  it('preserves team memberships, which are not operator-writable here', () => {
    const current: TrustDirectory = {
      identityLinks: [],
      memberCiTrustLevels: {},
      teamMemberships: [{ teamName: 'sre', memberUserIds: ['user-9'] }],
    };
    expect(applyMemberRegistration(current, ALICE).teamMemberships).toEqual(
      current.teamMemberships,
    );
    expect(removeMemberFromDirectory(current, 'user-9').directory.teamMemberships).toEqual(
      current.teamMemberships,
    );
  });

  it('replaces a re-registered member rather than accumulating links', () => {
    const once = applyMemberRegistration(emptyTrustDirectory(), ALICE);
    const twice = applyMemberRegistration(once, { ...ALICE, ciTrust: 'admin' });
    expect(twice.identityLinks).toHaveLength(1);
    expect(twice.memberCiTrustLevels).toEqual({ 'user-1': 'admin' });
  });

  it('drops the stale numeric id when a member re-registers a new provider account', () => {
    // The dangerous case. Keying only on (provider, providerUserId) would leave
    // id 4242 in the directory, still resolving to user-1 and still carrying
    // their CI trust — so whoever holds 4242 at the provider now could approve.
    const once = applyMemberRegistration(emptyTrustDirectory(), ALICE);
    const moved = applyMemberRegistration(once, {
      ...ALICE,
      providerUsername: 'alice-new',
      providerUserId: '9999',
    });
    expect(moved.identityLinks).toEqual([
      {
        userId: 'user-1',
        provider: 'github',
        providerUsername: 'alice-new',
        providerUserId: '9999',
      },
    ]);
    expect(findIdentityLink(moved.identityLinks, 'github', 'alice', '4242')).toBeNull();
  });

  it('displaces whoever else held the numeric id being registered', () => {
    // The mirror of the case above: two links sharing (provider, providerUserId)
    // would make `findIdentityLink` resolve one arbitrarily.
    const first = applyMemberRegistration(emptyTrustDirectory(), ALICE);
    const stolen = applyMemberRegistration(first, {
      ...ALICE,
      userId: 'user-2',
      providerUsername: 'bob',
    });
    expect(stolen.identityLinks).toEqual([
      { userId: 'user-2', provider: 'github', providerUsername: 'bob', providerUserId: '4242' },
    ]);
    // user-1's CI trust level survives — only their LINK was displaced, and a
    // level with no link authorizes nobody.
    expect(stolen.memberCiTrustLevels).toEqual({ 'user-1': 'write', 'user-2': 'write' });
  });

  it('leaves a same-id link on another provider alone', () => {
    const withGithub = applyMemberRegistration(emptyTrustDirectory(), ALICE);
    const withGitlab = applyMemberRegistration(withGithub, { ...ALICE, provider: 'gitlab' });
    expect(withGitlab.identityLinks).toHaveLength(2);
    expect(withGitlab.identityLinks.map((l) => l.provider)).toEqual(['github', 'gitlab']);
  });

  it('removes every link a member holds, and their CI trust level', () => {
    let dir = applyMemberRegistration(emptyTrustDirectory(), ALICE);
    dir = applyMemberRegistration(dir, { ...ALICE, provider: 'gitlab', providerUserId: '77' });
    dir = applyMemberRegistration(dir, { ...ALICE, userId: 'user-2', providerUserId: '55' });

    const { directory, removed } = removeMemberFromDirectory(dir, 'user-1');
    expect(removed).toBe(true);
    expect(directory.identityLinks.map((l) => l.userId)).toEqual(['user-2']);
    expect(directory.memberCiTrustLevels).toEqual({ 'user-2': 'write' });
  });

  it('reports removed:false for a member that was never registered', () => {
    const { directory, removed } = removeMemberFromDirectory(emptyTrustDirectory(), 'nobody');
    expect(removed).toBe(false);
    expect(directory).toEqual(emptyTrustDirectory());
  });

  it('reports removed:true for a member holding only a CI trust level', () => {
    // A level with no link cannot authorize anyone, but it is still state the
    // operator asked to revoke — reporting "was never registered" would be a lie.
    const { removed } = removeMemberFromDirectory(
      { ...emptyTrustDirectory(), memberCiTrustLevels: { 'user-1': 'admin' } },
      'user-1',
    );
    expect(removed).toBe(true);
  });

  it('hands back a fresh empty directory each call', () => {
    const a = emptyTrustDirectory();
    a.teamMemberships.push({ teamName: 'leaked', memberUserIds: [] });
    expect(emptyTrustDirectory().teamMemberships).toEqual([]);
  });
});

describeDb('TrustDirectoryStore', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  let store: TrustDirectoryStore;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const migrator = new Migrator({ db, provider: createMigrationProvider() });
    const { error } = await migrator.migrateToLatest();
    if (error) throw error;
    store = new TrustDirectoryStore(db);
  }, 120_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const adminPool = new pg.Pool({ connectionString: adminUrl });
    try {
      await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await adminPool.end();
    }
  }, 60_000);

  beforeEach(async () => {
    await sql`DELETE FROM org_trust_directory`.execute(db);
  });

  it('returns null when nothing was ever pushed for the org', async () => {
    expect(await store.load('org-absent')).toBeNull();
  });

  it('round-trips a pushed directory', async () => {
    await store.upsertFromPlatform('org-1', DIRECTORY);
    const stored = await store.load('org-1');
    expect(stored).not.toBeNull();
    expect(stored!.identityLinks).toEqual(DIRECTORY.identityLinks);
    expect(stored!.memberCiTrustLevels).toEqual(DIRECTORY.memberCiTrustLevels);
    expect(stored!.teamMemberships).toEqual(DIRECTORY.teamMemberships);
    expect(stored!.updatedAt).toBeInstanceOf(Date);
  });

  it('keeps an empty directory distinguishable from an absent one', async () => {
    await store.upsertFromPlatform('org-empty', {
      identityLinks: [],
      memberCiTrustLevels: {},
      teamMemberships: [],
    });
    const stored = await store.load('org-empty');
    expect(stored).not.toBeNull();
    expect(stored!.identityLinks).toEqual([]);
    expect(stored!.memberCiTrustLevels).toEqual({});
    expect(stored!.teamMemberships).toEqual([]);
  });

  it('replaces the whole directory on a second push, mirroring the in-memory assignment', async () => {
    await store.upsertFromPlatform('org-1', DIRECTORY);
    const replacement: TrustDirectory = {
      identityLinks: [
        { userId: 'user-3', provider: 'github', providerUsername: 'newbie', providerUserId: '99' },
      ],
      memberCiTrustLevels: { 'user-3': 'write' },
      teamMemberships: [{ teamName: 'sre', memberUserIds: ['user-3'] }],
    };
    await store.upsertFromPlatform('org-1', replacement);

    const stored = await store.load('org-1');
    // Wholesale replacement, not a merge: the revoked user-1 / user-2 entries
    // are gone rather than lingering as still-trusted approvers.
    expect(stored!.identityLinks).toEqual(replacement.identityLinks);
    expect(stored!.memberCiTrustLevels).toEqual(replacement.memberCiTrustLevels);
    expect(stored!.teamMemberships).toEqual(replacement.teamMemberships);

    const rows = await db.selectFrom('org_trust_directory').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('carries a nullish providerUserId through unchanged', async () => {
    await store.upsertFromPlatform('org-null-id', {
      identityLinks: [
        { userId: 'user-9', provider: 'github', providerUsername: 'legacy', providerUserId: null },
      ],
      memberCiTrustLevels: {},
      teamMemberships: [],
    });
    const stored = await store.load('org-null-id');
    expect(stored!.identityLinks[0]?.providerUserId).toBeNull();
  });

  describe('loadLastPushed', () => {
    it('returns null when no directory was ever pushed', async () => {
      expect(await store.loadLastPushed()).toBeNull();
    });

    it('returns the cached directory together with the org id it is keyed by', async () => {
      await store.upsertFromPlatform('org-boot', DIRECTORY);
      const cached = await store.loadLastPushed();
      expect(cached?.orgId).toBe('org-boot');
      expect(cached?.identityLinks).toEqual(DIRECTORY.identityLinks);
      expect(cached?.memberCiTrustLevels).toEqual(DIRECTORY.memberCiTrustLevels);
      expect(cached?.teamMemberships).toEqual(DIRECTORY.teamMemberships);
    });

    it('prefers the most recently written row', async () => {
      await store.upsertFromPlatform('org-old', DIRECTORY);
      await sql`UPDATE org_trust_directory SET updated_at = now() - interval '1 hour'`.execute(db);
      await store.upsertFromPlatform('org-new', DIRECTORY);
      expect((await store.loadLastPushed())?.orgId).toBe('org-new');
    });
  });

  describe('local (independent-mode) writers', () => {
    const ALICE: DirectoryMemberRegistration = {
      userId: 'user-1',
      provider: 'github',
      providerUsername: 'alice',
      providerUserId: '4242',
      ciTrust: 'write',
    };

    it('creates the row when the org has none, and reads it back', async () => {
      await store.upsertLocalMember('org-ind', ALICE);
      const stored = await store.load('org-ind');
      expect(stored!.identityLinks).toEqual([
        { userId: 'user-1', provider: 'github', providerUsername: 'alice', providerUserId: '4242' },
      ]);
      expect(stored!.memberCiTrustLevels).toEqual({ 'user-1': 'write' });
      expect(stored!.teamMemberships).toEqual([]);
    });

    it('merges into an existing row instead of replacing it', async () => {
      await store.upsertFromPlatform('org-ind', DIRECTORY);
      await store.upsertLocalMember('org-ind', {
        ...ALICE,
        userId: 'user-3',
        providerUserId: '99',
      });
      const stored = await store.load('org-ind');
      // The pushed members survive — a local write is a merge, unlike a push.
      expect(stored!.identityLinks).toHaveLength(3);
      expect(stored!.memberCiTrustLevels).toEqual({
        'user-1': 'admin',
        'user-2': 'read',
        'user-3': 'write',
      });
      expect(stored!.teamMemberships).toEqual(DIRECTORY.teamMemberships);
    });

    it('runs onWrite inside the same transaction as the directory row', async () => {
      await expect(
        store.upsertLocalMember('org-rollback', ALICE, async () => {
          throw new Error('audit write failed');
        }),
      ).rejects.toThrow('audit write failed');
      // The registration must NOT have landed: a member granted approval rights
      // with no audit row is exactly what the shared transaction prevents.
      expect(await store.load('org-rollback')).toBeNull();
    });

    it('hands onWrite the directory transaction, not the pool', async () => {
      // The rollback test above passes either way: a throw from `onWrite` aborts
      // the transaction whichever executor it was handed. What it cannot see is
      // an audit row written through the POOL, which commits on its own and
      // survives that rollback — a recorded grant for a registration that never
      // landed. Writing a probe row through the executor and asserting it went
      // with the rollback is what pins the identity.
      const PROBE = 'org-trx-probe';
      await expect(
        store.upsertLocalMember('org-trx', ALICE, async (trx) => {
          await trx
            .insertInto('org_trust_directory')
            .values({
              customer_id: PROBE,
              identity_links: '[]',
              member_ci_trust: '{}',
              team_memberships: '[]',
            })
            .execute();
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await store.load('org-trx')).toBeNull();
      expect(await store.load(PROBE)).toBeNull();
    });

    it('removes a member and reports whether anything went', async () => {
      await store.upsertLocalMember('org-ind', ALICE);
      const first = await store.removeLocalMember('org-ind', 'user-1');
      expect(first.removed).toBe(true);
      expect((await store.load('org-ind'))!.identityLinks).toEqual([]);

      const second = await store.removeLocalMember('org-ind', 'user-1');
      expect(second.removed).toBe(false);
    });

    /**
     * Wait until some other backend on this database is blocked on a lock.
     *
     * Both the locked and the unlocked build end up blocked here, and that is
     * the point: it is what makes the interleaving deterministic instead of
     * timing-dependent. Under the advisory lock the second registration blocks
     * BEFORE its read; without it, the lock it blocks on is the row lock at
     * INSERT — which it reaches only after its read has already returned the
     * pre-existing document, and that stale read is what loses the first write.
     *
     * Returns false rather than throwing, so the caller asserts on it outside
     * the transaction instead of rolling it back from inside `onWrite`.
     */
    async function waitForBlockedBackend(): Promise<boolean> {
      for (let attempt = 0; attempt < 100; attempt++) {
        const res = await sql<{ n: string }>`
          SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
        `.execute(db);
        if (Number(res.rows[0]?.n ?? '0') > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    }

    it('serialises a concurrent registration rather than losing one', async () => {
      // Driven from inside the first transaction, while it still holds the
      // lock, so the two writers genuinely overlap. A bare `Promise.all` does
      // not establish that — it passes against a build with no lock at all.
      const BOB = { ...ALICE, userId: 'user-2', providerUsername: 'bob', providerUserId: '7777' };
      let second: Promise<unknown> | undefined;
      let blocked = false;

      await store.upsertLocalMember('org-race', ALICE, async () => {
        second = store.upsertLocalMember('org-race', BOB);
        // Handled here only so a rejection during the poll window is not an
        // unhandled rejection; the original promise is still awaited below.
        second.catch(() => undefined);
        blocked = await waitForBlockedBackend();
      });
      await second;

      expect(blocked, 'the second registration never blocked — the race was not exercised').toBe(
        true,
      );
      const stored = await store.load('org-race');
      expect(stored!.identityLinks).toHaveLength(2);
      expect(Object.keys(stored!.memberCiTrustLevels).sort()).toEqual(['user-1', 'user-2']);
    });
  });

  it('rejects a stored document that does not match the pushed shape', async () => {
    await sql`
      INSERT INTO org_trust_directory
        (customer_id, identity_links, member_ci_trust, team_memberships)
      VALUES ('org-corrupt', '"not-an-array"'::jsonb, '{}'::jsonb, '[]'::jsonb)
    `.execute(db);
    await expect(store.load('org-corrupt')).rejects.toThrow();
  });
});
