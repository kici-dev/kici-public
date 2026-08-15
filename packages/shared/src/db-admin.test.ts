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
  waitForPlatformRegistrationsDirect,
  waitForExecutionRunReachesStatusSinceDirect,
  latestExecutionRunByStatusDirect,
  seedCiSecurityFixturesDirect,
  seedWebhookSecretDirect,
  listCheckRunTrackingDirect,
  deleteWorkflowRegistrationsDirect,
} from './db-admin.js';
import { HoldType, unknownContributorHoldReason } from '@kici-dev/engine';

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

describe('deleteWorkflowRegistrationsDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('bumps the registry version after a delete that removed rows', async () => {
    pool = installPoolMock([
      { rows: [], rowCount: 3 }, // DELETE FROM workflow_registrations
      { rows: [], rowCount: 1 }, // UPDATE registry_versions
    ]);
    const result = await deleteWorkflowRegistrationsDirect('postgresql://u:p@h:5432/d', {
      repoIdentifier: 'org/repo',
    });
    expect(result).toEqual({ deleted: 3 });
    expect(pool.calls.map((c) => c.sql)).toEqual([
      'DELETE FROM workflow_registrations WHERE repo_identifier = $1',
      `UPDATE registry_versions SET version = version + 1, updated_at = NOW() WHERE id = 'default'`,
    ]);
    expect(pool.calls[0].params).toEqual(['org/repo']);
    expect(pool.endCalls).toBe(1);
  });

  it('does NOT bump the version when nothing was deleted', async () => {
    pool = installPoolMock([
      { rows: [], rowCount: 0 }, // DELETE FROM workflow_registrations — no match
    ]);
    const result = await deleteWorkflowRegistrationsDirect('postgresql://u:p@h:5432/d', {
      routingKey: 'generic:org:src',
    });
    expect(result).toEqual({ deleted: 0 });
    expect(pool.calls.map((c) => c.sql)).toEqual([
      'DELETE FROM workflow_registrations WHERE routing_key = $1',
    ]);
  });
});

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

describe('waitForExecutionRunReachesStatusSinceDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  it('returns the first status in the set that appears (polls until a match)', async () => {
    // First poll: no terminal run yet. Second poll: the run reached success.
    pool = installPoolMock([{ rows: [] }, { rows: [{ status: 'success' }] }]);
    const since = new Date('2026-07-17T00:00:00.000Z');
    const result = await waitForExecutionRunReachesStatusSinceDirect('postgresql://u:p@h:5432/db', {
      since,
      statuses: ['success', 'failed', 'cancelled'],
      timeoutMs: 1_000,
      intervalMs: 5,
    });
    expect(result).toEqual({ status: 'success' });
    // SQL binds `since` as $1 and the status array as $2.
    expect(pool.calls[0].sql).toMatch(/started_at > \$1/);
    expect(pool.calls[0].sql).toMatch(/status = ANY\(\$2\)/);
    expect(pool.calls[0].params).toEqual([since, ['success', 'failed', 'cancelled']]);
    expect(pool.endCalls).toBe(1);
  });

  it('surfaces a terminal failure fast (returns the failed status, not null)', async () => {
    pool = installPoolMock([{ rows: [{ status: 'failed' }] }]);
    const result = await waitForExecutionRunReachesStatusSinceDirect('postgresql://u:p@h:5432/db', {
      since: new Date('2026-07-17T00:00:00.000Z'),
      statuses: ['success', 'failed', 'cancelled'],
      timeoutMs: 1_000,
      intervalMs: 5,
    });
    expect(result).toEqual({ status: 'failed' });
  });

  it('returns { status: null } when no run reaches a target status before the deadline', async () => {
    // Every poll comes back empty; the loop must give up at the deadline.
    pool = installPoolMock(Array.from({ length: 50 }, () => ({ rows: [] })));
    const result = await waitForExecutionRunReachesStatusSinceDirect('postgresql://u:p@h:5432/db', {
      since: new Date('2026-07-17T00:00:00.000Z'),
      statuses: ['success', 'failed', 'cancelled'],
      timeoutMs: 30,
      intervalMs: 5,
    });
    expect(result).toEqual({ status: null });
    expect(pool.endCalls).toBe(1);
  });

  // A `since` window alone cannot identify a run: a neighbouring workflow that
  // happens to reach a terminal state inside the same window is indistinguishable
  // from the caller's own. `deliveryId` is the exact identity the caller controls.
  it('scopes the poll to one delivery when deliveryId is given', async () => {
    pool = installPoolMock([{ rows: [{ status: 'success' }] }]);
    const since = new Date('2026-07-17T00:00:00.000Z');
    const result = await waitForExecutionRunReachesStatusSinceDirect('postgresql://u:p@h:5432/db', {
      since,
      statuses: ['success', 'failed', 'cancelled'],
      deliveryId: 'e2e-my-test-abc',
      timeoutMs: 1_000,
      intervalMs: 5,
    });
    expect(result).toEqual({ status: 'success' });
    expect(pool.calls[0].sql).toMatch(/delivery_id LIKE \$3/);
    expect(pool.calls[0].params).toEqual([
      since,
      ['success', 'failed', 'cancelled'],
      '%e2e-my-test-abc',
    ]);
  });

  it('omits the delivery predicate entirely when no deliveryId is given', async () => {
    pool = installPoolMock([{ rows: [{ status: 'success' }] }]);
    await waitForExecutionRunReachesStatusSinceDirect('postgresql://u:p@h:5432/db', {
      since: new Date('2026-07-17T00:00:00.000Z'),
      statuses: ['success'],
      timeoutMs: 1_000,
      intervalMs: 5,
    });
    expect(pool.calls[0].sql).not.toMatch(/delivery_id/);
    expect(pool.calls[0].params).toHaveLength(2);
  });
});

describe('latestExecutionRunByStatusDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  // Same hazard as the poll above: "the newest success run" is not necessarily
  // the caller's, so the run_id it hands back can belong to another test.
  it('scopes to one delivery when deliveryId is given', async () => {
    pool = installPoolMock([
      { rows: [{ run_id: 'r1', workflow_name: 'wf', status: 'success' }] },
      { rows: [{ job_id: 'j1', job_name: 'build', status: 'success' }] },
    ]);
    const result = await latestExecutionRunByStatusDirect('postgresql://u:p@h:5432/db', {
      status: 'success',
      deliveryId: 'e2e-my-test-abc',
    });
    expect(result?.run.run_id).toBe('r1');
    expect(pool.calls[0].sql).toMatch(/delivery_id LIKE \$2/);
    expect(pool.calls[0].params).toEqual(['success', '%e2e-my-test-abc']);
  });

  it('omits the delivery predicate when no deliveryId is given', async () => {
    pool = installPoolMock([
      { rows: [{ run_id: 'r1', workflow_name: 'wf', status: 'success' }] },
      { rows: [] },
    ]);
    await latestExecutionRunByStatusDirect('postgresql://u:p@h:5432/db', { status: 'success' });
    expect(pool.calls[0].sql).not.toMatch(/delivery_id/);
    expect(pool.calls[0].params).toEqual(['success']);
  });
});

describe('seedCiSecurityFixturesDirect', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  /**
   * The helper issues exactly 19 queries in a fixed order: the sources upsert,
   * the contexts upsert, then three per seeded hold (execution_runs,
   * execution_jobs, held_runs) for holds A–E, then the trusted run's
   * execution_runs + execution_jobs pair. The mock replays responses
   * positionally, so the count and order matter — if the helper's query order
   * shifts, correct this fixture rather than loosening the assertions.
   */
  const RESPONSES = [
    { rows: [] }, // INSERT INTO sources
    { rows: [{ id: 'env-ci-sec' }] }, // INSERT INTO contexts RETURNING id
    ...Array.from({ length: 5 }, () => [
      { rows: [] }, // INSERT INTO execution_runs
      { rows: [] }, // INSERT INTO execution_jobs
      { rows: [{ id: 'held-x' }] }, // INSERT INTO held_runs RETURNING id
    ]).flat(),
    { rows: [] }, // trusted INSERT INTO execution_runs
    { rows: [] }, // trusted INSERT INTO execution_jobs
  ];

  const OPTS = {
    orgId: 'org1',
    runsRoutingKey: 'generic:org1:runs',
    unknownRunId: 'run-unknown',
    unknownDeliveryId: 'del-unknown',
    unknownJobId: 'job-unknown',
    trustedRunId: 'run-trusted',
    trustedDeliveryId: 'del-trusted',
    trustedJobId: 'job-trusted',
    secondPrRunId: 'run-second',
    secondPrDeliveryId: 'del-second',
    secondPrJobId: 'job-second',
    otherRepoRunId: 'run-other',
    otherRepoDeliveryId: 'del-other',
    otherRepoJobId: 'job-other',
    wfModRunId: 'run-wfmod',
    wfModDeliveryId: 'del-wfmod',
    wfModJobId: 'job-wfmod',
    forkPrRunId: 'run-forkpr',
    forkPrDeliveryId: 'del-forkpr',
    forkPrJobId: 'job-forkpr',
  };

  /** The `hold_type` bind param of every `held_runs` insert, in seed order. */
  function seededHoldTypes(calls: QueryCall[]): unknown[] {
    return calls.filter((c) => /INSERT INTO held_runs/.test(c.sql)).map((c) => c.params[4]); // ($1 org, $2 run, $3 job, $4 context, $5 hold_type)
  }

  it('seeds every hold with a hold type production can actually emit', async () => {
    pool = installPoolMock(RESPONSES);
    await seedCiSecurityFixturesDirect('postgresql://u:p@h:5432/d', OPTS);

    const holdTypes = seededHoldTypes(pool.calls);
    expect(holdTypes).toHaveLength(5);
    // Every seeded value must be in the engine gate vocabulary — a fixture that
    // seeds a spelling no gate writes proves nothing about real behavior. This
    // is the assertion that fails if the vocabulary ever changes underneath the
    // fixture, which is the point of pinning it here.
    for (const holdType of holdTypes) {
      expect(HoldType.options).toContain(holdType);
    }
    // All five are security-queue holds, so all five carry the security gate's
    // hold type; the per-hold detail lives in `reason`, a different column.
    expect(holdTypes).toEqual(Array(5).fill(HoldType.enum.security));
  });

  it('seeds a hold reason the trust gate can actually produce', async () => {
    pool = installPoolMock(RESPONSES);
    const result = await seedCiSecurityFixturesDirect('postgresql://u:p@h:5432/d', OPTS);

    // Holds A/B/C are unknown-contributor security holds, so their `reason` is
    // the trust gate's own templated sentence, read from the same shared engine
    // template the gate emits — not a fixture-local literal. Holds D and E are
    // the workflow-modification and fork-PR holds, whose reasons are the slugs
    // the dispatch path persists.
    const reasons = pool.calls
      .filter((c) => /INSERT INTO held_runs/.test(c.sql))
      .map((c) => c.params[5]);
    expect(reasons).toEqual([
      unknownContributorHoldReason(result.contextName),
      unknownContributorHoldReason(result.contextName),
      unknownContributorHoldReason(result.contextName),
      'workflow_modification',
      'fork_pr',
    ]);
  });

  it('returns the context name it seeded', async () => {
    pool = installPoolMock(RESPONSES);
    const result = await seedCiSecurityFixturesDirect('postgresql://u:p@h:5432/d', OPTS);

    // The returned name is what assertions build the expected reason from, so a
    // caller overriding `contextName` can never desync them.
    expect(result.contextName).toBe('ci-security-env');
  });

  it('threads a caller-supplied contextName into both the seeded reason and the result', async () => {
    pool = installPoolMock(RESPONSES);
    const result = await seedCiSecurityFixturesDirect('postgresql://u:p@h:5432/d', {
      ...OPTS,
      contextName: 'custom-ci-security-ctx',
    });

    // Expectations are built from the literal override, not from
    // `result.contextName` — a seeder that ignored the override (or returned a
    // hardcoded default) fails here, which the default-path tests above cannot
    // detect because the default and the hardcode are the same string.
    expect(result.contextName).toBe('custom-ci-security-ctx');
    const contextsInsert = pool.calls.find((c) => /INSERT INTO contexts/.test(c.sql));
    expect(contextsInsert?.params[1]).toBe('custom-ci-security-ctx');
    const reasons = pool.calls
      .filter((c) => /INSERT INTO held_runs/.test(c.sql))
      .map((c) => c.params[5]);
    expect(reasons.slice(0, 3)).toEqual(
      Array(3).fill(unknownContributorHoldReason('custom-ci-security-ctx')),
    );
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

/**
 * The org a seeded source belongs to.
 *
 * `sources.customer_id` carries a column DEFAULT of `'__default__'`, so a seed
 * that omits the org does not leave the column unset — it lands the row on the
 * plane's no-tenant anchor. `resolveOrgId` then reports `'__default__'` for
 * every event on that routing key, and the org-scoped decisions downstream
 * (global-workflow registration, the multi-provider lock fallback) deny with a
 * reason that names the anchor rather than the seed that produced it. That is
 * the whole distance between the defect and its symptom, which is why the org
 * has to be written where the row is created rather than repaired afterwards.
 */
describe('seedWebhookSecretDirect customer_id', () => {
  let pool: ReturnType<typeof installPoolMock>;
  afterEach(() => pool?.restore());

  const OPTS = {
    routingKey: 'github:2848097',
    webhookSecret: 'whsec',
    encryptFn: () => 'ciphertext',
  };

  /** The bind params of the single `INSERT INTO sources` the helper issues. */
  function sourceInsertParams(calls: QueryCall[]): unknown[] {
    const insert = calls.find((c) => /INSERT INTO sources/.test(c.sql));
    if (!insert) throw new Error('no INSERT INTO sources issued');
    return insert.params;
  }

  it('writes customer_id when it creates the sources row', async () => {
    pool = installPoolMock([
      { rows: [] }, // SELECT id FROM sources -> absent
      { rows: [] }, // INSERT INTO sources
      { rows: [{ id: 'src-1' }] }, // refetch
      { rows: [] }, // INSERT INTO scoped_secrets
    ]);

    await seedWebhookSecretDirect('postgresql://u:p@h:5432/d', {
      ...OPTS,
      customerId: 'org_kiciStg00001',
    });

    const insert = pool.calls.find((c) => /INSERT INTO sources/.test(c.sql))!;
    expect(insert.sql).toMatch(/customer_id/);
    expect(sourceInsertParams(pool.calls)).toContain('org_kiciStg00001');
  });

  it('omits customer_id entirely when no org is given', async () => {
    // The non-vacuity control for the case above AND the compatibility
    // guarantee for the one caller that genuinely has no org: the column must
    // fall through to its DEFAULT rather than being bound to undefined, which
    // pg would send as NULL against a NOT NULL column.
    pool = installPoolMock([{ rows: [] }, { rows: [] }, { rows: [{ id: 'src-1' }] }, { rows: [] }]);

    await seedWebhookSecretDirect('postgresql://u:p@h:5432/d', OPTS);

    const insert = pool.calls.find((c) => /INSERT INTO sources/.test(c.sql))!;
    expect(insert.sql).not.toMatch(/customer_id/);
    expect(insert.params).toHaveLength(5);
  });

  it('repairs an existing row that is still on the default anchor', async () => {
    // The path that actually reaches a live staging DB. A warm E2E start finds
    // the source row already there — created by an earlier cold start that had
    // no org to write — so an insert-time-only fix would never take effect and
    // the row would stay on the anchor across every subsequent run.
    pool = installPoolMock([
      { rows: [{ id: 'src-existing' }] }, // SELECT id FROM sources -> present
      { rows: [] }, // UPDATE sources SET customer_id
      { rows: [] }, // INSERT INTO scoped_secrets
    ]);

    await seedWebhookSecretDirect('postgresql://u:p@h:5432/d', {
      ...OPTS,
      customerId: 'org_kiciStg00001',
    });

    const update = pool.calls.find((c) => /UPDATE sources/.test(c.sql));
    expect(update, 'an existing source row was left on whatever org it had').toBeDefined();
    expect(update!.params).toEqual(['org_kiciStg00001', 'github:2848097']);
    // No insert — the row already existed.
    expect(pool.calls.some((c) => /INSERT INTO sources/.test(c.sql))).toBe(false);
  });

  it('repairs the conflicting row when the insert races another seed', async () => {
    // The SELECT found nothing, so the reassert branch above was skipped — but
    // a concurrent seed can still win the insert. `DO NOTHING` would leave that
    // winner on whatever org it had, which is the exact hole the reassert
    // exists to close, reachable only through the race.
    pool = installPoolMock([{ rows: [] }, { rows: [] }, { rows: [{ id: 'src-1' }] }, { rows: [] }]);

    await seedWebhookSecretDirect('postgresql://u:p@h:5432/d', {
      ...OPTS,
      customerId: 'org_kiciStg00001',
    });

    const insert = pool.calls.find((c) => /INSERT INTO sources/.test(c.sql))!;
    expect(insert.sql).toMatch(/ON CONFLICT \(routing_key\) DO UPDATE SET customer_id/);
    expect(insert.sql).toMatch(/EXCLUDED\.customer_id/);
  });

  it('leaves a conflicting row alone when no org is given', async () => {
    // Control for the case above: with no org there is nothing to reassert, so
    // the conflict arm must stay a no-op rather than writing a NULL over a
    // NOT NULL column.
    pool = installPoolMock([{ rows: [] }, { rows: [] }, { rows: [{ id: 'src-1' }] }, { rows: [] }]);

    await seedWebhookSecretDirect('postgresql://u:p@h:5432/d', OPTS);

    const insert = pool.calls.find((c) => /INSERT INTO sources/.test(c.sql))!;
    expect(insert.sql).toMatch(/ON CONFLICT \(routing_key\) DO NOTHING/);
    expect(insert.sql).not.toMatch(/DO UPDATE/);
  });

  it('bumps updated_at when it repairs an existing row', async () => {
    // Matches the CLI's own `kici-admin source update --customer-id`, which
    // sets `updated_at = now()` alongside the org. A repair that leaves the
    // timestamp stale makes the row read as untouched since its last real edit.
    pool = installPoolMock([{ rows: [{ id: 'src-existing' }] }, { rows: [] }, { rows: [] }]);

    await seedWebhookSecretDirect('postgresql://u:p@h:5432/d', {
      ...OPTS,
      customerId: 'org_kiciStg00001',
    });

    const update = pool.calls.find((c) => /UPDATE sources/.test(c.sql))!;
    expect(update.sql).toMatch(/updated_at = now\(\)/);
  });

  it('leaves an existing row untouched when no org is given', async () => {
    // Control for the repair above: the update is driven by the caller
    // supplying an org, not by the row existing.
    pool = installPoolMock([{ rows: [{ id: 'src-existing' }] }, { rows: [] }]);

    await seedWebhookSecretDirect('postgresql://u:p@h:5432/d', OPTS);

    expect(pool.calls.some((c) => /UPDATE sources/.test(c.sql))).toBe(false);
  });
});

// Suppress unused-import warnings if lint is aggressive about the `vi`
// / `beforeEach` imports (they're re-exported to keep future additions
// symmetric with other test files in the monorepo).
void beforeEach;
void vi;
