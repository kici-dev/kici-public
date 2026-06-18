import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GenericSourcesChangeListener } from './generic-sources-listener.js';
import { ProviderRegistry } from '../provider-registry.js';
import type { GenericSourceManager } from './generic-sources.js';
import type { GenericWebhookSource } from '../db/types.js';
import type { AppConfig } from '../config.js';

let localRepoPath = '';

/** A `provider_type='local'` row whose git_config points at the real tmp repo
 *  dir, so registerProviderBundleForSource's statSync gate passes. */
function makeLocalRow(overrides: Partial<GenericWebhookSource> = {}): GenericWebhookSource {
  return makeRow({
    provider_type: 'local',
    git_config: JSON.stringify({ repoBasePath: localRepoPath }),
    ...overrides,
  });
}

function makeRow(overrides: Partial<GenericWebhookSource> = {}): GenericWebhookSource {
  return {
    id: 'src-1',
    customer_id: 'org-1',
    name: 'source-1',
    routing_key: 'generic:org-1:src-1',
    verification_method: 'none',
    verification_config: '{}',
    event_type_header: 'X-Event-Type',
    event_type_path: null,
    idempotency_key_header: null,
    idempotency_key_path: null,
    dedup_window_seconds: 300,
    max_payload_bytes: 1048576,
    allowed_events: null,
    strip_headers: '[]',
    enabled: true,
    rate_limit_rpm: 100,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    provider_type: 'generic',
    git_config: null,
    ...overrides,
  };
}

function createMockPoolClient() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    }),
    _emit: (channel: string, payload?: string) => {
      const notificationListeners = listeners.get('notification') ?? [];
      for (const listener of notificationListeners) {
        listener({ channel, payload });
      }
    },
  };
}

function makeListener(opts: {
  rowByRoutingKey?: Map<string, GenericWebhookSource | null>;
  config?: Partial<AppConfig>;
  debounceMs?: number;
}) {
  const client = createMockPoolClient();
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as import('pg').Pool;
  const sourceManager = {
    getByRoutingKey: vi.fn(async (rk: string) => opts.rowByRoutingKey?.get(rk) ?? null),
  } as unknown as GenericSourceManager;
  const providerRegistry = new ProviderRegistry();
  const config = {
    ...opts.config,
  } as AppConfig;
  const listener = new GenericSourcesChangeListener({
    pool,
    sourceManager,
    providerRegistry,
    config,
    secretResolver: null,
    debounceMs: opts.debounceMs ?? 5,
  });
  return { listener, client, providerRegistry, sourceManager };
}

beforeEach(() => {
  vi.useFakeTimers();
  localRepoPath = mkdtempSync(join(tmpdir(), 'kici-local-provider-repo-'));
});

afterEach(() => {
  vi.useRealTimers();
  if (localRepoPath) {
    rmSync(localRepoPath, { recursive: true, force: true });
    localRepoPath = '';
  }
});

describe('GenericSourcesChangeListener', () => {
  it('LISTENs on generic_sources_change after start()', async () => {
    const { listener, client } = makeListener({});
    await listener.start();
    expect(client.query).toHaveBeenCalledWith('LISTEN generic_sources_change');
    await listener.stop();
    expect(client.query).toHaveBeenCalledWith('UNLISTEN generic_sources_change');
    expect(client.release).toHaveBeenCalled();
  });

  it('ignores NOTIFYs on other channels', async () => {
    const { listener, client, sourceManager } = makeListener({});
    await listener.start();
    client._emit('sources_change', 'github:42');
    vi.advanceTimersByTime(10);
    await Promise.resolve();
    expect(sourceManager.getByRoutingKey).not.toHaveBeenCalled();
    await listener.stop();
  });

  it('INSERT path: registers local-provider bundle for new source', async () => {
    const row = makeLocalRow();
    const rows = new Map([[row.routing_key, row]]);
    const { listener, client, providerRegistry } = makeListener({ rowByRoutingKey: rows });
    await listener.start();
    client._emit('generic_sources_change', row.routing_key);
    await vi.advanceTimersByTimeAsync(10);
    expect(providerRegistry.getByRoutingKey(row.routing_key)).toBeTruthy();
    await listener.stop();
  });

  it('fires onChange (set via setOnChange) after a drain that applied a change', async () => {
    const row = makeLocalRow();
    const rows = new Map([[row.routing_key, row]]);
    const { listener, client } = makeListener({ rowByRoutingKey: rows });
    const onChange = vi.fn();
    listener.setOnChange(onChange);
    await listener.start();
    client._emit('generic_sources_change', row.routing_key);
    await vi.advanceTimersByTimeAsync(10);
    expect(onChange).toHaveBeenCalledTimes(1);
    await listener.stop();
  });

  it('plain-generic NEW row is a no-op (no per-routing-key bundle needed)', async () => {
    const row = makeRow({ provider_type: 'generic', git_config: null });
    const rows = new Map([[row.routing_key, row]]);
    const { listener, client, providerRegistry } = makeListener({ rowByRoutingKey: rows });
    await listener.start();
    client._emit('generic_sources_change', row.routing_key);
    await vi.advanceTimersByTimeAsync(10);
    // No per-routing-key bundle is registered; getByRoutingKey falls back to
    // the default registration which isn't set in this test.
    expect(providerRegistry.getByRoutingKey(row.routing_key)).toBeUndefined();
    await listener.stop();
  });

  it('DELETE path: unregisters bundle when row is missing', async () => {
    const row = makeLocalRow();
    const rows = new Map<string, GenericWebhookSource | null>([[row.routing_key, row]]);
    const { listener, client, providerRegistry, sourceManager } = makeListener({
      rowByRoutingKey: rows,
    });
    await listener.start();

    // First, register the row.
    client._emit('generic_sources_change', row.routing_key);
    await vi.advanceTimersByTimeAsync(10);
    expect(providerRegistry.getByRoutingKey(row.routing_key)).toBeTruthy();

    // Then mark it gone (DELETE / soft-delete / disable all surface as null
    // from getByRoutingKey).
    rows.set(row.routing_key, null);
    (sourceManager.getByRoutingKey as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (rk: string) => rows.get(rk) ?? null,
    );
    client._emit('generic_sources_change', row.routing_key);
    await vi.advanceTimersByTimeAsync(10);
    expect(providerRegistry.getByRoutingKey(row.routing_key)).toBeUndefined();
    await listener.stop();
  });

  it('debounce: duplicate NOTIFYs for the same routing_key coalesce', async () => {
    const row = makeLocalRow();
    const rows = new Map([[row.routing_key, row]]);
    const { listener, client, sourceManager } = makeListener({
      rowByRoutingKey: rows,
      debounceMs: 50,
    });
    await listener.start();
    client._emit('generic_sources_change', row.routing_key);
    client._emit('generic_sources_change', row.routing_key);
    client._emit('generic_sources_change', row.routing_key);
    await vi.advanceTimersByTimeAsync(100);
    // Three NOTIFYs collapse into one DB lookup.
    expect(sourceManager.getByRoutingKey).toHaveBeenCalledTimes(1);
    await listener.stop();
  });

  it('warns on NOTIFY without payload', async () => {
    const { listener, client, sourceManager } = makeListener({});
    await listener.start();
    client._emit('generic_sources_change', undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(sourceManager.getByRoutingKey).not.toHaveBeenCalled();
    await listener.stop();
  });

  it('provider-type change: local -> generic clears the stale local bundle', async () => {
    const localRow = makeLocalRow();
    const rows = new Map<string, GenericWebhookSource | null>([[localRow.routing_key, localRow]]);
    const { listener, client, providerRegistry } = makeListener({ rowByRoutingKey: rows });
    await listener.start();

    client._emit('generic_sources_change', localRow.routing_key);
    await vi.advanceTimersByTimeAsync(10);
    expect(providerRegistry.getByRoutingKey(localRow.routing_key)).toBeTruthy();

    // The row is now plain generic — listener unregisters first, then the
    // helper no-ops (no per-routing-key bundle for plain generic). Net
    // effect: the stale local bundle is gone.
    const genericRow = makeRow({
      id: localRow.id,
      routing_key: localRow.routing_key,
      provider_type: 'generic',
    });
    rows.set(localRow.routing_key, genericRow);
    client._emit('generic_sources_change', localRow.routing_key);
    await vi.advanceTimersByTimeAsync(10);
    expect(providerRegistry.getByRoutingKey(localRow.routing_key)).toBeUndefined();
    await listener.stop();
  });
});
