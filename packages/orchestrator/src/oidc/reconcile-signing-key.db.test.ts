import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { Migrator } from 'kysely/migration';
import { exportJWK, generateKeyPair } from 'jose';
import { createMigrationProvider } from '../db/migration-provider.js';
import type { Database } from '../db/types.js';
import { OrchestratorSigningKeyRepo } from '../db/repos/signing-keys-repo.js';
import { terminateTestDbBackends } from '../__test-helpers__/test-db.js';
import { createKeyCreationGate, reconcileOrchestratorSigningKey } from './reconcile-signing-key.js';
import { OrchestratorSignerKind } from './orchestrator-signer-factory.js';
import { DbSigner } from './db-signer.js';
import { SigningKeyStatus } from './signing-key-status.js';

/**
 * Real-Postgres coverage for the db-custody key creation path: several
 * signing-enabled nodes sharing one database converge on ONE active key, a
 * non-leader creates the key when no leader does, an existing key is loaded
 * rather than replaced, an active key of another custody kind is never replaced
 * by a db-custody node, and external custody keeps its rotation semantics.
 */
const ADMIN_URL = process.env.KICI_TEST_ADMIN_DATABASE_URL;
const describeDb = ADMIN_URL ? describe : describe.skip;
const TEST_DB = `kici_rsk_test_${process.pid}_${Date.now()}`;
const MASTER_KEY = '0'.repeat(64);
const ISSUER = 'https://orch.example';
const DB_CONFIG = {
  provenanceSigningIssuer: ISSUER,
  provenanceSignerKind: OrchestratorSignerKind.enum.db,
};

function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

/**
 * A repo whose `getActiveRow` waits until `parties` callers have all read, so
 * every node observes "no active key" before any of them writes — the exact
 * interleaving two booting nodes produce.
 */
function barrierRepo(db: Kysely<Database>, parties: number): OrchestratorSigningKeyRepo {
  const repo = new OrchestratorSigningKeyRepo(db);
  let arrived = 0;
  let release: () => void = () => {};
  const allArrived = new Promise<void>((r) => {
    release = r;
  });
  const read = repo.getActiveRow.bind(repo);
  repo.getActiveRow = async () => {
    const row = await read();
    arrived += 1;
    if (arrived === parties) release();
    await allArrived;
    return row;
  };
  return repo;
}

describeDb('reconcileOrchestratorSigningKey against Postgres', () => {
  let db: Kysely<Database>;
  let pool: pg.Pool;
  let scriptDir: string;
  let commandSigner: string;
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

    // An external-custody signer honouring the documented command contract.
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const privateJwk = await exportJWK(privateKey);
    scriptDir = mkdtempSync(join(tmpdir(), 'kici-rsk-cmd-'));
    const keyFile = join(scriptDir, 'priv.json');
    writeFileSync(keyFile, JSON.stringify(privateJwk));
    commandSigner = join(scriptDir, 'signer.mjs');
    writeFileSync(
      commandSigner,
      `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const privateJwk = JSON.parse(readFileSync(${JSON.stringify(keyFile)}, 'utf8'));
if (process.argv[2] === 'get-public-jwk') {
  const { d, ...pub } = privateJwk;
  process.stdout.write(JSON.stringify(pub));
} else {
  process.exit(2);
}
`,
    );
    chmodSync(commandSigner, 0o755);
  }, 60_000);

  afterAll(async () => {
    rmSync(scriptDir, { recursive: true, force: true });
    await db?.destroy();
    await pool?.end().catch(() => {});
    const admin = new pg.Pool({ connectionString: adminUrl });
    try {
      await terminateTestDbBackends(admin, TEST_DB);
      await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
    } finally {
      await admin.end();
    }
  }, 60_000);

  beforeEach(async () => {
    await db.deleteFrom('orchestrator_signing_keys').execute();
  });

  async function allRows() {
    return db.selectFrom('orchestrator_signing_keys').select(['kid', 'status']).execute();
  }

  it('two nodes that both read "no key" converge on one active key and sign with it', async () => {
    // fails-when: the create is a plain upsert — both nodes insert, the second
    // demotes the first, and the first node signs with a retiring key.
    const repo = barrierRepo(db, 2);
    const attempts = vi.spyOn(repo, 'activateIfCurrent');
    const audit = vi.fn();
    const node = () =>
      reconcileOrchestratorSigningKey({
        repo,
        config: DB_CONFIG,
        mayCreateKey: () => true,
        secretKey: MASTER_KEY,
        audit,
      });
    const [a, b] = await Promise.all([node(), node()]);

    // Positive control: both nodes reached the write, so the race really ran.
    expect(attempts).toHaveBeenCalledTimes(2);
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(SigningKeyStatus.enum.active);
    expect(await a!.signer.getKid()).toBe(rows[0]!.kid);
    expect(await b!.signer.getKid()).toBe(rows[0]!.kid);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it('a non-leader with signing enabled creates the key once the leader grace has passed', async () => {
    let now = 1_000;
    const mayCreateKey = createKeyCreationGate({
      isLeader: () => false,
      graceMs: 2_000,
      now: () => now,
    });
    const deps = {
      repo: new OrchestratorSigningKeyRepo(db),
      config: DB_CONFIG,
      mayCreateKey,
      secretKey: MASTER_KEY,
      audit: vi.fn(),
    };
    // breaks-if-wrong: inside the grace the leader keeps the first chance.
    expect(await reconcileOrchestratorSigningKey(deps)).toBeNull();
    expect(await allRows()).toHaveLength(0);

    now += 2_000;
    // fails-when: a non-leader never creates — the null above repeats forever
    // on a cluster whose leader has signing disabled.
    const created = await reconcileOrchestratorSigningKey(deps);
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(await created!.signer.getKid()).toBe(rows[0]!.kid);
  });

  it('loads an existing active key instead of replacing it', async () => {
    const repo = new OrchestratorSigningKeyRepo(db);
    const first = await reconcileOrchestratorSigningKey({
      repo,
      config: DB_CONFIG,
      mayCreateKey: () => true,
      secretKey: MASTER_KEY,
      audit: vi.fn(),
    });
    const kid = await first!.signer.getKid();

    const audit = vi.fn();
    const second = await reconcileOrchestratorSigningKey({
      repo: new OrchestratorSigningKeyRepo(db),
      config: DB_CONFIG,
      mayCreateKey: () => true,
      secretKey: MASTER_KEY,
      audit,
    });
    expect(await second!.signer.getKid()).toBe(kid);
    expect(await allRows()).toEqual([{ kid, status: SigningKeyStatus.enum.active }]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('a db-custody node past the leader grace never replaces an active command-custody key', async () => {
    const repo = new OrchestratorSigningKeyRepo(db);
    const external = await reconcileOrchestratorSigningKey({
      repo,
      config: {
        provenanceSigningIssuer: ISSUER,
        provenanceSignerKind: OrchestratorSignerKind.enum.command,
        provenanceSignerCommand: commandSigner,
      },
      mayCreateKey: () => false,
      secretKey: undefined,
      audit: vi.fn(),
    });
    const externalKid = await external!.signer.getKid();

    // A non-leader whose grace has passed, and a leader: both may create.
    const attempts = vi.spyOn(repo, 'activateIfCurrent');
    const audit = vi.fn();
    const dbNode = () =>
      reconcileOrchestratorSigningKey({
        repo,
        config: DB_CONFIG,
        mayCreateKey: () => true,
        secretKey: MASTER_KEY,
        audit,
      });
    // fails-when: the db node reads the keyless command row as "no key" and activates a software key
    await expect(dbNode()).rejects.toThrow(/held in 'command' custody.*signing-key rotate/s);
    expect(attempts).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(await allRows()).toEqual([{ kid: externalKid, status: SigningKeyStatus.enum.active }]);

    // breaks-if-wrong: the explicit move to db custody (`kici-admin signing-key rotate`,
    // a generated key through upsertActive) still works, and the db node then signs with it.
    const rotated = await DbSigner.generate(MASTER_KEY);
    await repo.upsertActive({
      kid: rotated.kid,
      public_jwk: rotated.publicJwk as unknown as Record<string, unknown>,
      encrypted_private_jwk: rotated.encryptedPrivateJwk,
      alg: rotated.signer.alg,
      signer_kind: rotated.signer.signerKind,
      key_ref: rotated.signer.keyRef,
    });
    const signing = await dbNode();
    expect(await signing!.signer.getKid()).toBe(rotated.kid);
    const rows = await allRows();
    expect(rows.find((r) => r.kid === externalKid)?.status).toBe(SigningKeyStatus.enum.retiring);
  });

  it('external custody still activates its configured key and rotates out the previous one', async () => {
    const repo = new OrchestratorSigningKeyRepo(db);
    const seeded = await reconcileOrchestratorSigningKey({
      repo,
      config: DB_CONFIG,
      mayCreateKey: () => true,
      secretKey: MASTER_KEY,
      audit: vi.fn(),
    });
    const dbKid = await seeded!.signer.getKid();

    const externalConfig = {
      provenanceSigningIssuer: ISSUER,
      provenanceSignerKind: OrchestratorSignerKind.enum.command,
      provenanceSignerCommand: commandSigner,
    };
    const audit = vi.fn();
    const node = () =>
      reconcileOrchestratorSigningKey({
        repo,
        config: externalConfig,
        // External custody never consults the creation gate.
        mayCreateKey: () => false,
        secretKey: undefined,
        audit,
      });
    const a = await node();
    const b = await node();
    const externalKid = await a!.signer.getKid();
    expect(await b!.signer.getKid()).toBe(externalKid);

    const rows = await allRows();
    expect(rows.find((r) => r.kid === externalKid)?.status).toBe(SigningKeyStatus.enum.active);
    expect(rows.find((r) => r.kid === dbKid)?.status).toBe(SigningKeyStatus.enum.retiring);
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
