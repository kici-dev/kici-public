import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Migration, MigrationProvider } from 'kysely/migration';
import pg from 'pg';
import {
  computeMigrationsHash,
  ensureDatabase,
  maskDatabaseUrl,
  parseDatabaseUrl,
  seedEnvironmentDirect,
  deleteEnvironmentDirect,
  seedEnvironmentBindingDirect,
  setEnvironmentPolicyDirect,
  listEnvironmentsDirect,
  showEnvironmentDirect,
  createEnvironmentTemplateDirect,
  setEnvironmentSecretDirect,
  waitForPlatformRegistrationsDirect,
} from './db-admin.js';

describe('parseDatabaseUrl', () => {
  it('extracts db name, owner, and admin URL', () => {
    const result = parseDatabaseUrl('postgresql://kici_user:secret@localhost:5432/kici_orch');
    expect(result.dbName).toBe('kici_orch');
    expect(result.dbOwner).toBe('kici_user');
    expect(result.adminUrl).toBe('postgresql://kici_user:secret@localhost:5432/postgres');
  });

  it('decodes percent-escaped usernames', () => {
    const result = parseDatabaseUrl('postgresql://my%40user:pw@localhost:5432/db');
    expect(result.dbOwner).toBe('my@user');
  });

  it('throws if path component is missing', () => {
    expect(() => parseDatabaseUrl('postgresql://user:pw@localhost:5432/')).toThrow(
      /missing \/dbname/,
    );
  });

  it('throws if username is missing', () => {
    expect(() => parseDatabaseUrl('postgresql://localhost:5432/db')).toThrow(/missing username/);
  });
});

describe('maskDatabaseUrl', () => {
  it('redacts password', () => {
    expect(maskDatabaseUrl('postgresql://user:super-secret@host:5432/db')).toBe(
      'postgresql://user:***@host:5432/db',
    );
  });

  it('leaves password-less URLs alone', () => {
    expect(maskDatabaseUrl('postgresql://user@host:5432/db')).toBe(
      'postgresql://user@host:5432/db',
    );
  });

  it('returns a placeholder for malformed input', () => {
    expect(maskDatabaseUrl('not a url')).toBe('<unparseable database-url>');
  });
});

describe('computeMigrationsHash', () => {
  const makeProvider = (migs: Record<string, Migration>): MigrationProvider => ({
    async getMigrations() {
      return migs;
    },
  });

  it('is deterministic for the same migrations', async () => {
    const m1: Migration = {
      async up() {},
      async down() {},
    };
    const h1 = await computeMigrationsHash(makeProvider({ '001_initial': m1 }));
    const h2 = await computeMigrationsHash(makeProvider({ '001_initial': m1 }));
    expect(h1).toBe(h2);
  });

  it('changes when a migration body changes', async () => {
    const before: Migration = {
      async up() {
        /* nothing */
      },
    };
    const after: Migration = {
      async up() {
        /* different body */ console.log('changed');
      },
    };
    const h1 = await computeMigrationsHash(makeProvider({ '001_initial': before }));
    const h2 = await computeMigrationsHash(makeProvider({ '001_initial': after }));
    expect(h1).not.toBe(h2);
  });

  it('changes when a migration is added', async () => {
    const m1: Migration = { async up() {} };
    const m2: Migration = { async up() {} };
    const h1 = await computeMigrationsHash(makeProvider({ '001_initial': m1 }));
    const h2 = await computeMigrationsHash(makeProvider({ '001_initial': m1, '002_extra': m2 }));
    expect(h1).not.toBe(h2);
  });

  it('is order-independent over object key insertion order', async () => {
    const m1: Migration = { async up() {} };
    const m2: Migration = { async up() {} };
    const h1 = await computeMigrationsHash(makeProvider({ '001_initial': m1, '002_extra': m2 }));
    const h2 = await computeMigrationsHash(makeProvider({ '002_extra': m2, '001_initial': m1 }));
    expect(h1).toBe(h2);
  });
});

// ── environment *Direct helpers ──────────────────────────────────────────
//
// These use a mocked pg.Pool — we assert the SQL text and parameter bindings
// without hitting a real DB. The integration-level coverage (ON CONFLICT
// semantics, JSONB serialisation round-trip) lives in the downstream e2e
// suites that exercise these helpers against the local compose stack.

interface MockQueryResult {
  rows: Record<string, unknown>[];
  rowCount?: number;
}

interface QueryCall {
  sql: string;
  params: unknown[];
}

function installPoolMock(responses: MockQueryResult[]): {
  calls: QueryCall[];
  endCalls: number;
  restore: () => void;
} {
  const calls: QueryCall[] = [];
  let endCalls = 0;
  let idx = 0;

  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      const next = responses[idx++];
      if (!next) {
        throw new Error(`mock pool: no response queued for query #${idx} (${sql})`);
      }
      return next;
    },
    on() {},
    release() {},
  };

  class MockPool {
    constructor(_opts: unknown) {}
    on() {}
    async query(sql: string, params: unknown[] = []) {
      return client.query(sql, params);
    }
    async connect() {
      return client;
    }
    async end() {
      endCalls += 1;
    }
  }

  const original = pg.Pool;
  (pg as unknown as { Pool: unknown }).Pool = MockPool;
  return {
    calls,
    get endCalls() {
      return endCalls;
    },
    restore: () => {
      (pg as unknown as { Pool: unknown }).Pool = original;
    },
  };
}

describe('ensureDatabase', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('CREATEs the database with URL user as owner when --owner is omitted', async () => {
    pool = installPoolMock([
      { rows: [], rowCount: 0 }, // SELECT 1 FROM pg_database — not found
      { rows: [], rowCount: 0 }, // CREATE DATABASE
    ]);
    const outcome = await ensureDatabase('postgresql://kici:pw@localhost:5432/platform');
    expect(outcome).toBe('created');
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0].sql).toMatch(/SELECT 1 FROM pg_database/);
    expect(pool.calls[0].params).toEqual(['platform']);
    expect(pool.calls[1].sql).toBe('CREATE DATABASE "platform" OWNER "kici"');
  });

  it('returns "exists" without issuing CREATE when the DB is already there', async () => {
    pool = installPoolMock([{ rows: [{ '?column?': 1 }], rowCount: 1 }]);
    const outcome = await ensureDatabase('postgresql://kici:pw@localhost:5432/platform');
    expect(outcome).toBe('exists');
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(/SELECT 1 FROM pg_database/);
  });

  it('honours --owner override for cross-owner provisioning', async () => {
    pool = installPoolMock([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    await ensureDatabase('postgresql://admin:pw@localhost:5432/keycloak', { owner: 'keycloak' });
    expect(pool.calls[1].sql).toBe('CREATE DATABASE "keycloak" OWNER "keycloak"');
  });

  it('REVOKEs CONNECT from PUBLIC when --revoke-connect-public is set, even on exists', async () => {
    pool = installPoolMock([
      { rows: [{ '?column?': 1 }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const outcome = await ensureDatabase('postgresql://admin:pw@localhost:5432/keycloak', {
      owner: 'keycloak',
      revokeConnectFromPublic: true,
    });
    expect(outcome).toBe('exists');
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[1].sql).toBe('REVOKE CONNECT ON DATABASE "keycloak" FROM PUBLIC');
  });

  it('REVOKEs CONNECT from PUBLIC after a fresh CREATE too', async () => {
    pool = installPoolMock([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
    ]);
    const outcome = await ensureDatabase('postgresql://admin:pw@localhost:5432/keycloak', {
      owner: 'keycloak',
      revokeConnectFromPublic: true,
    });
    expect(outcome).toBe('created');
    expect(pool.calls).toHaveLength(3);
    expect(pool.calls[1].sql).toBe('CREATE DATABASE "keycloak" OWNER "keycloak"');
    expect(pool.calls[2].sql).toBe('REVOKE CONNECT ON DATABASE "keycloak" FROM PUBLIC');
  });

  it('GRANTs CONNECT to each role after REVOKE when grantConnectToRoles is set (exists)', async () => {
    pool = installPoolMock([
      { rows: [{ '?column?': 1 }], rowCount: 1 }, // SELECT 1 FROM pg_database -> exists
      { rows: [], rowCount: 0 }, // REVOKE
      { rows: [], rowCount: 0 }, // GRANT platform
    ]);
    const outcome = await ensureDatabase('postgresql://platform:pw@localhost:5432/platform', {
      revokeConnectFromPublic: true,
      grantConnectToRoles: ['platform'],
    });
    expect(outcome).toBe('exists');
    expect(pool.calls).toHaveLength(3);
    expect(pool.calls[1].sql).toBe('REVOKE CONNECT ON DATABASE "platform" FROM PUBLIC');
    expect(pool.calls[2].sql).toBe('GRANT CONNECT ON DATABASE "platform" TO "platform"');
  });

  it('GRANTs CONNECT to multiple roles in order', async () => {
    pool = installPoolMock([
      { rows: [{ '?column?': 1 }], rowCount: 1 },
      { rows: [], rowCount: 0 }, // GRANT a
      { rows: [], rowCount: 0 }, // GRANT b
    ]);
    await ensureDatabase('postgresql://admin:pw@localhost:5432/platform', {
      grantConnectToRoles: ['role_a', 'role_b'],
    });
    expect(pool.calls[1].sql).toBe('GRANT CONNECT ON DATABASE "platform" TO "role_a"');
    expect(pool.calls[2].sql).toBe('GRANT CONNECT ON DATABASE "platform" TO "role_b"');
  });

  it('rejects a grant-connect role with shell-injection characters', async () => {
    pool = installPoolMock([{ rows: [{ '?column?': 1 }], rowCount: 1 }]);
    await expect(
      ensureDatabase('postgresql://admin:pw@localhost:5432/platform', {
        grantConnectToRoles: ['platform; DROP DATABASE x'],
      }),
    ).rejects.toThrow(/Invalid grant-connect role identifier/);
  });

  it('rejects an --owner with shell-injection characters', async () => {
    pool = installPoolMock([]);
    await expect(
      ensureDatabase('postgresql://admin:pw@localhost:5432/keycloak', {
        owner: 'evil"; DROP TABLE x; --',
      }),
    ).rejects.toThrow(/database owner/);
  });

  it('rejects a database name with shell-injection characters', async () => {
    pool = installPoolMock([]);
    await expect(
      ensureDatabase('postgresql://admin:pw@localhost:5432/evil%22%3B%20DROP%20TABLE%20x'),
    ).rejects.toThrow(/database name/);
  });
});

describe('seedEnvironmentDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('upserts and returns the envId + created flag', async () => {
    pool = installPoolMock([{ rows: [{ id: 'env-123', inserted: true }], rowCount: 1 }]);
    const result = await seedEnvironmentDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'staging',
      type: 'fixed',
      branchRestrictions: ['main'],
      requiredReviewers: ['user-a'],
    });
    expect(result).toEqual({ envId: 'env-123', created: true });
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(/INSERT INTO environments/);
    expect(pool.calls[0].params[0]).toBe('org1');
    expect(pool.calls[0].params[1]).toBe('staging');
    expect(pool.calls[0].params[4]).toBe(JSON.stringify(['main']));
    expect(pool.calls[0].params[5]).toBe(JSON.stringify(['user-a']));
    expect(pool.endCalls).toBe(1);
  });

  it('rejects negative waitTimerSeconds', async () => {
    pool = installPoolMock([]);
    await expect(
      seedEnvironmentDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        name: 'staging',
        waitTimerSeconds: -1,
      }),
    ).rejects.toThrow(/waitTimerSeconds must be >= 0/);
  });

  it('rejects negative holdExpirySeconds', async () => {
    pool = installPoolMock([]);
    await expect(
      seedEnvironmentDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        name: 'staging',
        holdExpirySeconds: -1,
      }),
    ).rejects.toThrow(/holdExpirySeconds must be >= 0/);
  });

  it('serialises empty branch restrictions as []', async () => {
    pool = installPoolMock([{ rows: [{ id: 'env-1', inserted: true }], rowCount: 1 }]);
    await seedEnvironmentDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'prod',
    });
    expect(pool.calls[0].params[4]).toBe('[]');
    expect(pool.calls[0].params[5]).toBeNull();
  });

  it('passes globPattern through to the glob_pattern column', async () => {
    pool = installPoolMock([{ rows: [{ id: 'env-9', inserted: true }], rowCount: 1 }]);
    await seedEnvironmentDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'review',
      type: 'glob',
      globPattern: 'review/*',
    });
    expect(pool.calls[0].sql).toMatch(/glob_pattern/);
    expect(pool.calls[0].params).toContain('review/*');
  });
});

describe('deleteEnvironmentDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('pre-checks pending held runs, then deletes by org+name', async () => {
    pool = installPoolMock([
      { rows: [{ count: '0' }], rowCount: 1 },
      { rows: [{ id: 'env-1' }], rowCount: 1 },
    ]);
    const result = await deleteEnvironmentDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'staging',
    });
    expect(result).toEqual({ deleted: true });
    expect(pool.calls[0].sql).toMatch(/held_runs/);
    expect(pool.calls[0].params).toEqual(['org1', 'staging']);
    expect(pool.calls[1].sql).toMatch(/DELETE FROM environments/);
    expect(pool.calls[1].params).toEqual(['org1', 'staging']);
    expect(pool.endCalls).toBe(1);
  });

  it('reports deleted=false when no row matched', async () => {
    pool = installPoolMock([
      { rows: [{ count: '0' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const result = await deleteEnvironmentDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'missing',
    });
    expect(result).toEqual({ deleted: false });
    expect(pool.endCalls).toBe(1);
  });

  it('throws and skips the DELETE when pending held runs exist', async () => {
    pool = installPoolMock([{ rows: [{ count: '3' }], rowCount: 1 }]);
    await expect(
      deleteEnvironmentDirect('postgresql://u:p@h:5432/d', { orgId: 'org1', name: 'staging' }),
    ).rejects.toThrow(/3 pending held run/);
    // Only the pre-check query ran — the DELETE was never issued.
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(/held_runs/);
    expect(pool.endCalls).toBe(1);
  });
});

describe('seedEnvironmentBindingDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('looks up the env id, then inserts the binding', async () => {
    pool = installPoolMock([
      { rows: [{ id: 'env-abc' }], rowCount: 1 },
      { rows: [{ inserted: true }], rowCount: 1 },
    ]);
    const result = await seedEnvironmentBindingDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      envName: 'staging',
      scopePattern: 'staging',
    });
    expect(result).toEqual({ created: true });
    expect(pool.calls[0].sql).toMatch(/SELECT id FROM environments/);
    expect(pool.calls[1].sql).toMatch(/INSERT INTO environment_bindings/);
    // host_pattern defaults to '**' (all hosts) when no --host selector is given.
    expect(pool.calls[1].params).toEqual(['org1', 'env-abc', 'staging', '**']);
  });

  it('throws when the environment is missing', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 0 }]);
    await expect(
      seedEnvironmentBindingDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        envName: 'missing',
        scopePattern: 'missing',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('returns created=false when the binding already existed', async () => {
    pool = installPoolMock([
      { rows: [{ id: 'env-abc' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const result = await seedEnvironmentBindingDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      envName: 'staging',
      scopePattern: 'staging',
    });
    expect(result).toEqual({ created: false });
  });
});

describe('setEnvironmentPolicyDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('updates only explicitly-provided fields', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 1 }]);
    await setEnvironmentPolicyDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      envName: 'staging',
      waitTimerSeconds: 60,
      minimumTrust: 'verified',
    });
    const call = pool.calls[0];
    expect(call.sql).toMatch(/UPDATE environments/);
    expect(call.sql).toMatch(/wait_timer_seconds = \$1/);
    expect(call.sql).toMatch(/minimum_trust = \$2/);
    expect(call.sql).not.toMatch(/branch_restrictions/);
    expect(call.sql).not.toMatch(/required_reviewers/);
    expect(call.params).toEqual([60, 'verified', 'org1', 'staging']);
  });

  it('throws when no policy fields are supplied', async () => {
    pool = installPoolMock([]);
    await expect(
      setEnvironmentPolicyDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        envName: 'staging',
      }),
    ).rejects.toThrow(/at least one policy field/);
  });

  it('rejects negative waitTimerSeconds', async () => {
    pool = installPoolMock([]);
    await expect(
      setEnvironmentPolicyDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        envName: 'staging',
        waitTimerSeconds: -5,
      }),
    ).rejects.toThrow(/waitTimerSeconds must be >= 0/);
  });

  it('throws when env not found (rowCount 0)', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 0 }]);
    await expect(
      setEnvironmentPolicyDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        envName: 'missing',
        waitTimerSeconds: 10,
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('listEnvironmentsDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('returns all environments for the given org ordered by name', async () => {
    pool = installPoolMock([
      {
        rows: [
          { id: 'env-1', org_id: 'org1', name: 'prod', type: 'fixed', enabled: true },
          { id: 'env-2', org_id: 'org1', name: 'staging', type: 'fixed', enabled: true },
        ],
        rowCount: 2,
      },
    ]);
    const result = await listEnvironmentsDirect('postgresql://u:p@h:5432/d', { orgId: 'org1' });
    expect(result.environments).toHaveLength(2);
    expect(pool.calls[0].sql).toMatch(
      /SELECT .* FROM environments\s+WHERE org_id = \$1\s+ORDER BY name/s,
    );
    expect(pool.calls[0].params).toEqual(['org1']);
  });
});

describe('showEnvironmentDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('returns environment + variables + bindings', async () => {
    pool = installPoolMock([
      {
        rows: [{ id: 'env-1', org_id: 'org1', name: 'staging', type: 'fixed', enabled: true }],
        rowCount: 1,
      },
      { rows: [{ key: 'API_URL', value: 'https://x', locked: false }], rowCount: 1 },
      { rows: [{ scope_pattern: 'staging' }], rowCount: 1 },
    ]);
    const result = await showEnvironmentDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'staging',
    });
    expect(result.environment.id).toBe('env-1');
    expect(result.variables).toHaveLength(1);
    expect(result.bindings).toHaveLength(1);
    expect(pool.calls[1].params).toEqual(['env-1']);
    expect(pool.calls[2].params).toEqual(['env-1']);
  });

  it('throws when the environment is missing', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 0 }]);
    await expect(
      showEnvironmentDirect('postgresql://u:p@h:5432/d', { orgId: 'org1', name: 'missing' }),
    ).rejects.toThrow(/not found/);
  });
});

describe('createEnvironmentTemplateDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('creates the template row in a transaction and seeds variables', async () => {
    pool = installPoolMock([
      { rows: [{ id: 'tpl-1', inserted: true }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const result = await createEnvironmentTemplateDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      templateName: 'standard',
      variables: { FOO: 'bar', BAZ: 'qux' },
    });
    expect(result).toEqual({ envId: 'tpl-1', created: true, variablesSet: 2 });
    const sqls = pool.calls.map((c) => c.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    expect(sqls.filter((s) => /INSERT INTO environment_variables/.test(s))).toHaveLength(2);
  });

  it('rolls back on failure', async () => {
    const failingResponses: MockQueryResult[] = [
      { rows: [{ id: 'tpl-1', inserted: true }], rowCount: 1 },
    ];
    pool = installPoolMock(failingResponses);
    await expect(
      createEnvironmentTemplateDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        templateName: 'standard',
        variables: { FOO: 'bar' },
      }),
    ).rejects.toThrow();
    const sqls = pool.calls.map((c) => c.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('ROLLBACK');
  });
});

describe('setEnvironmentSecretDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('upserts and returns inserted flag', async () => {
    pool = installPoolMock([{ rows: [{ inserted: true }], rowCount: 1 }]);
    const result = await setEnvironmentSecretDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      environment: 'staging',
      key: 'API_KEY',
      encryptedValue: 'e2e-dummy:abc',
    });
    expect(result).toEqual({ inserted: true });
    expect(pool.calls[0].sql).toMatch(/INSERT INTO scoped_secrets/);
    expect(pool.calls[0].params).toEqual(['org1', 'staging', 'API_KEY', 'e2e-dummy:abc']);
  });

  it('rejects missing orgId', async () => {
    pool = installPoolMock([]);
    await expect(
      setEnvironmentSecretDirect('postgresql://u:p@h:5432/d', {
        orgId: '',
        environment: 'staging',
        key: 'x',
        encryptedValue: 'y',
      }),
    ).rejects.toThrow(/orgId required/);
  });

  it('rejects missing environment', async () => {
    pool = installPoolMock([]);
    await expect(
      setEnvironmentSecretDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        environment: '',
        key: 'x',
        encryptedValue: 'y',
      }),
    ).rejects.toThrow(/environment name required/);
  });

  it('rejects missing key', async () => {
    pool = installPoolMock([]);
    await expect(
      setEnvironmentSecretDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        environment: 'staging',
        key: '',
        encryptedValue: 'y',
      }),
    ).rejects.toThrow(/key required/);
  });
});

describe('waitForPlatformRegistrationsDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('returns when the live-connection count reaches minRegistrations', async () => {
    pool = installPoolMock([{ rows: [{ cnt: 3 }], rowCount: 1 }]);
    await waitForPlatformRegistrationsDirect('postgresql://u:p@h:5432/d', 'generic:org1:src-1', {
      minRegistrations: 3,
      timeoutMs: 5_000,
      intervalMs: 100,
    });
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(/FROM webhook_sources ws/);
    expect(pool.calls[0].sql).toMatch(/JOIN platform_connections pc/);
    expect(pool.calls[0].sql).toMatch(/pc\.status = 'connected'/);
    expect(pool.calls[0].params).toEqual(['generic:org1:src-1']);
  });

  it('ignores stale webhook_sources rows without a live platform_connections row', async () => {
    // Scenario: webhook_sources has 4 rows (3 connected + 1 stale from a
    // disconnected orch) — the JOIN to platform_connections reduces the
    // count to 3 so the 4-registration wait times out.
    pool = installPoolMock(Array.from({ length: 20 }, () => ({ rows: [{ cnt: 3 }], rowCount: 1 })));
    await expect(
      waitForPlatformRegistrationsDirect('postgresql://u:p@h:5432/d', 'generic:org1:src-1', {
        minRegistrations: 4,
        timeoutMs: 200,
        intervalMs: 50,
      }),
    ).rejects.toThrow(/Timed out waiting for 4 orchestrator registration/);
  });

  it('throws a descriptive error when timeout elapses with count=0', async () => {
    pool = installPoolMock(Array.from({ length: 20 }, () => ({ rows: [{ cnt: 0 }], rowCount: 1 })));
    await expect(
      waitForPlatformRegistrationsDirect('postgresql://u:p@h:5432/d', 'generic:org1:src-1', {
        minRegistrations: 1,
        timeoutMs: 150,
        intervalMs: 50,
      }),
    ).rejects.toThrow(/generic:org1:src-1/);
  });

  it('excludes the synthetic e2e connection id from the count', async () => {
    pool = installPoolMock([{ rows: [{ cnt: 2 }], rowCount: 1 }]);
    await waitForPlatformRegistrationsDirect('postgresql://u:p@h:5432/d', 'generic:org1:src-1', {
      minRegistrations: 2,
      timeoutMs: 5_000,
    });
    expect(pool.calls[0].sql).toMatch(/orchestrator_connection_id != 'e2e-synthetic'/);
  });
});

// Suppress unused-import warnings if lint is aggressive about the `vi`
// / `beforeEach` imports (they're re-exported to keep future additions
// symmetric with other test files in the monorepo).
void beforeEach;
void vi;
