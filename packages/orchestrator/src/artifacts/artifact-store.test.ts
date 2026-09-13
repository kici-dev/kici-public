import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import type { CacheStorage, CacheMetadata } from '../storage/types.js';
import { ARTIFACT_NAME_MAX_LENGTH, ArtifactNameSchema, checkArtifactName } from '@kici-dev/engine';
import {
  ArtifactStore,
  ArtifactInvalidNameError,
  ArtifactObjectMissingError,
  artifactStorageKey,
  classifyArtifactCommitFailure,
} from './artifact-store.js';
import { ARTIFACT_INVALID_NAME_PREFIX, ArtifactInternalFailure } from './failure-messages.js';

const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_artstore_test_${process.pid}_${Date.now()}`;

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/** Presigned-GET signature TTL the fake storage backend reports (seconds). */
const FAKE_PRESIGN_TTL_SECONDS = 900;

/** Quote a literal artifact name for embedding in a key-shape regex. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Minimal in-memory CacheStorage: only the methods ArtifactStore touches. It
 * models per-key object sizes so `completeUpload`'s server-side stat has
 * something to read; `setObjectSize` simulates the agent's presigned PUT
 * landing an object of a known size.
 */
function fakeStorage(): CacheStorage & { setObjectSize(key: string, size: number): void } {
  const meta = new Map<string, CacheMetadata>();
  const sizes = new Map<string, number>();
  return {
    getObjectSize: async (k) => sizes.get(k) ?? null,
    setObjectSize(key: string, size: number) {
      sizes.set(key, size);
    },
    put: async () => {},
    get: async () => null,
    has: async (k) => meta.has(k),
    delete: async (k) => {
      sizes.delete(k);
      return meta.delete(k);
    },
    touch: async () => {},
    getUrl: async (k) => (meta.has(k) ? `https://s3/get/${k}` : null),
    presignedGetTtlSeconds: () => FAKE_PRESIGN_TTL_SECONDS,
    getUploadUrl: async (k) => `https://s3/put/${k}`,
    getInternalUploadUrl: async (k) => `https://s3/put/${k}`,
    initMeta: async (k) => {
      meta.set(k, {
        createdAt: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
    },
    list: async () => [],
    copy: async () => {},
    getMetadata: async (k) => meta.get(k) ?? null,
  };
}

describeDb('ArtifactStore', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  const adminUrl = ADMIN_URL!;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`CREATE DATABASE "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
    pool = new pg.Pool({ connectionString: withDatabase(adminUrl, TEST_DB) });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const { error } = await new Migrator({
      db,
      provider: createMigrationProvider(),
    }).migrateToLatest();
    if (error) throw error;
  }, 60_000);

  afterAll(async () => {
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  beforeEach(async () => {
    await db.deleteFrom('artifacts').execute();
  });

  /**
   * Build a store over a fresh in-memory storage fake, handing both back: tests
   * seed the fake with the object the agent's presigned PUT "landed" so the
   * server-side size stat in `completeUpload` has something to read.
   */
  function store(over: Partial<ConstructorParameters<typeof ArtifactStore>[0]> = {}): {
    s: ArtifactStore;
    storage: ReturnType<typeof fakeStorage>;
  } {
    const storage = fakeStorage();
    return {
      s: new ArtifactStore({
        db,
        quotaBytes: 1000,
        ttlMs: 60_000,
        maxBytes: 500,
        maxPerRun: 3,
        ...over,
        storage,
      }),
      storage,
    };
  }

  it('grants an upload, writes a row on complete, and resolves the download', async () => {
    const { s, storage } = store();
    const grant = await s.beginUpload({
      customerId: 'org1',
      runId: 'run1',
      name: 'bundle',
      declaredSizeBytes: 100,
    });
    expect(grant.outcome).toBe('granted');
    expect(grant.storageKey).toBe(artifactStorageKey('run1', 'bundle'));
    expect(grant.uploadUrl).toContain('put');

    storage.setObjectSize(artifactStorageKey('run1', 'bundle'), 100); // the agent's PUT landed
    await s.completeUpload({
      customerId: 'org1',
      runId: 'run1',
      jobId: 'job1',
      name: 'bundle',
      sizeBytes: 100,
      sha256: 'abc',
      storageKey: grant.storageKey!,
    });

    const dl = await s.download({ customerId: 'org1', runId: 'run1', name: 'bundle' });
    expect(dl.outcome).toBe('found');
    expect(dl.sizeBytes).toBe(100);
    expect(dl.sha256).toBe('abc');
    expect(dl.downloadUrl).toContain('get');

    // The dashboard listing mints one presigned GET per row and reports the
    // backend's presigned-URL signature TTL (seconds) so the dashboard can
    // refresh a rendered link before its signature expires.
    const withUrls = await s.listForRunWithUrls('org1', 'run1');
    expect(withUrls.artifacts).toHaveLength(1);
    expect(withUrls.artifacts[0]).toMatchObject({ name: 'bundle', jobId: 'job1', sizeBytes: 100 });
    expect(withUrls.artifacts[0].downloadUrl).toContain('get');
    expect(withUrls.downloadUrlExpiresInSeconds).toBe(FAKE_PRESIGN_TTL_SECONDS);
  });

  it('reports the backend presigned-URL TTL, independent of the retention ttlMs', async () => {
    // A long retention TTL must NOT be reported as the download-URL expiry — the
    // presigned signature dies far sooner (this is the bug the field fixes).
    const { s } = store({ ttlMs: 30 * 24 * 60 * 60 * 1000 });
    const res = await s.listForRunWithUrls('org1', 'run-empty');
    expect(res.artifacts).toBeInstanceOf(Array);
    expect(res.downloadUrlExpiresInSeconds).toBe(FAKE_PRESIGN_TTL_SECONDS);
  });

  it('rejects a duplicate name (pre-mint) and the DB constraint backstops a race', async () => {
    const { s, storage } = store();
    const g = await s.beginUpload({
      customerId: 'o',
      runId: 'r',
      name: 'n',
      declaredSizeBytes: 10,
    });
    storage.setObjectSize(artifactStorageKey('r', 'n'), 10);
    await s.completeUpload({
      customerId: 'o',
      runId: 'r',
      jobId: 'j',
      name: 'n',
      sizeBytes: 10,
      sha256: 'h',
      storageKey: g.storageKey!,
    });
    const dup = await s.beginUpload({
      customerId: 'o',
      runId: 'r',
      name: 'n',
      declaredSizeBytes: 10,
    });
    expect(dup.outcome).toBe('rejected');
    expect(dup.reason).toBe('duplicate_name');

    // The DB UNIQUE(run_id,name) backstops a completeUpload that raced past the
    // pre-mint check: onConflict-do-nothing keeps the first row immutable.
    await s.completeUpload({
      customerId: 'o',
      runId: 'r',
      jobId: 'j2',
      name: 'n',
      sizeBytes: 999,
      sha256: 'h2',
      storageKey: g.storageKey!,
    });
    const dl = await s.download({ customerId: 'o', runId: 'r', name: 'n' });
    expect(dl.sizeBytes).toBe(10); // first write wins
  });

  it('rejects over the per-artifact size cap', async () => {
    const { s } = store();
    const r = await s.beginUpload({
      customerId: 'o',
      runId: 'r',
      name: 'big',
      declaredSizeBytes: 600,
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('size_cap');
  });

  it('rejects over the per-run count cap', async () => {
    const { s, storage } = store({ maxPerRun: 2 });
    for (const name of ['a', 'b']) {
      const g = await s.beginUpload({ customerId: 'o', runId: 'r', name, declaredSizeBytes: 10 });
      storage.setObjectSize(g.storageKey!, 10);
      await s.completeUpload({
        customerId: 'o',
        runId: 'r',
        jobId: 'j',
        name,
        sizeBytes: 10,
        sha256: 'h',
        storageKey: g.storageKey!,
      });
    }
    const r = await s.beginUpload({
      customerId: 'o',
      runId: 'r',
      name: 'c',
      declaredSizeBytes: 10,
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('run_cap');
  });

  it('rejects over the per-org quota', async () => {
    const { s, storage } = store({ quotaBytes: 150, maxBytes: 1000 });
    const g = await s.beginUpload({
      customerId: 'o',
      runId: 'r1',
      name: 'a',
      declaredSizeBytes: 100,
    });
    storage.setObjectSize(g.storageKey!, 100);
    await s.completeUpload({
      customerId: 'o',
      runId: 'r1',
      jobId: 'j',
      name: 'a',
      sizeBytes: 100,
      sha256: 'h',
      storageKey: g.storageKey!,
    });
    // A second upload (even in a different run of the same org) that would push
    // the org total past the quota is rejected.
    const r = await s.beginUpload({
      customerId: 'o',
      runId: 'r2',
      name: 'b',
      declaredSizeBytes: 100,
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('org_quota');
  });

  it('treats an expired artifact as not_found and excludes it from quota', async () => {
    const { s, storage } = store({ ttlMs: 1 }); // 1 ms TTL — rows expire almost immediately
    const g = await s.beginUpload({
      customerId: 'o',
      runId: 'r',
      name: 'n',
      declaredSizeBytes: 10,
    });
    storage.setObjectSize(g.storageKey!, 10);
    await s.completeUpload({
      customerId: 'o',
      runId: 'r',
      jobId: 'j',
      name: 'n',
      sizeBytes: 10,
      sha256: 'h',
      storageKey: g.storageKey!,
    });
    await new Promise((res) => setTimeout(res, 10));
    const dl = await s.download({ customerId: 'o', runId: 'r', name: 'n' });
    expect(dl.outcome).toBe('not_found');
  });

  it('applies a per-org override quota via the orgLimitsReader', async () => {
    const { s } = store({
      quotaBytes: 1000,
      orgLimitsReader: async (org) => (org === 'tiny' ? { quotaBytes: 50 } : {}),
    });
    const r = await s.beginUpload({
      customerId: 'tiny',
      runId: 'r',
      name: 'n',
      declaredSizeBytes: 100,
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('org_quota');
  });

  it('honors a per-org maxBytes override below the cluster default', async () => {
    // Cluster default 500 would admit a 200-byte artifact; the per-org 100 cap
    // rejects it at size_cap.
    const { s } = store({
      maxBytes: 500,
      orgLimitsReader: async (org) => (org === 'tiny' ? { maxBytes: 100 } : {}),
    });
    const r = await s.beginUpload({
      customerId: 'tiny',
      runId: 'r',
      name: 'a',
      declaredSizeBytes: 200,
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('size_cap');
  });

  it('honors a per-org maxBytes override above the cluster default', async () => {
    // Cluster default 100 would reject a 200-byte artifact; the per-org 1000 cap
    // admits it past the cluster default.
    const { s } = store({
      maxBytes: 100,
      quotaBytes: 100_000,
      orgLimitsReader: async (org) => (org === 'big' ? { maxBytes: 1000 } : {}),
    });
    const r = await s.beginUpload({
      customerId: 'big',
      runId: 'r',
      name: 'a',
      declaredSizeBytes: 200,
    });
    expect(r.outcome).toBe('granted');
  });

  it('falls back to the cluster maxBytes when the org override is unset', async () => {
    const { s } = store({
      maxBytes: 150,
      orgLimitsReader: async () => ({}), // no maxBytes → cluster default 150 applies
    });
    const r = await s.beginUpload({
      customerId: 'o',
      runId: 'r',
      name: 'a',
      declaredSizeBytes: 200,
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('size_cap');
  });

  it('honors a per-org maxPerRun override below the cluster default', async () => {
    const { s, storage } = store({
      maxPerRun: 50,
      orgLimitsReader: async (org) => (org === 'tiny' ? { maxPerRun: 1 } : {}),
    });
    const g = await s.beginUpload({
      customerId: 'tiny',
      runId: 'r',
      name: 'a',
      declaredSizeBytes: 10,
    });
    storage.setObjectSize(g.storageKey!, 10);
    await s.completeUpload({
      customerId: 'tiny',
      runId: 'r',
      jobId: 'j',
      name: 'a',
      sizeBytes: 10,
      sha256: 'h',
      storageKey: g.storageKey!,
    });
    const r = await s.beginUpload({
      customerId: 'tiny',
      runId: 'r',
      name: 'b',
      declaredSizeBytes: 10,
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('run_cap');
  });

  it('falls back to the cluster maxPerRun when the org override is unset', async () => {
    // Cluster default 1; reader returns no maxPerRun → the cluster cap applies.
    const { s, storage } = store({ maxPerRun: 1, orgLimitsReader: async () => ({}) });
    const g = await s.beginUpload({
      customerId: 'o',
      runId: 'r',
      name: 'a',
      declaredSizeBytes: 10,
    });
    storage.setObjectSize(g.storageKey!, 10);
    await s.completeUpload({
      customerId: 'o',
      runId: 'r',
      jobId: 'j',
      name: 'a',
      sizeBytes: 10,
      sha256: 'h',
      storageKey: g.storageKey!,
    });
    const r = await s.beginUpload({
      customerId: 'o',
      runId: 'r',
      name: 'b',
      declaredSizeBytes: 10,
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('run_cap');
  });

  it('falls back to cluster caps when the orgLimitsReader throws', async () => {
    // A throwing reader must not weaken enforcement: the cluster size cap holds.
    const { s } = store({
      maxBytes: 150,
      orgLimitsReader: async () => {
        throw new Error('org-settings lookup boom');
      },
    });
    const r = await s.beginUpload({
      customerId: 'o',
      runId: 'r',
      name: 'a',
      declaredSizeBytes: 200,
    });
    expect(r.outcome).toBe('rejected');
    expect(r.reason).toBe('size_cap');
  });

  it('ignores a foreign wire storageKey and commits with the server-derived key', async () => {
    const { s, storage } = store();
    await s.beginUpload({
      customerId: 'org1',
      runId: 'run1',
      name: 'bundle',
      declaredSizeBytes: 50,
    });
    storage.setObjectSize(artifactStorageKey('run1', 'bundle'), 50); // the honest object

    // A compromised agent echoes a key pointing at ANOTHER run's object. The
    // server derives the key from its own runId + name, so the row can never
    // reference an object outside this run's artifacts prefix.
    await s.completeUpload({
      customerId: 'org1',
      runId: 'run1',
      jobId: 'job1',
      name: 'bundle',
      sizeBytes: 50,
      sha256: 'abc',
      storageKey: 'artifacts/other-run/victim.tar.gz',
    });

    const row = await db
      .selectFrom('artifacts')
      .select(['storage_key', 'size_bytes'])
      .where('run_id', '=', 'run1')
      .where('name', '=', 'bundle')
      .executeTakeFirst();
    expect(row?.storage_key).toBe(artifactStorageKey('run1', 'bundle'));
    expect(Number(row?.size_bytes)).toBe(50);
  });

  it('still resolves an artifact stored under an earlier key format', async () => {
    // The claim the whole key-format change rests on: download reads
    // `row.storage_key` and never re-derives, so a row written before the key
    // carried a name discriminator keeps resolving to its own object.
    const { s, storage } = store();
    const legacyKey = 'artifacts/run1/legacy.tar.gz';
    storage.setObjectSize(legacyKey, 100);
    await storage.initMeta(legacyKey);
    await db
      .insertInto('artifacts')
      .values({
        id: 'legacy-artifact-row',
        customer_id: 'org1',
        run_id: 'run1',
        job_id: 'job1',
        name: 'legacy',
        size_bytes: 100,
        sha256: 'abc',
        storage_key: legacyKey,
      })
      .execute();

    const dl = await s.download({ customerId: 'org1', runId: 'run1', name: 'legacy' });
    expect(dl.outcome).toBe('found');
    expect(dl.downloadUrl).toContain(legacyKey);
    // ...and the row is genuinely on the old format, so this is not a tautology.
    expect(artifactStorageKey('run1', 'legacy')).not.toBe(legacyKey);
  });

  it('records the true stat-verified size, not the agent-declared sizeBytes', async () => {
    const { s, storage } = store({ quotaBytes: 100_000, maxBytes: 100_000 });
    await s.beginUpload({
      customerId: 'org1',
      runId: 'run1',
      name: 'bundle',
      declaredSizeBytes: 1,
    });
    storage.setObjectSize(artifactStorageKey('run1', 'bundle'), 4096); // declared 1, uploaded 4096

    await s.completeUpload({
      customerId: 'org1',
      runId: 'run1',
      jobId: 'job1',
      name: 'bundle',
      sizeBytes: 1,
      sha256: 'abc',
      storageKey: 'artifacts/run1/bundle.tar.gz',
    });

    // The real size is what the org-quota sum and the dashboard see.
    const dl = await s.download({ customerId: 'org1', runId: 'run1', name: 'bundle' });
    expect(dl.sizeBytes).toBe(4096);
  });

  it('throws and skips the insert when the uploaded object is missing', async () => {
    const { s } = store();
    await s.beginUpload({
      customerId: 'org1',
      runId: 'run1',
      name: 'bundle',
      declaredSizeBytes: 10,
    });
    // No setObjectSize — the presigned PUT never landed an object.

    // The failure must surface to the caller (which acks `failed` back to the
    // agent) instead of being swallowed — a silently-dropped commit is a green
    // run with no artifact.
    await expect(
      s.completeUpload({
        customerId: 'org1',
        runId: 'run1',
        jobId: 'job1',
        name: 'bundle',
        sizeBytes: 10,
        sha256: 'abc',
        storageKey: 'artifacts/run1/bundle.tar.gz',
      }),
    ).rejects.toBeInstanceOf(ArtifactObjectMissingError);

    const row = await db
      .selectFrom('artifacts')
      .select('id')
      .where('run_id', '=', 'run1')
      .where('name', '=', 'bundle')
      .executeTakeFirst();
    expect(row).toBeUndefined(); // no phantom row pointing at a non-existent object
  });

  it('returns not_found for an unknown artifact name', async () => {
    const { s } = store();
    const dl = await s.download({ customerId: 'o', runId: 'r', name: 'nope' });
    expect(dl.outcome).toBe('not_found');
  });
});

/**
 * The name contract is enforced before any database access, so these cases need
 * no live Postgres and run everywhere. On the upload path the stub handle throws
 * on any property access, which is what proves the short-circuit rather than
 * merely assuming it; the commit path never reaches the database even without
 * the check (the object-existence probe runs first), so there it is the
 * `ArtifactInvalidNameError` class assertion that pins the behaviour.
 */
describe('ArtifactStore name contract', () => {
  function storeWithoutDb(): ArtifactStore {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error('the database must not be touched for a non-conforming name');
        },
      },
    ) as Kysely<Database>;
    return new ArtifactStore({ db, storage: fakeStorage() });
  }

  /** Names the shared contract refuses, covering every clause of the schema. */
  const INVALID_NAMES = ['a/b', 'a b', '', '.', '..', 'a'.repeat(ARTIFACT_NAME_MAX_LENGTH + 1)];

  it.each(INVALID_NAMES)('rejects the upload of %j before any gate', async (name) => {
    const result = await storeWithoutDb().beginUpload({
      customerId: 'org1',
      runId: 'run1',
      name,
      declaredSizeBytes: 10,
    });
    expect(result.outcome).toBe('rejected');
    // Not an enforcement gate: the author must not be told to free up quota.
    expect(result.reason).toBeUndefined();
    expect(result.error).toContain(ARTIFACT_INVALID_NAME_PREFIX);
  });

  it('renders an invalid-name rejection from the shared engine definition', () => {
    // Pins the exact customer-visible detail. The agent sandbox asserts the same
    // string in its own test, so the two tiers cannot drift apart again.
    expect(new ArtifactInvalidNameError(checkArtifactName('a/b')!).message).toBe(
      'invalid artifact name: artifact name may only contain letters, digits, ".", "_", and "-"',
    );
  });

  it.each(INVALID_NAMES)('rejects the commit of %j — the second door onto the key', (name) => {
    return expect(
      storeWithoutDb().completeUpload({
        customerId: 'org1',
        runId: 'run1',
        jobId: 'job1',
        name,
        sizeBytes: 10,
        sha256: 'deadbeef',
        storageKey: 'artifacts/run1/whatever.tar.gz',
      }),
    ).rejects.toThrow(ArtifactInvalidNameError);
  });

  it('rejects a name that sanitizes onto another name, independently of the key', async () => {
    // The discriminator hashes the EXACT name, so sanitization is no longer the
    // only thing keeping keys apart: names that sanitize identically still
    // derive distinct keys. Neither of these passes `ArtifactNameSchema`, so
    // this is defence in depth rather than a reachable path.
    expect(artifactStorageKey('run1', 'a/b')).not.toBe(artifactStorageKey('run1', 'a_b'));
    expect(artifactStorageKey('run1', 'a_b')).toMatch(
      /^artifacts\/run1\/a_b-[0-9a-f]{32}\.tar\.gz$/,
    );
    // Same for the all-dots clause: `.` escapes onto the literal name `_.`, and
    // the two still address different objects.
    expect(artifactStorageKey('run1', '.')).not.toBe(artifactStorageKey('run1', '_.'));
    // The name contract is still enforced on its own terms — a non-conforming
    // name never reaches the key derivation at all.
    const collider = await storeWithoutDb().beginUpload({
      customerId: 'org1',
      runId: 'run1',
      name: 'a/b',
      declaredSizeBytes: 10,
    });
    expect(collider.outcome).toBe('rejected');
  });

  it('maps every accepted name to itself, so distinct names produce distinct keys', () => {
    // Includes the adversarial shapes the identity claim has to survive: the
    // escaped form the all-dots clause protects (`_.`), a name that already
    // ends in the tarball suffix, and a prefix-related pair.
    const accepted = [
      'bundle',
      'a_b',
      'a.b',
      'a-b',
      '.hidden',
      'A1',
      '_.',
      'x.tar.gz',
      'a',
      'a.tar',
      'x'.repeat(ARTIFACT_NAME_MAX_LENGTH),
    ];
    const keys = new Set<string>();
    for (const name of accepted) {
      expect(ArtifactNameSchema.safeParse(name).success).toBe(true);
      const key = artifactStorageKey('run1', name);
      expect(key).toMatch(
        new RegExp(`^artifacts/run1/${escapeRegExp(name)}-[0-9a-f]{32}\\.tar\\.gz$`),
      );
      keys.add(key);
    }
    expect(keys.size).toBe(accepted.length);
  });

  it('keeps names differing only by case distinct even after case folding', () => {
    const upper = artifactStorageKey('run1', 'Build');
    const lower = artifactStorageKey('run1', 'build');

    expect(upper).not.toBe(lower);
    // The load-bearing assertion. The keys differing is not enough — they
    // differed by case alone before the discriminator existed. What matters is
    // that they still differ once a case-insensitive backend folds them, which
    // is what makes them two objects on an APFS/HFS+ volume rather than one.
    expect(upper.toLowerCase()).not.toBe(lower.toLowerCase());
  });

  it('derives the same key for the same name every time', () => {
    // The commit path re-derives and compares against the agent's wire value,
    // so a non-deterministic key would log a spurious mismatch on every upload.
    expect(artifactStorageKey('run1', 'bundle')).toBe(artifactStorageKey('run1', 'bundle'));
  });

  it('keeps the key readable and prefix-listable', () => {
    const key = artifactStorageKey('run1', 'bundle');

    expect(key.startsWith('artifacts/run1/')).toBe(true);
    expect(key.endsWith('.tar.gz')).toBe(true);
    // The readable stem is deliberate: an operator browsing the bucket must
    // still be able to tell which artifact an object is.
    expect(key).toContain('bundle');
  });
});

/**
 * The commit-failure classifier is pure, so it lives outside `describeDb` and
 * runs everywhere. Every assertion here is deliberately negative: expecting only
 * the new literal would still pass if the send site reverted to forwarding the
 * raw exception and its text happened to match.
 */
describe('classifyArtifactCommitFailure', () => {
  it('passes through an invalid-name message, which is already safe', () => {
    const reason = classifyArtifactCommitFailure(new ArtifactInvalidNameError('must not be empty'));

    // The detail is one of the schema's own fixed messages, never caller input,
    // so the author still learns what was wrong with the name.
    expect(reason).toContain(ARTIFACT_INVALID_NAME_PREFIX);
    expect(reason).toContain('must not be empty');
  });

  it('replaces an object-missing message so the storage key does not travel', () => {
    const storageKey = 'artifacts/run-1/bundle-0123456789abcdef.tar.gz';
    const err = new ArtifactObjectMissingError(storageKey);
    const reason = classifyArtifactCommitFailure(err);

    expect(reason).toBe(ArtifactInternalFailure.commitObjectMissing);
    // The whole point: the key is in err.message but must not reach the agent.
    expect(err.message).toContain(storageKey);
    expect(reason).not.toContain(storageKey);
  });

  it('collapses anything else to the generic commit-failed literal', () => {
    const reason = classifyArtifactCommitFailure(
      new Error('connect ECONNREFUSED 10.1.2.3:5432 relation "artifacts" violates constraint'),
    );

    expect(reason).toBe(ArtifactInternalFailure.commitFailed);
    expect(reason).not.toContain('ECONNREFUSED');
    expect(reason).not.toContain('10.1.2.3');
    expect(reason).not.toContain('constraint');
  });

  it('handles a non-Error throw', () => {
    expect(classifyArtifactCommitFailure('a bare string')).toBe(
      ArtifactInternalFailure.commitFailed,
    );
  });
});
