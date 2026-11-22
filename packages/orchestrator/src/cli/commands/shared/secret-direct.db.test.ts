/**
 * `setSecretDirect` and `verifySecretsDirect` against a real migrated PostgreSQL database:
 * the row a direct write stores is the orchestrator's own ciphertext, which `PgSecretStore`
 * decrypts, and verify lists exactly the rows the master key cannot decrypt.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { deriveKey } from '@kici-dev/shared';
import { describeWithTestDb } from '@kici-dev/test-support/test-db';
import { createMigrationProvider } from '../../../db/migration-provider.js';
import type { Database } from '../../../db/types.js';
import { AuditLogger } from '../../../secrets/audit-logger.js';
import { PgSecretStore, StoredKeyCheck } from '../../../secrets/pg-secret-store.js';
import {
  DIRECT_SECRET_ACTOR,
  resolveDirectSecretSettings,
  secretEnvFromEnvFile,
  setSecretDirect,
  verifySecretsDirect,
} from './secret-direct.js';

const KEY = 'c'.repeat(64);
const FOREIGN_KEY = 'd'.repeat(64);
const VALUE = 'direct-secret-value';

const settings = (env: NodeJS.ProcessEnv = { KICI_SECRET_KEY: KEY }) =>
  resolveDirectSecretSettings(env);

describe('resolveDirectSecretSettings', () => {
  it('reads the key and the PG toggle through the orchestrator schema', () => {
    const s = resolveDirectSecretSettings({
      KICI_SECRET_KEY: KEY,
      KICI_PG_CUSTOMER_SECRETS: 'false',
    });
    expect(s.masterKeys!.current.equals(deriveKey(KEY))).toBe(true);
    expect(s.pgCustomerSecrets).toBe(false);
    expect(resolveDirectSecretSettings({}).masterKeys).toBeNull();
    expect(resolveDirectSecretSettings({}).pgCustomerSecrets).toBe(true);
  });

  // breaks-if-wrong: a value the orchestrator refuses at startup must not be read as "on" here
  it('refuses a PG toggle value the orchestrator refuses', () => {
    expect(() => resolveDirectSecretSettings({ KICI_PG_CUSTOMER_SECRETS: 'no' })).toThrow();
  });

  it('reads only the secret settings of a service env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kici-secret-env-'));
    const file = join(dir, 'orchestrator.env');
    writeFileSync(
      file,
      `KICI_DATABASE_URL=postgres://ignored\nKICI_SECRET_KEY="${KEY}"\nKICI_PG_CUSTOMER_SECRETS=false\nKICI_TYPO=1\n`,
    );
    expect(secretEnvFromEnvFile(file)).toEqual({
      KICI_SECRET_KEY: KEY,
      KICI_PG_CUSTOMER_SECRETS: 'false',
    });
    expect(() => secretEnvFromEnvFile(join(dir, 'missing.env'))).toThrow(
      /cannot read the env file .*missing\.env \(ENOENT\)/,
    );
  });
});

describeWithTestDb<Database>(
  'setSecretDirect',
  { prefix: 'kici_secret_direct', provider: createMigrationProvider(), timeoutMs: 120_000 },
  (getDb) => {
    afterEach(async () => {
      await sql`TRUNCATE scoped_secrets, secret_audit_log`.execute(getDb().db);
    });

    const write = (scope = 'staging', key = 'API_KEY') => ({
      orgId: 'org-1',
      scope,
      key,
      value: VALUE,
    });

    it('stores the value encrypted, and the orchestrator decrypts it', async () => {
      // fails-when: the direct write stores the plaintext, so it is readable at rest and the
      // orchestrator's rename, rotation and resolution fail on it
      const { db, url } = getDb();
      await setSecretDirect(url, write(), settings());
      const rows = await db.selectFrom('scoped_secrets').selectAll().execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.encrypted_value).not.toContain(VALUE);
      const store = await PgSecretStore.create(db, deriveKey(KEY), new AuditLogger(db));
      expect(await store.getSecrets('org-1', 'staging')).toEqual({ API_KEY: VALUE });
      // The write is audited, as the admin API audits one.
      const audit = await db.selectFrom('secret_audit_log').selectAll().execute();
      expect(audit.map((a) => [a.action, a.user_id])).toEqual([['setSecret', DIRECT_SECRET_ACTOR]]);
    });

    it('refuses with no master key, and writes nothing', async () => {
      // breaks-if-wrong: an operator with no key is told to set one, never handed a plaintext row
      const { db, url } = getDb();
      await expect(setSecretDirect(url, write(), settings({}))).rejects.toThrow(
        /needs the orchestrator master key/,
      );
      expect(await db.selectFrom('scoped_secrets').selectAll().execute()).toEqual([]);
    });

    it('honours KICI_PG_CUSTOMER_SECRETS=false as the orchestrator does', async () => {
      await expect(
        setSecretDirect(
          getDb().url,
          write(),
          settings({ KICI_SECRET_KEY: KEY, KICI_PG_CUSTOMER_SECRETS: 'false' }),
        ),
      ).rejects.toThrow(/PG customer secrets are disabled/);
    });

    it('refuses a key that makes the AAD ambiguous', async () => {
      await expect(
        setSecretDirect(getDb().url, write('staging', 'a:b'), settings()),
      ).rejects.toThrow(/letters, digits/);
    });

    it('accepts a pg-qualified scope, as the admin API does', async () => {
      // fails-when: the qualifier reaches the scope validator, which refuses the colon
      const { db, url } = getDb();
      await setSecretDirect(url, write('pg:staging'), settings());
      const rows = await db.selectFrom('scoped_secrets').select(['scope']).execute();
      expect(rows).toEqual([{ scope: 'staging' }]);
      const audit = await db.selectFrom('secret_audit_log').select(['context_name']).execute();
      expect(audit).toEqual([{ context_name: 'pg:staging' }]);
      // breaks-if-wrong: another backend's qualifier is not silently written to PG, and the
      //   refusal names the backend, not the scope name's colon
      await expect(setSecretDirect(url, write('vault:staging'), settings())).rejects.toThrow(
        /writes only the PostgreSQL store \(pg:\)\. "vault:staging" names the "vault" backend/,
      );
    });

    it('refuses a master key that decrypts none of the stored secrets', async () => {
      const { db, url } = getDb();
      await setSecretDirect(url, write(), settings());
      // fails-when: a foreign key writes a row no orchestrator key decrypts
      await expect(
        setSecretDirect(url, write('staging', 'OTHER'), settings({ KICI_SECRET_KEY: FOREIGN_KEY })),
      ).rejects.toThrow(/not this orchestrator key/);
      expect(await db.selectFrom('scoped_secrets').select(['key']).execute()).toEqual([
        { key: 'API_KEY' },
      ]);
      // breaks-if-wrong: the right key still writes when a legacy plaintext row sits beside a
      // good one
      await db
        .insertInto('scoped_secrets')
        .values({ org_id: 'org-1', scope: 'legacy', key: 'PLAIN', encrypted_value: 'plaintext' })
        .execute();
      await setSecretDirect(url, write('staging', 'OTHER'), settings());
    });

    it('accepts the key, unconfirmed, when the store holds no ciphertext', async () => {
      const { db, url } = getDb();
      // An empty store: nothing confirms or refutes the key.
      expect(await setSecretDirect(url, write('staging', 'FIRST'), settings())).toEqual({
        keyConfirmed: false,
      });
      await db.deleteFrom('scoped_secrets').execute();
      // Only the plaintext rows the old direct write left: the population the fix is for.
      await db
        .insertInto('scoped_secrets')
        .values([
          { org_id: 'org-1', scope: 'legacy', key: 'A', encrypted_value: 'hunter2' },
          { org_id: 'org-1', scope: 'legacy', key: 'B', encrypted_value: 'plain token' },
        ])
        .execute();
      // breaks-if-wrong: the remediation the fix fragment names (re-set each listed secret)
      //   works on an install whose secrets are all plaintext
      expect(await setSecretDirect(url, write('legacy', 'A'), settings())).toEqual({
        keyConfirmed: false,
      });
      const store = await PgSecretStore.create(db, deriveKey(KEY), new AuditLogger(db));
      const a = await db
        .selectFrom('scoped_secrets')
        .select(['encrypted_value', 'key_version'])
        .where('key', '=', 'A')
        .executeTakeFirstOrThrow();
      expect(store.decryptValue('org-1', 'legacy', 'A', a.encrypted_value, a.key_version)).toBe(
        VALUE,
      );
      // fails-when: a foreign key is accepted while a well-formed ciphertext row is stored
      await expect(
        setSecretDirect(url, write('legacy', 'C'), settings({ KICI_SECRET_KEY: FOREIGN_KEY })),
      ).rejects.toThrow(/not this orchestrator key/);
      // With a row that decrypts, the right key is confirmed.
      expect(await setSecretDirect(url, write('legacy', 'C'), settings())).toEqual({
        keyConfirmed: true,
      });
    });

    it('the key check reads every stored row, not a sample', async () => {
      // fails-when: the check reads only the first rows, so plaintext rows ahead of the one
      //   ciphertext row make a foreign key read as Unconfirmed instead of Mismatch
      const { db, url } = getDb();
      await setSecretDirect(url, write('zz-last', 'SEALED'), settings());
      await db
        .insertInto('scoped_secrets')
        .values(
          ['a', 'b', 'c', 'd'].map((key) => ({
            org_id: 'org-1',
            scope: 'legacy',
            key,
            encrypted_value: 'plain',
          })),
        )
        .execute();
      const foreign = await PgSecretStore.create(db, deriveKey(FOREIGN_KEY), new AuditLogger(db));
      const own = await PgSecretStore.create(db, deriveKey(KEY), new AuditLogger(db));
      for (const pageSize of [1, 2, 5, 500]) {
        expect(await foreign.checkKeyAgainstStoredSecrets(pageSize), String(pageSize)).toBe(
          StoredKeyCheck.Mismatch,
        );
        // breaks-if-wrong: the right key still matches the one row it can decrypt
        expect(await own.checkKeyAgainstStoredSecrets(pageSize), String(pageSize)).toBe(
          StoredKeyCheck.Match,
        );
      }
    });

    it('verify reads an install larger than one page', async () => {
      // fails-when: the paged scan stops after its first page
      const { db, url } = getDb();
      await db
        .insertInto('scoped_secrets')
        .values(
          ['a', 'b', 'c', 'd', 'e'].map((key) => ({
            org_id: 'org-1',
            scope: 'legacy',
            key,
            encrypted_value: 'plain',
          })),
        )
        .execute();
      const store = await PgSecretStore.create(db, deriveKey(KEY), new AuditLogger(db));
      for (const pageSize of [1, 2, 5, 500]) {
        expect(
          (await store.findUndecryptable(pageSize)).map((l) => l.key),
          String(pageSize),
        ).toEqual(['a', 'b', 'c', 'd', 'e']);
      }
      expect(await verifySecretsDirect(url, settings())).toHaveLength(5);
    });

    it('verify lists the plaintext row, and never an encrypted one', async () => {
      const { db, url } = getDb();
      await setSecretDirect(url, write(), settings());
      expect(await verifySecretsDirect(url, settings())).toEqual([]);
      await db
        .insertInto('scoped_secrets')
        .values({ org_id: 'org-1', scope: 'legacy', key: 'PLAIN', encrypted_value: VALUE })
        .execute();
      // fails-when: verify reports clean while a row the orchestrator cannot read is stored
      expect(await verifySecretsDirect(url, settings())).toEqual([
        { orgId: 'org-1', scope: 'legacy', key: 'PLAIN' },
      ]);
      // Under a foreign key, the encrypted row is listed too: it is the key that is wrong.
      expect(
        (await verifySecretsDirect(url, settings({ KICI_SECRET_KEY: FOREIGN_KEY }))).map(
          (s) => s.key,
        ),
      ).toEqual(['PLAIN', 'API_KEY']);
    });
  },
);
