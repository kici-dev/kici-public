import { describe, it, expect } from 'vitest';
import {
  CACHE_MAX_ENTRIES_CEILING,
  ClusterSettingsReader,
  clampCacheMaxEntries,
} from './cluster-settings-reader.js';
import { createMockDb } from '../__test-helpers__/mock-db.js';

/**
 * A db whose select throws while `shouldFail()` holds and returns `row`
 * otherwise. `mocks.selectExecuteTakeFirst` records each query that reached
 * the db, so a test can assert the negative cache suppressed the rest.
 */
function flakyDb(opts: { shouldFail: () => boolean; row?: Record<string, unknown> }) {
  const mock = createMockDb({ selectFirstRow: opts.row });
  mock.mocks.selectExecuteTakeFirst.mockImplementation(async () => {
    if (opts.shouldFail()) throw new Error('db down');
    return opts.row;
  });
  return mock;
}

function failingDb() {
  const { db, mocks } = createMockDb();
  mocks.selectExecuteTakeFirst.mockRejectedValue(new Error('db down'));
  return db;
}

function fakeDb(row: Record<string, unknown> | undefined) {
  return createMockDb({ selectFirstRow: row }).db;
}

describe('ClusterSettingsReader', () => {
  it('returns the per-column override when the row has a value', async () => {
    const r = new ClusterSettingsReader(fakeDb({ queue_max_depth: 42 }), 10_000);
    expect(await r.getNumber('queue_max_depth', 1000)).toBe(42);
  });

  it('coerces bigint string columns to numbers', async () => {
    const r = new ClusterSettingsReader(fakeDb({ webhook_dedup_ttl_ms: '3600000' }), 10_000);
    expect(await r.getNumber('webhook_dedup_ttl_ms', 999)).toBe(3_600_000);
  });

  it('reads the new fleet tunables (bigint ms + integer count columns)', async () => {
    const r = new ClusterSettingsReader(
      fakeDb({
        reroute_flap_grace_ms: '45000', // BIGINT → string from pg
        agent_token_ttl_ms: '1800000',
        cache_ttl_days: 14, // INTEGER → number from pg
        max_fanout_hosts: 8,
      }),
      10_000,
    );
    expect(await r.getNumber('reroute_flap_grace_ms', 120_000)).toBe(45_000);
    expect(await r.getNumber('agent_token_ttl_ms', 3_600_000)).toBe(1_800_000);
    expect(await r.getNumber('cache_ttl_days', 30)).toBe(14);
    expect(await r.getNumber('max_fanout_hosts', 1024)).toBe(8);
  });

  it('reads each cache knob override in place of the config default', async () => {
    // BIGINT columns come back from pg as strings; these cases pin the coercion.
    const r = new ClusterSettingsReader(
      fakeDb({
        lockfile_cache_max: '900',
        lockfile_cache_max_bytes: '134217728',
        lockfile_cache_ttl_ms: '7200000',
        content_cache_max: '999',
        content_cache_max_bytes: '268435456',
        content_cache_ttl_ms: '1800000',
      }),
      10_000,
    );
    expect(await r.getNumber('lockfile_cache_max', 500)).toBe(900);
    expect(await r.getNumber('lockfile_cache_max_bytes', 67_108_864)).toBe(134_217_728);
    expect(await r.getNumber('lockfile_cache_ttl_ms', 3_600_000)).toBe(7_200_000);
    expect(await r.getNumber('content_cache_max', 500)).toBe(999);
    expect(await r.getNumber('content_cache_max_bytes', 67_108_864)).toBe(268_435_456);
    expect(await r.getNumber('content_cache_ttl_ms', 3_600_000)).toBe(1_800_000);
  });

  it('falls back to the config default for every unset cache knob', async () => {
    const r = new ClusterSettingsReader(
      fakeDb({
        lockfile_cache_max: null,
        lockfile_cache_max_bytes: null,
        lockfile_cache_ttl_ms: null,
        content_cache_max: null,
        content_cache_max_bytes: null,
        content_cache_ttl_ms: null,
      }),
      10_000,
    );
    expect(await r.getNumber('lockfile_cache_max', 500)).toBe(500);
    expect(await r.getNumber('lockfile_cache_max_bytes', 67_108_864)).toBe(67_108_864);
    expect(await r.getNumber('lockfile_cache_ttl_ms', 3_600_000)).toBe(3_600_000);
    expect(await r.getNumber('content_cache_max', 500)).toBe(500);
    expect(await r.getNumber('content_cache_max_bytes', 67_108_864)).toBe(67_108_864);
    expect(await r.getNumber('content_cache_ttl_ms', 3_600_000)).toBe(3_600_000);
  });

  it('reads a text knob and falls back on null / empty / missing row / no db', async () => {
    expect(
      await new ClusterSettingsReader(
        fakeDb({ dashboard_verified_issuer: 'https://orch.example.com' }),
        10_000,
      ).getString('dashboard_verified_issuer', null),
    ).toBe('https://orch.example.com');
    // An empty stored string means "cleared", so the cluster default applies.
    expect(
      await new ClusterSettingsReader(fakeDb({ dashboard_verified_issuer: '' }), 10_000).getString(
        'dashboard_verified_issuer',
        'https://env.example.com',
      ),
    ).toBe('https://env.example.com');
    expect(
      await new ClusterSettingsReader(
        fakeDb({ dashboard_verified_issuer: null }),
        10_000,
      ).getString('dashboard_verified_issuer', 'https://env.example.com'),
    ).toBe('https://env.example.com');
    expect(
      await new ClusterSettingsReader(fakeDb(undefined), 10_000).getString(
        'dashboard_verified_issuer',
        'https://env.example.com',
      ),
    ).toBe('https://env.example.com');
    expect(
      await new ClusterSettingsReader(undefined, 10_000).getString(
        'dashboard_verified_issuer',
        null,
      ),
    ).toBeNull();
  });

  it('falls back when the column is null / row missing / no db', async () => {
    expect(
      await new ClusterSettingsReader(fakeDb({ queue_max_depth: null }), 10_000).getNumber(
        'queue_max_depth',
        1000,
      ),
    ).toBe(1000);
    expect(
      await new ClusterSettingsReader(fakeDb(undefined), 10_000).getNumber('queue_max_depth', 1000),
    ).toBe(1000);
    expect(
      await new ClusterSettingsReader(undefined, 10_000).getNumber('queue_max_depth', 1000),
    ).toBe(1000);
  });

  it('reads the row once per TTL window across multiple getNumber calls', async () => {
    const { db, mocks } = createMockDb({
      selectFirstRow: { queue_max_depth: 5, event_router_event_ttl_seconds: 7 },
    });
    const r = new ClusterSettingsReader(db, 10_000);
    await r.getNumber('queue_max_depth', 1);
    await r.getNumber('event_router_event_ttl_seconds', 1);
    expect(mocks.selectExecuteTakeFirst.mock.calls.length).toBe(1);
  });

  it('re-reads after the TTL window expires', async () => {
    const { db, mocks } = createMockDb({ selectFirstRow: { queue_max_depth: 5 } });
    const r = new ClusterSettingsReader(db, 0); // TTL 0 → every read is a fresh load
    await r.getNumber('queue_max_depth', 1);
    await r.getNumber('queue_max_depth', 1);
    expect(mocks.selectExecuteTakeFirst.mock.calls.length).toBe(2);
  });

  it('degrades to fallback when the select throws', async () => {
    const { db, mocks } = createMockDb();
    mocks.selectExecuteTakeFirst.mockRejectedValue(new Error('db down'));
    expect(await new ClusterSettingsReader(db, 10_000).getNumber('queue_max_depth', 1000)).toBe(
      1000,
    );
  });

  it('getCachedVersion returns 0 before any load and the cached version after', async () => {
    const r = new ClusterSettingsReader(fakeDb({ queue_max_depth: 5, version: 7 }), 10_000);
    // With a db present, the accessor kicks a background refresh but returns
    // the last-loaded value synchronously (0 until the first load).
    await r.getNumber('queue_max_depth', 1);
    expect(r.getCachedVersion()).toBe(7);
  });

  it('getCachedVersion coerces a bigint string version and defaults to 0 for a null column', async () => {
    const strVer = new ClusterSettingsReader(fakeDb({ version: '42' }), 10_000);
    await strVer.getNumber('queue_max_depth', 1);
    expect(strVer.getCachedVersion()).toBe(42);

    const noVer = new ClusterSettingsReader(fakeDb({ queue_max_depth: 5 }), 10_000);
    await noVer.getNumber('queue_max_depth', 1);
    expect(noVer.getCachedVersion()).toBe(0);
  });

  it('getCachedVersion returns 0 for a DB-less reader', () => {
    expect(new ClusterSettingsReader(undefined, 10_000).getCachedVersion()).toBe(0);
  });

  it('keeps swallowing a read failure on the fallback-taking readers', async () => {
    // getNumber and getString serve the knobs that WANT the degrade-to-default
    // behaviour; tryGetString is purely additive and must not change them.
    const r = new ClusterSettingsReader(failingDb(), 10_000);
    expect(await r.getNumber('queue_max_depth', 1000)).toBe(1000);
    expect(await r.getString('dashboard_verified_issuer', 'https://env.example.com')).toBe(
      'https://env.example.com',
    );
  });
});

describe('clampCacheMaxEntries', () => {
  it('passes a normal value through unchanged', () => {
    expect(clampCacheMaxEntries(500, 500)).toBe(500);
    expect(clampCacheMaxEntries(50_000, 500)).toBe(50_000);
    expect(clampCacheMaxEntries(CACHE_MAX_ENTRIES_CEILING, 500)).toBe(CACHE_MAX_ENTRIES_CEILING);
  });

  it('clamps a stored value above the ceiling', () => {
    // Load-bearing: a value stored before the route's `.max()` existed is out
    // of write-side validation's reach, so only the read site stops the
    // constructor throwing during boot.
    expect(clampCacheMaxEntries(5_000_000_000, 500)).toBe(CACHE_MAX_ENTRIES_CEILING);
    expect(clampCacheMaxEntries(CACHE_MAX_ENTRIES_CEILING + 1, 500)).toBe(
      CACHE_MAX_ENTRIES_CEILING,
    );
  });

  it('falls back to the configured default for a value that is not a usable count', () => {
    // Not clamped to 1 on purpose: a 1-entry cache thrashes silently.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampCacheMaxEntries(bad, 500)).toBe(500);
    }
  });

  it('clamps the fallback itself when it exceeds the ceiling', () => {
    // A garbage stored value takes the fallback path; an above-ceiling default
    // must still be bounded, or the LRU constructor can throw during boot.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampCacheMaxEntries(bad, CACHE_MAX_ENTRIES_CEILING + 1)).toBe(
        CACHE_MAX_ENTRIES_CEILING,
      );
    }
    expect(clampCacheMaxEntries(0, 500)).toBe(500);
    // The LRU constructor rejects a non-integer max, so the fallback is floored too.
    expect(clampCacheMaxEntries(0, 500.9)).toBe(500);
  });

  it('floors a fractional value so the LRU never sees a non-integer max', () => {
    expect(clampCacheMaxEntries(500.9, 500)).toBe(500);
  });
});

describe('ClusterSettingsReader.tryGetString', () => {
  it('reports the configured value', async () => {
    const r = new ClusterSettingsReader(
      fakeDb({ dashboard_verified_issuer: 'https://orch.example.com' }),
      10_000,
    );
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({
      ok: true,
      value: 'https://orch.example.com',
    });
  });

  it('reports a genuine unset (missing row, null column, empty string) as readable-null', async () => {
    // A successful empty query is the truth: a fresh cluster and a real
    // opt-out both land here, and both must propagate.
    for (const row of [
      undefined,
      { dashboard_verified_issuer: null },
      {
        dashboard_verified_issuer: '',
      },
    ]) {
      const r = new ClusterSettingsReader(fakeDb(row), 10_000);
      expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: true, value: null });
    }
  });

  it('reports readable-null for a DB-less reader', async () => {
    // With no db, unset is the truth; unreadable would make a holding caller hold forever.
    const r = new ClusterSettingsReader(undefined, 10_000);
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: true, value: null });
  });

  it('reports unreadable when the select throws', async () => {
    const r = new ClusterSettingsReader(failingDb(), 10_000);
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: false });
  });

  it('keeps reporting unreadable for the whole negative-cache window', async () => {
    // Load-bearing: reads 2..N of the negative-cache TTL never reach the db, so
    // raising `{ ok: false }` only from the catch would answer "unset" for them
    // and the downgrade would fire one tick later.
    let fail = true;
    const { db, mocks } = flakyDb({
      shouldFail: () => fail,
      row: { dashboard_verified_issuer: 'https://orch.example.com' },
    });
    const r = new ClusterSettingsReader(db, 10_000);
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: false });
    // The db recovered inside the window: reads serve the failed entry.
    fail = false;
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: false });
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: false });
    expect(mocks.selectExecuteTakeFirst.mock.calls.length).toBe(1);
  });

  it('recovers once the negative-cache window elapses', async () => {
    let fail = true;
    const { db } = flakyDb({
      shouldFail: () => fail,
      row: { dashboard_verified_issuer: 'https://orch.example.com' },
    });
    const r = new ClusterSettingsReader(db, 0); // TTL 0 → every read reloads
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: false });
    fail = false;
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({
      ok: true,
      value: 'https://orch.example.com',
    });
  });

  it('reports unreadable once a healthy read is followed by a failure', async () => {
    // The production sequence: the reader has served the issuer, then the db
    // goes sick. `{ ok: true, value: null }` here is the downgrade this variant
    // prevents, so the transition, not only a cold-cache failure, is pinned.
    let fail = false;
    const { db } = flakyDb({
      shouldFail: () => fail,
      row: { dashboard_verified_issuer: 'https://orch.example.com' },
    });
    const r = new ClusterSettingsReader(db, 0); // TTL 0 → the failure lands on the next read
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({
      ok: true,
      value: 'https://orch.example.com',
    });
    fail = true;
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: false });
  });
});

describe('ClusterSettingsReader.tryGetBoolean', () => {
  it('reports a stored true', async () => {
    const r = new ClusterSettingsReader(fakeDb({ global_workflows_enabled: true }), 10_000);
    expect(await r.tryGetBoolean('global_workflows_enabled')).toEqual({ ok: true, value: true });
  });

  it('reports a stored false as false, not as unset', async () => {
    const r = new ClusterSettingsReader(fakeDb({ global_workflows_enabled: false }), 10_000);
    expect(await r.tryGetBoolean('global_workflows_enabled')).toEqual({ ok: true, value: false });
  });

  it('reports a NULL column as a genuine unset', async () => {
    const r = new ClusterSettingsReader(fakeDb({ global_workflows_enabled: null }), 10_000);
    expect(await r.tryGetBoolean('global_workflows_enabled')).toEqual({ ok: true, value: null });
  });

  it('reports a missing row as a genuine unset', async () => {
    const r = new ClusterSettingsReader(fakeDb(undefined), 10_000);
    expect(await r.tryGetBoolean('global_workflows_enabled')).toEqual({ ok: true, value: null });
  });

  it('reports a failed query as unreadable, not as unset', async () => {
    const r = new ClusterSettingsReader(failingDb(), 10_000);
    expect(await r.tryGetBoolean('global_workflows_enabled')).toEqual({ ok: false });
  });

  // Negative-cached reads must stay unreadable: reporting them as unset would
  // give a security gate the config default instead of a deny.
  it('keeps reporting unreadable for cached reads inside the TTL window', async () => {
    const r = new ClusterSettingsReader(failingDb(), 10_000);
    expect(await r.tryGetBoolean('global_workflows_enabled')).toEqual({ ok: false });
    expect(await r.tryGetBoolean('global_workflows_enabled')).toEqual({ ok: false });
  });

  // A DB-less worker is real, and unset is the truth there; unreadable would
  // make a fail-closed caller deny forever.
  it('reports "no database configured" as a genuine unset', async () => {
    const r = new ClusterSettingsReader(undefined, 10_000);
    expect(await r.tryGetBoolean('global_workflows_enabled')).toEqual({ ok: true, value: null });
  });
});
