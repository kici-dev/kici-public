import { describe, it, expect } from 'vitest';
import { resolveAgentHostAccess, storageHostAccessEntries } from './host-access.js';
import type { AppConfig } from '../config.js';

/** The two fields `storageHostAccessEntries` actually reads. */
function configWith(storage: unknown, port = 10143): AppConfig {
  return { port, storage } as unknown as AppConfig;
}

describe('resolveAgentHostAccess default', () => {
  const base = { orchestratorUrl: 'http://192.168.1.85:10143', gateway: '172.30.0.1' };

  it('grants the orchestrator port and DNS on the gateway, and nothing else', () => {
    // The whole-host grant this replaces was every port on every host address.
    expect(resolveAgentHostAccess({ policy: undefined, ...base })).toEqual([
      '172.30.0.1:53',
      '*:10143',
    ]);
  });

  it('grants DNS even though only one runtime needs it', () => {
    // Rootful podman resolves at the bridge gateway, a host address. Without
    // this entry such an agent cannot resolve the orchestrator's own hostname.
    const resolved = resolveAgentHostAccess({ policy: undefined, ...base });
    expect(resolved).toContain('172.30.0.1:53');
  });

  it('folds in the host services the orchestrator directed the agent at', () => {
    expect(
      resolveAgentHostAccess({ policy: undefined, ...base, hostServices: ['192.168.1.85:9000'] }),
    ).toEqual(['172.30.0.1:53', '*:10143', '192.168.1.85:9000']);
  });

  it('does not repeat a host service that is already the orchestrator port', () => {
    expect(
      resolveAgentHostAccess({ policy: undefined, ...base, hostServices: ['*:10143'] }),
    ).toEqual(['172.30.0.1:53', '*:10143']);
  });

  it('reads the port out of a ws:// orchestrator URL', () => {
    expect(
      resolveAgentHostAccess({ ...base, policy: undefined, orchestratorUrl: 'ws://host:4319' }),
    ).toContain('*:4319');
  });

  it('falls back to the scheme port when the URL names none', () => {
    expect(
      resolveAgentHostAccess({
        ...base,
        policy: undefined,
        orchestratorUrl: 'https://orch.example.com',
      }),
    ).toContain('*:443');
  });

  it('still grants DNS when the orchestrator URL cannot be parsed', () => {
    // A resolver rule is what keeps the agent able to look the URL up at all,
    // so an unparseable URL must not take it away too.
    expect(
      resolveAgentHostAccess({ ...base, policy: undefined, orchestratorUrl: 'not a url' }),
    ).toEqual(['172.30.0.1:53']);
  });
});

describe('resolveAgentHostAccess with an operator policy', () => {
  const base = { orchestratorUrl: 'http://192.168.1.85:10143', gateway: '172.30.0.1' };

  it('takes the label set at its word and adds nothing', () => {
    expect(
      resolveAgentHostAccess({ policy: { hostAccess: ['10.98.0.0/24:443'] }, ...base }),
    ).toEqual(['10.98.0.0/24:443']);
  });

  it('honours an empty policy as "reach nothing on the host"', () => {
    expect(resolveAgentHostAccess({ policy: { hostAccess: [] }, ...base })).toEqual([]);
  });

  it('ignores a policy that sets only the egress fields', () => {
    expect(
      resolveAgentHostAccess({ policy: { denyAll: true, allowlist: ['10.0.0.0/8'] }, ...base }),
    ).toEqual(['172.30.0.1:53', '*:10143']);
  });
});

describe('storageHostAccessEntries', () => {
  it('scopes an IP-literal endpoint to that exact address and port', () => {
    expect(
      storageHostAccessEntries(
        configWith({ type: 's3', externalEndpoint: 'http://192.168.1.85:9000' }),
      ),
    ).toEqual(['192.168.1.85:9000']);
  });

  it('names the port on any host address when the endpoint is a name with a port', () => {
    // No address rule can be written for a name that may move, and the port is
    // still far narrower than the whole host.
    expect(
      storageHostAccessEntries(configWith({ type: 's3', endpoint: 'http://minio.lan:9000' })),
    ).toEqual(['*:9000']);
  });

  it('emits nothing for a public endpoint with no explicit port', () => {
    // That traffic leaves through the host on the forward hook, which no input
    // rule governs; emitting `*:443` would open a host port for nothing.
    expect(
      storageHostAccessEntries(
        configWith({ type: 's3', endpoint: 'https://s3.eu-central-1.amazonaws.com' }),
      ),
    ).toEqual([]);
  });

  it('emits nothing for s3 with no endpoint at all', () => {
    expect(storageHostAccessEntries(configWith({ type: 's3' }))).toEqual([]);
  });

  it('emits nothing when storage is unconfigured', () => {
    expect(storageHostAccessEntries(configWith(undefined))).toEqual([]);
  });

  it('resolves filesystem storage to the orchestrator port it defaults to', () => {
    expect(storageHostAccessEntries(configWith({ type: 'filesystem' }, 10143))).toEqual([
      '127.0.0.1:10143',
    ]);
  });

  it('honours an explicit filesystem base URL', () => {
    expect(
      storageHostAccessEntries(
        configWith({ type: 'filesystem', fsBaseUrl: 'http://192.168.1.85:10143' }),
      ),
    ).toEqual(['192.168.1.85:10143']);
  });
});
