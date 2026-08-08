import { describe, it, expect } from 'vitest';
import { ClusterSettingsReader } from './cluster-settings-reader.js';

/**
 * A db whose select throws while `shouldFail()` holds and returns `row`
 * otherwise, so a test can move a reader across a failure boundary in either
 * direction. `onSelect` fires per query that actually reached the db, which is
 * how a test asserts the negative cache suppressed the rest.
 */
function flakyDb(opts: {
  shouldFail: () => boolean;
  row?: Record<string, unknown>;
  onSelect?: () => void;
}) {
  return {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          executeTakeFirst: async () => {
            opts.onSelect?.();
            if (opts.shouldFail()) throw new Error('db down');
            return opts.row;
          },
        }),
      }),
    }),
  } as never;
}

/** A db whose select always throws. */
function failingDb() {
  return flakyDb({ shouldFail: () => true });
}

function fakeDb(row: Record<string, unknown> | undefined, onSelect?: () => void) {
  return {
    selectFrom: () => ({
      selectAll: () => ({
        where: () => ({
          executeTakeFirst: async () => {
            onSelect?.();
            return row;
          },
        }),
      }),
    }),
  } as never;
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
    let selects = 0;
    const r = new ClusterSettingsReader(
      fakeDb({ queue_max_depth: 5, event_router_event_ttl_seconds: 7 }, () => {
        selects++;
      }),
      10_000,
    );
    await r.getNumber('queue_max_depth', 1);
    await r.getNumber('event_router_event_ttl_seconds', 1);
    expect(selects).toBe(1);
  });

  it('re-reads after the TTL window expires', async () => {
    let selects = 0;
    const r = new ClusterSettingsReader(
      fakeDb({ queue_max_depth: 5 }, () => {
        selects++;
      }),
      0, // TTL 0 → every read is a fresh load
    );
    await r.getNumber('queue_max_depth', 1);
    await r.getNumber('queue_max_depth', 1);
    expect(selects).toBe(2);
  });

  it('degrades to fallback when the select throws', async () => {
    const db = {
      selectFrom: () => ({
        selectAll: () => ({
          where: () => ({
            executeTakeFirst: async () => {
              throw new Error('db down');
            },
          }),
        }),
      }),
    } as never;
    expect(await new ClusterSettingsReader(db, 10_000).getNumber('queue_max_depth', 1000)).toBe(
      1000,
    );
  });

  it('getCachedVersion returns 0 before any load and the cached version after', async () => {
    const r = new ClusterSettingsReader(fakeDb({ queue_max_depth: 5, version: 7 }), 10_000);
    // Cold reader: nothing loaded yet, and a DB-less/uninitialized cache is 0.
    // (With a db present, the accessor kicks a background refresh but still
    // returns the last-loaded value synchronously — 0 until the first load.)
    // Warm the cache via a normal read, then the version is visible.
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
    // getNumber and getString are the 16 knobs that WANT the degrade-to-default
    // behaviour; tryGetString is purely additive and must not change them.
    const r = new ClusterSettingsReader(failingDb(), 10_000);
    expect(await r.getNumber('queue_max_depth', 1000)).toBe(1000);
    expect(await r.getString('dashboard_verified_issuer', 'https://env.example.com')).toBe(
      'https://env.example.com',
    );
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
    // A successful query that found nothing is the truth, not an unknown: a
    // fresh cluster and a real opt-out both land here, and both must propagate.
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
    // With no cluster_settings to read at all, "unset" is the truth — reporting
    // unreadable would make a holding caller hold forever.
    const r = new ClusterSettingsReader(undefined, 10_000);
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: true, value: null });
  });

  it('reports unreadable when the select throws', async () => {
    const r = new ClusterSettingsReader(failingDb(), 10_000);
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: false });
  });

  it('keeps reporting unreadable for the whole negative-cache window', async () => {
    // The load-bearing case. loadRow negative-caches for the TTL, so reads 2..N
    // never reach the db. An implementation that raises `{ ok: false }` only
    // from the catch answers "unset" for those reads and the downgrade still
    // fires, one tick later — this test is what fails such a fix.
    let selects = 0;
    let fail = true;
    const db = flakyDb({
      shouldFail: () => fail,
      row: { dashboard_verified_issuer: 'https://orch.example.com' },
      onSelect: () => selects++,
    });
    const r = new ClusterSettingsReader(db, 10_000);
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: false });
    // The db has recovered, but the negative-cache window has not elapsed, so
    // these reads are served from the failed entry and must stay honest.
    fail = false;
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: false });
    expect(await r.tryGetString('dashboard_verified_issuer')).toEqual({ ok: false });
    // And it did not hammer the sick db to say so.
    expect(selects).toBe(1);
  });

  it('recovers once the negative-cache window elapses', async () => {
    let fail = true;
    const db = flakyDb({
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
    // The production sequence, which every other unreadable case here skips:
    // the reader has already served the configured issuer, and only then does
    // the db go sick. Answering `{ ok: true, value: null }` at that point is
    // exactly the downgrade this variant exists to prevent, so the transition
    // — not just a cold-cache failure — is what needs pinning.
    let fail = false;
    const db = flakyDb({
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
