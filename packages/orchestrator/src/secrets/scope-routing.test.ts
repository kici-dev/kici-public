import { describe, it, expect, vi } from 'vitest';
import { deriveKey, encrypt } from '@kici-dev/shared';
import { createMockDb } from '../__test-helpers__/mock-db.js';
import { PgSecretStore } from './pg-secret-store.js';
import {
  createUnavailableSecretStore,
  loadRoutableStores,
  resolveScope,
  SecretsUnavailableError,
  toWireScope,
  DEFAULT_BACKEND_NAME,
  type ScopedSecretStore,
} from './scope-routing.js';

/** Minimal identifiable stand-in — routing only cares about object identity. */
function fakeStore(id: string): ScopedSecretStore & { id: string } {
  return {
    id,
    listScopes: async () => [],
    listKeys: async () => [],
    setSecret: async () => {},
    deleteSecret: async () => {},
  };
}

describe('resolveScope', () => {
  const pg = fakeStore('pg');
  const vault = fakeStore('vault');
  const stores = new Map<string, ScopedSecretStore>([
    ['pg', pg],
    ['vault', vault],
  ]);

  it('routes a registered qualifier to its backend and strips the prefix', () => {
    const r = resolveScope('vault:aws/prod', stores, pg);
    expect(r.store).toBe(vault);
    expect(r.backendName).toBe('vault');
    expect(r.path).toBe('aws/prod');
    expect(r.qualified).toBe(true);
  });

  it('routes an explicit pg qualifier to the pg backend', () => {
    const r = resolveScope('pg:e2e-encrypted', stores, pg);
    expect(r.store).toBe(pg);
    expect(r.backendName).toBe('pg');
    expect(r.path).toBe('e2e-encrypted');
    expect(r.qualified).toBe(true);
  });

  it('leaves an unqualified scope whole on the default store', () => {
    const r = resolveScope('production', stores, pg);
    expect(r.store).toBe(pg);
    expect(r.backendName).toBe(DEFAULT_BACKEND_NAME);
    expect(r.path).toBe('production');
    expect(r.qualified).toBe(false);
  });

  it('keeps an UNREGISTERED head whole so routing keys stay out of the namespace', () => {
    // `github:42` is a routing key, not a scope. No backend is named `github`,
    // so the whole string stays the path and downstream validation 400s it.
    const r = resolveScope('github:42', stores, pg);
    expect(r.store).toBe(pg);
    expect(r.path).toBe('github:42');
    expect(r.qualified).toBe(false);
  });

  it('treats a leading colon as part of the path, not an empty backend name', () => {
    const empty = new Map<string, ScopedSecretStore>([['', fakeStore('empty')]]);
    const r = resolveScope(':foo', empty, pg);
    expect(r.store).toBe(pg);
    expect(r.path).toBe(':foo');
    expect(r.qualified).toBe(false);
  });

  it('splits on the FIRST colon only, leaving later colons in the path', () => {
    const r = resolveScope('vault:a:b', stores, pg);
    expect(r.store).toBe(vault);
    expect(r.path).toBe('a:b');
  });

  it('yields an empty path for a bare qualifier with nothing after it', () => {
    const r = resolveScope('vault:', stores, pg);
    expect(r.store).toBe(vault);
    expect(r.path).toBe('');
    expect(r.qualified).toBe(true);
  });

  it('falls back to the default store when the map is empty', () => {
    const r = resolveScope('vault:aws/prod', new Map<string, ScopedSecretStore>(), pg);
    expect(r.store).toBe(pg);
    expect(r.path).toBe('vault:aws/prod');
    expect(r.qualified).toBe(false);
  });

  it('honours an overridden default backend name', () => {
    const r = resolveScope('production', stores, vault, 'vault');
    expect(r.backendName).toBe('vault');
    expect(r.qualified).toBe(false);
  });

  it('routes an empty scope to the default store without throwing', () => {
    const r = resolveScope('', stores, pg);
    expect(r.store).toBe(pg);
    expect(r.path).toBe('');
    expect(r.qualified).toBe(false);
  });
});

describe('loadRoutableStores', () => {
  const configured = fakeStore('configured');

  it('OVERRIDES a registry-built default-backend entry with the configured store', async () => {
    // The registry synthesizes its own PgSecretStore for the seeded `pg` row.
    // That instance carries none of the orchestrator's configuration:
    // `customerSecretsEnabled` defaults to true (so it ignores an operator's
    // `pgCustomerSecrets: false`), its key version is hardcoded to 1, and it
    // has no old-master-key fallback. A conditional "inject only when absent"
    // is therefore dead in any real deployment.
    const registryPg = fakeStore('registry-pg');
    const registry = {
      loadAllStores: async () =>
        new Map<string, ScopedSecretStore>([
          ['pg', registryPg],
          ['vault', fakeStore('vault')],
        ]),
    };

    const stores = await loadRoutableStores(registry, {}, configured);

    expect(stores.get('pg')).toBe(configured);
    expect(stores.get('pg')).not.toBe(registryPg);
    expect(stores.get('vault')).toBeDefined();
  });

  it('adds the configured store when the registry returned no default entry', async () => {
    const registry = {
      loadAllStores: async () => new Map<string, ScopedSecretStore>([['vault', fakeStore('v')]]),
    };
    const stores = await loadRoutableStores(registry, {}, configured);
    expect(stores.get(DEFAULT_BACKEND_NAME)).toBe(configured);
  });

  it('yields a default-only map when no registry is configured', async () => {
    const stores = await loadRoutableStores(undefined, {}, configured);
    expect([...stores.keys()]).toEqual([DEFAULT_BACKEND_NAME]);
    expect(stores.get(DEFAULT_BACKEND_NAME)).toBe(configured);
  });

  it('propagates a registry failure instead of degrading to the default store', async () => {
    // A misrouted secret write is worse than a failed one, so a registry
    // outage must fail the request rather than silently route everything to pg.
    const registry = {
      loadAllStores: async () => {
        throw new Error('registry down');
      },
    };
    await expect(loadRoutableStores(registry, {}, configured)).rejects.toThrow('registry down');
  });

  it('honours an overridden default backend name', async () => {
    const registry = { loadAllStores: async () => new Map<string, ScopedSecretStore>() };
    const stores = await loadRoutableStores(registry, {}, configured, 'vault');
    expect(stores.get('vault')).toBe(configured);
    expect(stores.has(DEFAULT_BACKEND_NAME)).toBe(false);
  });
});

describe('loadRoutableStores — the three consequences of routing to the registry-built pg store', () => {
  // The registry builds its default-`pg` store as
  // `new PgSecretStore(db, masterKey, 1, auditLogger)` — no operator toggle, key
  // version hardcoded to 1, no old master key. Each of those is asserted here as
  // an OBSERVABLE difference, because a partial fix (routing correctly for one of
  // them) would otherwise look complete.
  const masterKey = deriveKey('a'.repeat(64));
  const oldMasterKey = deriveKey('b'.repeat(64));
  const auditLogger = { log: vi.fn(), query: vi.fn() } as any;
  const CONFIGURED_KEY_VERSION = 7;

  function stores(db: any) {
    const registryPg = new PgSecretStore(db, masterKey, 1, auditLogger);
    const configured = new PgSecretStore(
      db,
      masterKey,
      CONFIGURED_KEY_VERSION,
      auditLogger,
      oldMasterKey,
    );
    configured.customerSecretsEnabled = false;
    const registry = {
      loadAllStores: async () => new Map<string, PgSecretStore>([['pg', registryPg]]),
    };
    return { registryPg, configured, registry };
  }

  it('1: the operator toggle applies — pgCustomerSecrets:false refuses the write', async () => {
    const { db } = createMockDb({});
    const { registryPg, configured, registry } = stores(db);

    const routed = (await loadRoutableStores(registry, auditLogger, configured)).get('pg')!;

    await expect(routed.setSecret('org-1', 'aws/prod', 'K', 'v')).rejects.toThrow(
      /customer secrets are disabled/i,
    );
    // Positive control: the registry-built store accepts it, which is exactly
    // the bypass this routing prevents.
    await expect(registryPg.setSecret('org-1', 'aws/prod', 'K', 'v')).resolves.toBeUndefined();
  });

  it('2: the old-master-key fallback is reachable through the routed store', async () => {
    const orgId = 'org-1';
    const scope = 'aws/prod';
    // A row written before a master-key rotation: encrypted under the OLD key.
    const stale = encrypt('pre-rotation', oldMasterKey, 3, `${orgId}:${scope}:K`);
    const { db } = createMockDb({
      selectRows: [
        {
          id: 'sec-0',
          org_id: orgId,
          scope,
          key: 'K',
          encrypted_value: stale.data,
          key_version: stale.keyVersion,
        },
      ],
    });
    const { registryPg, configured, registry } = stores(db);

    const routed = (await loadRoutableStores(registry, auditLogger, configured)).get('pg')!;

    await expect(routed.getSecrets(orgId, scope)).resolves.toEqual({ K: 'pre-rotation' });
    // Positive control: the registry-built store has no old key, so the same row
    // is undecryptable through it.
    await expect(registryPg.getSecrets(orgId, scope)).rejects.toThrow();
  });

  it('3: the key version is the resolved one, not the registry hardcoded 1', async () => {
    const { db, mocks } = createMockDb({});
    const { configured, registry } = stores(db);
    configured.customerSecretsEnabled = true;

    const routed = (await loadRoutableStores(registry, auditLogger, configured)).get('pg')!;
    await routed.setSecret('org-1', 'aws/prod', 'K', 'v');

    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ key_version: CONFIGURED_KEY_VERSION }),
    );
  });
});

describe('toWireScope', () => {
  it('round-trips a qualified scope through resolveScope', () => {
    const pg = fakeStore('pg');
    const vault = fakeStore('vault');
    const stores = new Map<string, ScopedSecretStore>([
      ['pg', pg],
      ['vault', vault],
    ]);
    const r = resolveScope('vault:aws/prod', stores, pg);
    expect(toWireScope(r.backendName, r.path)).toBe('vault:aws/prod');
  });

  it('qualifies a bare path with the given backend name', () => {
    expect(toWireScope('pg', 'production')).toBe('pg:production');
  });
});

describe('createUnavailableSecretStore', () => {
  it('reports no scopes and no keys rather than failing', async () => {
    const store = createUnavailableSecretStore();
    await expect(store.listScopes('org-1')).resolves.toEqual([]);
    await expect(store.listKeys('org-1', 'aws/prod')).resolves.toEqual([]);
  });

  it('refuses a set instead of discarding the value', async () => {
    const store = createUnavailableSecretStore();
    await expect(store.setSecret('org-1', 'aws/prod', 'API_KEY', 'v')).rejects.toBeInstanceOf(
      SecretsUnavailableError,
    );
  });

  it('refuses a delete instead of no-oping it', async () => {
    const store = createUnavailableSecretStore();
    await expect(store.deleteSecret('org-1', 'aws/prod', 'API_KEY')).rejects.toBeInstanceOf(
      SecretsUnavailableError,
    );
  });

  it('carries an operator-facing message naming the deployment condition', () => {
    expect(new SecretsUnavailableError().message).toMatch(/unavailable in this deployment/i);
  });

  it('leaves the optional scope methods unimplemented so the write planes refuse them', () => {
    const store = createUnavailableSecretStore();
    expect(store.createScope).toBeUndefined();
    expect(store.renameScope).toBeUndefined();
    expect(store.deleteScope).toBeUndefined();
  });
});
