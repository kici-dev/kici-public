import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProviderBundleForSource } from './register-source-bundle.js';
import { ProviderRegistry } from '../provider-registry.js';
import type { GenericWebhookSource } from '../db/types.js';
import type { AppConfig } from '../config.js';

const baseConfig = {} as AppConfig;

function makeRow(overrides: Partial<GenericWebhookSource>): GenericWebhookSource {
  return {
    id: 'src-1',
    customer_id: 'org-1',
    name: 'local-src',
    routing_key: 'generic:org-1:src-1',
    verification_method: 'none',
    verification_config: '{}',
    event_type_header: 'x-event-type',
    event_type_path: null,
    idempotency_key_header: null,
    idempotency_key_path: null,
    dedup_window_seconds: 300,
    max_payload_bytes: 1048576,
    allowed_events: null,
    strip_headers: '[]',
    enabled: true,
    rate_limit_rpm: 600,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    provider_type: 'generic',
    git_config: null,
    ...overrides,
  } as GenericWebhookSource;
}

describe('registerProviderBundleForSource — local', () => {
  it('registers a local bundle from the row git_config repoBasePath', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kici-local-'));
    const registry = new ProviderRegistry();
    const row = makeRow({
      provider_type: 'local',
      routing_key: 'generic:org-1:src-1',
      git_config: JSON.stringify({ repoBasePath: dir }),
    });
    registerProviderBundleForSource(row, {
      providerRegistry: registry,
      config: baseConfig,
      secretResolver: null,
    });
    const bundle = registry.getByRoutingKey('generic:org-1:src-1');
    expect(bundle?.repoUrlBuilder?.provider).toBe('local');
    expect(bundle?.lockFileFetcher?.provider).toBe('local');
  });

  it('skips a local source whose repoBasePath does not exist (warns, no throw)', () => {
    const registry = new ProviderRegistry();
    const row = makeRow({
      provider_type: 'local',
      routing_key: 'generic:org-1:src-2',
      git_config: JSON.stringify({ repoBasePath: '/nonexistent/kici-policy-xyz' }),
    });
    expect(() =>
      registerProviderBundleForSource(row, {
        providerRegistry: registry,
        config: baseConfig,
        secretResolver: null,
      }),
    ).not.toThrow();
    expect(registry.getByRoutingKey('generic:org-1:src-2')).toBeUndefined();
  });

  it('skips a local source with invalid git_config (warns, no throw)', () => {
    const registry = new ProviderRegistry();
    const row = makeRow({
      provider_type: 'local',
      routing_key: 'generic:org-1:src-3',
      git_config: JSON.stringify({ repoBasePath: 'relative-not-absolute' }),
    });
    expect(() =>
      registerProviderBundleForSource(row, {
        providerRegistry: registry,
        config: baseConfig,
        secretResolver: null,
      }),
    ).not.toThrow();
    expect(registry.getByRoutingKey('generic:org-1:src-3')).toBeUndefined();
  });

  it('does NOT register a universal-git bundle for a local row (git_config is dual-purpose)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kici-local-'));
    const registry = new ProviderRegistry();
    const row = makeRow({
      provider_type: 'local',
      routing_key: 'generic:org-1:src-4',
      git_config: JSON.stringify({ repoBasePath: dir }),
    });
    registerProviderBundleForSource(row, {
      providerRegistry: registry,
      config: baseConfig,
      secretResolver: null,
    });
    // Must be the local bundle, never the universal-git one.
    expect(registry.getByRoutingKey('generic:org-1:src-4')?.normalizer.provider).toBe('local');
  });
});

describe('registerProviderBundleForSource — scaler-coexistence warning', () => {
  it('invokes the warning sink once when a local source coexists with a container scaler', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kici-local-'));
    const registry = new ProviderRegistry();
    const onScalerWarning = vi.fn();
    const row = makeRow({
      provider_type: 'local',
      routing_key: 'generic:org-1:src-5',
      git_config: JSON.stringify({ repoBasePath: dir }),
    });
    registerProviderBundleForSource(row, {
      providerRegistry: registry,
      config: baseConfig,
      secretResolver: null,
      scalerBackendType: 'container',
      onScalerWarning,
    });
    expect(onScalerWarning).toHaveBeenCalledTimes(1);
    expect(onScalerWarning.mock.calls[0][0]).toContain('container');
    expect(onScalerWarning.mock.calls[0][1]).toMatchObject({ routingKey: 'generic:org-1:src-5' });
    // Registration still happened — the warning is non-fatal.
    expect(registry.getByRoutingKey('generic:org-1:src-5')).toBeDefined();
  });

  it('does NOT warn on a bare-metal scaler', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kici-local-'));
    const registry = new ProviderRegistry();
    const onScalerWarning = vi.fn();
    const row = makeRow({
      provider_type: 'local',
      routing_key: 'generic:org-1:src-6',
      git_config: JSON.stringify({ repoBasePath: dir }),
    });
    registerProviderBundleForSource(row, {
      providerRegistry: registry,
      config: baseConfig,
      secretResolver: null,
      scalerBackendType: 'bare-metal',
      onScalerWarning,
    });
    expect(onScalerWarning).not.toHaveBeenCalled();
  });

  it('warns on a firecracker scaler', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kici-local-'));
    const registry = new ProviderRegistry();
    const onScalerWarning = vi.fn();
    const row = makeRow({
      provider_type: 'local',
      routing_key: 'generic:org-1:src-7',
      git_config: JSON.stringify({ repoBasePath: dir }),
    });
    registerProviderBundleForSource(row, {
      providerRegistry: registry,
      config: baseConfig,
      secretResolver: null,
      scalerBackendType: 'firecracker',
      onScalerWarning,
    });
    expect(onScalerWarning).toHaveBeenCalledTimes(1);
    expect(onScalerWarning.mock.calls[0][0]).toContain('firecracker');
  });
});
