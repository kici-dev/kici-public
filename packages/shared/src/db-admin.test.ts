import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Migration, MigrationProvider } from 'kysely/migration';
import pg from 'pg';
import {
  computeMigrationsHash,
  ensureDatabase,
  maskDatabaseUrl,
  parseDatabaseUrl,
  seedContextDirect,
  deleteContextDirect,
  purgeContextsDirect,
  seedContextBindingDirect,
  setContextPolicyDirect,
  listContextsDirect,
  showContextDirect,
  createContextTemplateDirect,
  setContextSecretDirect,
  listCheckRunTrackingDirect,
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

// ── context *Direct helpers ──────────────────────────────────────────
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

describe('purgeContextsDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('deletes held_runs then contexts scoped to an org, in a transaction', async () => {
    pool = installPoolMock([
      { rows: [], rowCount: 1 }, // DELETE FROM held_runs
      { rows: [], rowCount: 2 }, // DELETE FROM contexts
    ]);
    const result = await purgeContextsDirect('postgresql://u:p@h:5432/d', 'orgA');
    expect(result).toEqual({ contextsDeleted: 2, heldRunsDeleted: 1 });
    expect(pool.calls.map((c) => c.sql)).toEqual([
      'BEGIN',
      'DELETE FROM held_runs WHERE org_id = $1',
      'DELETE FROM contexts WHERE org_id = $1',
      'COMMIT',
    ]);
    expect(pool.calls[1].params).toEqual(['orgA']);
    expect(pool.calls[2].params).toEqual(['orgA']);
    expect(pool.endCalls).toBe(1);
  });

  it('purges all orgs (no WHERE clause, empty params) when orgId is omitted', async () => {
    pool = installPoolMock([
      { rows: [], rowCount: 0 }, // DELETE FROM held_runs
      { rows: [], rowCount: 5 }, // DELETE FROM contexts
    ]);
    const result = await purgeContextsDirect('postgresql://u:p@h:5432/d');
    expect(result).toEqual({ contextsDeleted: 5, heldRunsDeleted: 0 });
    expect(pool.calls.map((c) => c.sql)).toEqual([
      'BEGIN',
      'DELETE FROM held_runs ',
      'DELETE FROM contexts ',
      'COMMIT',
    ]);
    expect(pool.calls[1].params).toEqual([]);
    expect(pool.calls[2].params).toEqual([]);
  });
});

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

describe('seedContextDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('upserts and returns the envId + created flag', async () => {
    pool = installPoolMock([{ rows: [{ id: 'env-123', inserted: true }], rowCount: 1 }]);
    const result = await seedContextDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'staging',
      type: 'fixed',
      branchRestrictions: ['main'],
      requiredReviewers: ['user-a'],
    });
    expect(result).toEqual({ envId: 'env-123', created: true });
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(/INSERT INTO contexts/);
    expect(pool.calls[0].params[0]).toBe('org1');
    expect(pool.calls[0].params[1]).toBe('staging');
    expect(pool.calls[0].params[4]).toBe(JSON.stringify(['main']));
    expect(pool.calls[0].params[5]).toBe(JSON.stringify(['user-a']));
    expect(pool.endCalls).toBe(1);
  });

  it('rejects negative waitTimerSeconds', async () => {
    pool = installPoolMock([]);
    await expect(
      seedContextDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        name: 'staging',
        waitTimerSeconds: -1,
      }),
    ).rejects.toThrow(/waitTimerSeconds must be >= 0/);
  });

  it('rejects negative holdExpirySeconds', async () => {
    pool = installPoolMock([]);
    await expect(
      seedContextDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        name: 'staging',
        holdExpirySeconds: -1,
      }),
    ).rejects.toThrow(/holdExpirySeconds must be >= 1/);
  });

  it('rejects a zero holdExpirySeconds', async () => {
    // A stored 0 puts every hold's deadline at the current instant, so the
    // hold is swept to `expired` before a reviewer can act.
    pool = installPoolMock([]);
    await expect(
      seedContextDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        name: 'staging',
        holdExpirySeconds: 0,
      }),
    ).rejects.toThrow(/holdExpirySeconds must be >= 1/);
  });

  it('serialises empty branch restrictions as []', async () => {
    pool = installPoolMock([{ rows: [{ id: 'env-1', inserted: true }], rowCount: 1 }]);
    await seedContextDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'prod',
    });
    expect(pool.calls[0].params[4]).toBe('[]');
    expect(pool.calls[0].params[5]).toBeNull();
  });

  it('passes globPattern through to the glob_pattern column', async () => {
    pool = installPoolMock([{ rows: [{ id: 'env-9', inserted: true }], rowCount: 1 }]);
    await seedContextDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'review',
      type: 'glob',
      globPattern: 'review/*',
    });
    expect(pool.calls[0].sql).toMatch(/glob_pattern/);
    expect(pool.calls[0].params).toContain('review/*');
  });

  it('writes an omitted hold expiry as NULL rather than a create-time literal', async () => {
    // The column carries no DDL default, so "never set" must land NULL and
    // resolve through DEFAULT_HOLD_EXPIRY_SECONDS on read. A COALESCE literal
    // here gave this path its own longer default that no reader knew about.
    pool = installPoolMock([{ rows: [{ id: 'env-2', inserted: true }], rowCount: 1 }]);
    await seedContextDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'prod',
    });
    expect(pool.calls[0].params[7]).toBeNull();
    expect(pool.calls[0].sql).not.toMatch(/86400/);
  });

  it('passes an explicit hold expiry through unchanged', async () => {
    pool = installPoolMock([{ rows: [{ id: 'env-3', inserted: true }], rowCount: 1 }]);
    await seedContextDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'prod',
      holdExpirySeconds: 900,
    });
    expect(pool.calls[0].params[7]).toBe(900);
  });
});

describe('deleteContextDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('pre-checks pending held runs, then deletes by org+name', async () => {
    pool = installPoolMock([
      { rows: [{ count: '0' }], rowCount: 1 },
      { rows: [{ id: 'env-1' }], rowCount: 1 },
    ]);
    const result = await deleteContextDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'staging',
    });
    expect(result).toEqual({ deleted: true });
    expect(pool.calls[0].sql).toMatch(/held_runs/);
    expect(pool.calls[0].params).toEqual(['org1', 'staging']);
    expect(pool.calls[1].sql).toMatch(/DELETE FROM contexts/);
    expect(pool.calls[1].params).toEqual(['org1', 'staging']);
    expect(pool.endCalls).toBe(1);
  });

  it('reports deleted=false when no row matched', async () => {
    pool = installPoolMock([
      { rows: [{ count: '0' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const result = await deleteContextDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'missing',
    });
    expect(result).toEqual({ deleted: false });
    expect(pool.endCalls).toBe(1);
  });

  it('throws and skips the DELETE when pending held runs exist', async () => {
    pool = installPoolMock([{ rows: [{ count: '3' }], rowCount: 1 }]);
    await expect(
      deleteContextDirect('postgresql://u:p@h:5432/d', { orgId: 'org1', name: 'staging' }),
    ).rejects.toThrow(/3 pending held run/);
    // Only the pre-check query ran — the DELETE was never issued.
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0].sql).toMatch(/held_runs/);
    expect(pool.endCalls).toBe(1);
  });
});

describe('seedContextBindingDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('looks up the env id, then inserts the binding', async () => {
    pool = installPoolMock([
      { rows: [{ id: 'env-abc' }], rowCount: 1 },
      { rows: [{ inserted: true }], rowCount: 1 },
    ]);
    const result = await seedContextBindingDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      contextName: 'staging',
      scopePattern: 'staging',
    });
    expect(result).toEqual({ created: true });
    expect(pool.calls[0].sql).toMatch(/SELECT id FROM contexts/);
    expect(pool.calls[1].sql).toMatch(/INSERT INTO context_bindings/);
    // host_pattern defaults to '**' (all hosts) when no --host selector is given.
    expect(pool.calls[1].params).toEqual(['org1', 'env-abc', 'staging', '**']);
  });

  it('throws when the context is missing', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 0 }]);
    await expect(
      seedContextBindingDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        contextName: 'missing',
        scopePattern: 'missing',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('returns created=false when the binding already existed', async () => {
    pool = installPoolMock([
      { rows: [{ id: 'env-abc' }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const result = await seedContextBindingDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      contextName: 'staging',
      scopePattern: 'staging',
    });
    expect(result).toEqual({ created: false });
  });
});

describe('setContextPolicyDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('updates only explicitly-provided fields', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 1 }]);
    await setContextPolicyDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      contextName: 'staging',
      waitTimerSeconds: 60,
      minimumTrust: 'verified',
    });
    const call = pool.calls[0];
    expect(call.sql).toMatch(/UPDATE contexts/);
    expect(call.sql).toMatch(/wait_timer_seconds = \$1/);
    expect(call.sql).toMatch(/minimum_trust = \$2/);
    expect(call.sql).not.toMatch(/branch_restrictions/);
    expect(call.sql).not.toMatch(/required_reviewers/);
    expect(call.params).toEqual([60, 'verified', 'org1', 'staging']);
  });

  it('throws when no policy fields are supplied', async () => {
    pool = installPoolMock([]);
    await expect(
      setContextPolicyDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        contextName: 'staging',
      }),
    ).rejects.toThrow(/at least one policy field/);
  });

  it('rejects negative waitTimerSeconds', async () => {
    pool = installPoolMock([]);
    await expect(
      setContextPolicyDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        contextName: 'staging',
        waitTimerSeconds: -5,
      }),
    ).rejects.toThrow(/waitTimerSeconds must be >= 0/);
  });

  it('throws when env not found (rowCount 0)', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 0 }]);
    await expect(
      setContextPolicyDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        contextName: 'missing',
        waitTimerSeconds: 10,
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('listContextsDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('returns all contexts for the given org ordered by name', async () => {
    pool = installPoolMock([
      {
        rows: [
          { id: 'env-1', org_id: 'org1', name: 'prod', type: 'fixed', enabled: true },
          { id: 'env-2', org_id: 'org1', name: 'staging', type: 'fixed', enabled: true },
        ],
        rowCount: 2,
      },
    ]);
    const result = await listContextsDirect('postgresql://u:p@h:5432/d', { orgId: 'org1' });
    expect(result.contexts).toHaveLength(2);
    expect(pool.calls[0].sql).toMatch(
      /SELECT .* FROM contexts\s+WHERE org_id = \$1\s+ORDER BY name/s,
    );
    expect(pool.calls[0].params).toEqual(['org1']);
  });
});

describe('showContextDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('returns context + variables + bindings', async () => {
    pool = installPoolMock([
      {
        rows: [{ id: 'env-1', org_id: 'org1', name: 'staging', type: 'fixed', enabled: true }],
        rowCount: 1,
      },
      { rows: [{ key: 'API_URL', value: 'https://x', locked: false }], rowCount: 1 },
      { rows: [{ scope_pattern: 'staging' }], rowCount: 1 },
    ]);
    const result = await showContextDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      name: 'staging',
    });
    expect(result.context.id).toBe('env-1');
    expect(result.variables).toHaveLength(1);
    expect(result.bindings).toHaveLength(1);
    expect(pool.calls[1].params).toEqual(['env-1']);
    expect(pool.calls[2].params).toEqual(['env-1']);
  });

  it('throws when the context is missing', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 0 }]);
    await expect(
      showContextDirect('postgresql://u:p@h:5432/d', { orgId: 'org1', name: 'missing' }),
    ).rejects.toThrow(/not found/);
  });
});

describe('createContextTemplateDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('creates the template row in a transaction and seeds variables', async () => {
    pool = installPoolMock([
      { rows: [{ id: 'tpl-1', inserted: true }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const result = await createContextTemplateDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      templateName: 'standard',
      variables: { FOO: 'bar', BAZ: 'qux' },
    });
    expect(result).toEqual({ envId: 'tpl-1', created: true, variablesSet: 2 });
    const sqls = pool.calls.map((c) => c.sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('COMMIT');
    expect(sqls.filter((s) => /INSERT INTO context_variables/.test(s))).toHaveLength(2);
  });

  it('writes an omitted hold expiry as NULL rather than a create-time literal', async () => {
    // Same invariant as seedContextDirect: no DDL default on the column, so a
    // template created without an expiry must land NULL and resolve through
    // DEFAULT_HOLD_EXPIRY_SECONDS.
    pool = installPoolMock([
      { rows: [{ id: 'tpl-2', inserted: true }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    await createContextTemplateDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      templateName: 'standard',
    });
    const insert = pool.calls.find((c) => /INSERT INTO contexts/.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert!.params[6]).toBeNull();
    expect(insert!.sql).not.toMatch(/86400/);
  });

  it('rolls back on failure', async () => {
    const failingResponses: MockQueryResult[] = [
      { rows: [{ id: 'tpl-1', inserted: true }], rowCount: 1 },
    ];
    pool = installPoolMock(failingResponses);
    await expect(
      createContextTemplateDirect('postgresql://u:p@h:5432/d', {
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

describe('setContextSecretDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('upserts and returns inserted flag', async () => {
    pool = installPoolMock([{ rows: [{ inserted: true }], rowCount: 1 }]);
    const result = await setContextSecretDirect('postgresql://u:p@h:5432/d', {
      orgId: 'org1',
      context: 'staging',
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
      setContextSecretDirect('postgresql://u:p@h:5432/d', {
        orgId: '',
        context: 'staging',
        key: 'x',
        encryptedValue: 'y',
      }),
    ).rejects.toThrow(/orgId required/);
  });

  it('rejects missing context', async () => {
    pool = installPoolMock([]);
    await expect(
      setContextSecretDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        context: '',
        key: 'x',
        encryptedValue: 'y',
      }),
    ).rejects.toThrow(/context name required/);
  });

  it('rejects missing key', async () => {
    pool = installPoolMock([]);
    await expect(
      setContextSecretDirect('postgresql://u:p@h:5432/d', {
        orgId: 'org1',
        context: 'staging',
        key: '',
        encryptedValue: 'y',
      }),
    ).rejects.toThrow(/key required/);
  });
});

describe('listCheckRunTrackingDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('returns tracking rows for a sha, ordered by check name', async () => {
    pool = installPoolMock([
      {
        rows: [
          {
            provider: 'github',
            owner: 'kici-dev',
            repo: 'test-repo',
            sha: 'abc123',
            check_name: 'kici/e2e-test',
            check_run_id: '42',
            build_creation_state: 'completed',
            run_id: 'run-1',
            in_progress_sent_at: null,
          },
        ],
        rowCount: 1,
      },
    ]);
    const { rows } = await listCheckRunTrackingDirect('postgresql://u:p@h:5432/d', {
      sha: 'abc123',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].check_run_id).toBe('42');
    expect(rows[0].build_creation_state).toBe('completed');
    expect(pool.calls[0].sql).toMatch(
      /SELECT .* FROM check_run_tracking\s+WHERE sha = \$1\s+ORDER BY check_name/s,
    );
    expect(pool.calls[0].params).toEqual(['abc123']);
    expect(pool.endCalls).toBe(1);
  });

  // A null check_run_id is NOT proof the post failed — build_creation_state is
  // 'pending' while a create is still in flight, so the command cannot answer
  // "did we post it?" without selecting both.
  it('selects build_creation_state so an in-flight create is distinguishable', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 0 }]);
    await listCheckRunTrackingDirect('postgresql://u:p@h:5432/d', { sha: 'abc123' });
    expect(pool.calls[0].sql).toMatch(/build_creation_state/);
  });

  // The column is BIGINT; node-postgres maps int8 to a string. The `::text`
  // cast pins that at the query level so the declared type stays true even if a
  // global int8 type parser is added later.
  it('selects check_run_id as text so the BIGINT never arrives as a lossy number', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 0 }]);
    await listCheckRunTrackingDirect('postgresql://u:p@h:5432/d', { sha: 'abc123' });
    expect(pool.calls[0].sql).toMatch(/check_run_id::text AS check_run_id/);
  });

  it('filters by check name when given', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 0 }]);
    await listCheckRunTrackingDirect('postgresql://u:p@h:5432/d', {
      sha: 'abc123',
      checkName: 'kici/e2e-test',
    });
    expect(pool.calls[0].sql).toMatch(/WHERE sha = \$1 AND check_name = \$2/);
    expect(pool.calls[0].params).toEqual(['abc123', 'kici/e2e-test']);
  });

  it('defaults the limit to 50 and clamps an oversized one to 1000', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 0 }]);
    await listCheckRunTrackingDirect('postgresql://u:p@h:5432/d', { sha: 'abc123' });
    expect(pool.calls[0].sql).toMatch(/LIMIT 50/);
    pool.restore();

    pool = installPoolMock([{ rows: [], rowCount: 0 }]);
    await listCheckRunTrackingDirect('postgresql://u:p@h:5432/d', { sha: 'abc123', limit: 99_999 });
    expect(pool.calls[0].sql).toMatch(/LIMIT 1000/);
  });

  it('closes the pool even when the query throws', async () => {
    pool = installPoolMock([]);
    await expect(
      listCheckRunTrackingDirect('postgresql://u:p@h:5432/d', { sha: 'abc123' }),
    ).rejects.toThrow(/no response queued/);
    expect(pool.endCalls).toBe(1);
  });

  // `check_run_id` answers "did we create it?"; only `terminal_sent_at`
  // answers "did we complete it?". Selecting it is what makes the command able
  // to attribute a check run that never left `queued`.
  it('selects terminal_sent_at so a completed update is distinguishable', async () => {
    pool = installPoolMock([{ rows: [], rowCount: 0 }]);
    await listCheckRunTrackingDirect('postgresql://u:p@h:5432/d', { sha: 'abc123' });
    expect(pool.calls[0].sql).toMatch(/terminal_sent_at/);
  });

  it('returns terminal_sent_at for a completed check run', async () => {
    pool = installPoolMock([
      {
        rows: [
          {
            provider: 'github',
            owner: 'kici-dev',
            repo: 'test-repo',
            sha: 'abc123',
            check_name: 'kici/e2e-test',
            check_run_id: '42',
            build_creation_state: 'completed',
            run_id: 'run-1',
            in_progress_sent_at: null,
            terminal_sent_at: new Date('2026-08-04T00:00:00.000Z'),
          },
        ],
        rowCount: 1,
      },
    ]);
    const { rows } = await listCheckRunTrackingDirect('postgresql://u:p@h:5432/d', {
      sha: 'abc123',
    });
    expect(rows[0].terminal_sent_at?.toISOString()).toBe('2026-08-04T00:00:00.000Z');
  });

  it('returns a null terminal_sent_at for a check run that was only created', async () => {
    pool = installPoolMock([
      {
        rows: [
          {
            provider: 'github',
            owner: 'kici-dev',
            repo: 'test-repo',
            sha: 'abc123',
            check_name: 'kici/e2e-test',
            check_run_id: '42',
            build_creation_state: 'completed',
            run_id: 'run-1',
            in_progress_sent_at: null,
            terminal_sent_at: null,
          },
        ],
        rowCount: 1,
      },
    ]);
    const { rows } = await listCheckRunTrackingDirect('postgresql://u:p@h:5432/d', {
      sha: 'abc123',
    });
    expect(rows[0].check_run_id).toBe('42');
    expect(rows[0].terminal_sent_at).toBeNull();
  });
});

// Suppress unused-import warnings if lint is aggressive about the `vi`
// / `beforeEach` imports (they're re-exported to keep future additions
// symmetric with other test files in the monorepo).
void beforeEach;
void vi;
