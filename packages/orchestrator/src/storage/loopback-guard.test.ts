import { describe, it, expect } from 'vitest';
import { ScalerBackendType } from '@kici-dev/engine';
import {
  isLoopbackHost,
  isLoopbackBind,
  checkLoopbackAgentEndpoint,
  resolveAgentFacingStorage,
  assertAgentReachableStorage,
  assertAgentAuthBindSafe,
  NON_COLOCATED_BACKENDS,
} from './loopback-guard.js';
import type { AppConfig } from '../config.js';
import type { ScalerConfig, ScalerEntry } from '../scaler/types.js';

const CONTAINER = ScalerBackendType.enum.container;
const BARE_METAL = ScalerBackendType.enum['bare-metal'];
const FIRECRACKER = ScalerBackendType.enum.firecracker;

describe('isLoopbackHost', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['127.5.5.5', true],
    ['::1', true],
    ['[::1]', true],
    ['::', true],
    ['0.0.0.0', true],
    ['seaweedfs', false],
    ['storage.internal', false],
    ['10.0.0.5', false],
    ['example.com', false],
    // IPv4-mapped IPv6, in both spellings an operator or the URL parser produces.
    ['::ffff:127.0.0.1', true],
    ['[::ffff:127.0.0.1]', true],
    ['::ffff:7f00:1', true],
    ['::ffff:0.0.0.0', true],
    ['::ffff:0:0', true],
    ['::ffff:10.0.0.5', false],
    ['::ffff:a00:5', false],
  ])('isLoopbackHost(%s) === %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });

  it('reads an IPv4-mapped loopback storage URL as loopback', () => {
    // `new URL(...).hostname` re-serializes `::ffff:127.0.0.1` to the bracketed
    // hex form, so this is the exact string `parseHost` hands the predicate for
    // a storage endpoint written that way. Missing it means the reachability
    // guard passes a URL no scaled agent can reach.
    const parsed = new URL('http://[::ffff:127.0.0.1]:9000').hostname;
    expect(parsed).toBe('[::ffff:7f00:1]');
    expect(isLoopbackHost(parsed)).toBe(true);
  });
});

describe('isLoopbackBind', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['127.0.0.53', true],
    ['::1', true],
    ['[::1]', true],
    ['0.0.0.0', false],
    ['::', false],
    ['[::]', false],
    ['192.168.1.85', false],
    ['10.0.0.4', false],
    ['', false],
    ['not a host', false],
    // IPv4-mapped IPv6: the mapped quad decides it, so a mapped loopback binds
    // this machine and a mapped wildcard still accepts every interface.
    ['::ffff:127.0.0.1', true],
    ['[::ffff:127.0.0.1]', true],
    ['::ffff:7f00:1', true],
    ['::ffff:0.0.0.0', false],
    ['::ffff:0:0', false],
    ['::ffff:192.168.1.85', false],
  ])('isLoopbackBind(%s) === %s', (host, expected) => {
    expect(isLoopbackBind(host)).toBe(expected);
  });

  it.each(['0.0.0.0', '::'])(
    'disagrees with isLoopbackHost on the wildcard %s, which stays a destination non-address',
    (wildcard) => {
      // The two predicates answer different questions and must not be collapsed
      // back into one: a wildcard is not a reachable destination, but it is a
      // listener on every interface.
      expect(isLoopbackHost(wildcard)).toBe(true);
      expect(isLoopbackBind(wildcard)).toBe(false);
    },
  );
});

describe('checkLoopbackAgentEndpoint', () => {
  const base = {
    endpointSource: 'KICI_STORAGE_ENDPOINT',
    fixEnvVar: 'KICI_STORAGE_EXTERNAL_ENDPOINT',
  };

  it('flags loopback endpoint with a container scaler', () => {
    const drift = checkLoopbackAgentEndpoint({
      ...base,
      agentFacingUrl: 'http://localhost:8333',
      scalers: [{ type: CONTAINER }],
    });
    expect(drift).not.toBeNull();
    expect(drift!.message).toContain('KICI_STORAGE_EXTERNAL_ENDPOINT');
    expect(drift!.message).toContain('localhost');
    expect(drift!.message).toContain('container');
  });

  it.each([[BARE_METAL], [FIRECRACKER]])('flags loopback with %s scaler', (backend) => {
    const drift = checkLoopbackAgentEndpoint({
      ...base,
      agentFacingUrl: 'http://127.0.0.1:8333',
      scalers: [{ type: backend }],
    });
    expect(drift).not.toBeNull();
  });

  it('passes a routable endpoint', () => {
    expect(
      checkLoopbackAgentEndpoint({
        ...base,
        agentFacingUrl: 'http://seaweedfs.internal:8333',
        scalers: [{ type: CONTAINER }],
      }),
    ).toBeNull();
  });

  it('passes when no scaler is configured (loopback is fine, agents co-located)', () => {
    expect(
      checkLoopbackAgentEndpoint({
        ...base,
        agentFacingUrl: 'http://localhost:8333',
        scalers: [],
      }),
    ).toBeNull();
  });

  it('passes when agentFacingUrl is null (real AWS / no custom endpoint)', () => {
    expect(
      checkLoopbackAgentEndpoint({
        ...base,
        agentFacingUrl: null,
        scalers: [{ type: CONTAINER }],
      }),
    ).toBeNull();
  });

  it('passes when the URL is unparseable (cannot determine host — do not block)', () => {
    expect(
      checkLoopbackAgentEndpoint({
        ...base,
        agentFacingUrl: 'not a url',
        scalers: [{ type: CONTAINER }],
      }),
    ).toBeNull();
  });

  it('classifies all three real backends as non-co-located', () => {
    expect(NON_COLOCATED_BACKENDS.has(CONTAINER)).toBe(true);
    expect(NON_COLOCATED_BACKENDS.has(BARE_METAL)).toBe(true);
    expect(NON_COLOCATED_BACKENDS.has(FIRECRACKER)).toBe(true);
  });
});

function makeConfig(storage: AppConfig['storage'], port = 10143): AppConfig {
  return { storage, port } as unknown as AppConfig;
}
function scalerCfg(
  entries: (ScalerEntry['type'] | { type: ScalerEntry['type']; orchestratorUrl?: string })[],
): ScalerConfig {
  return {
    globalMaxAgents: 50,
    scalers: entries.map((e, i) => {
      const entry = typeof e === 'string' ? { type: e } : e;
      return { name: `s${i}`, ...entry } as ScalerEntry;
    }),
  } as unknown as ScalerConfig;
}

describe('resolveAgentFacingStorage', () => {
  it('s3 prefers externalEndpoint over endpoint', () => {
    const r = resolveAgentFacingStorage(
      makeConfig({
        type: 's3',
        endpoint: 'http://localhost:8333',
        externalEndpoint: 'http://seaweed:8333',
      }),
    );
    expect(r).toEqual({
      url: 'http://seaweed:8333',
      source: 'KICI_STORAGE_EXTERNAL_ENDPOINT',
      fixEnvVar: 'KICI_STORAGE_EXTERNAL_ENDPOINT',
    });
  });

  it('s3 falls back to endpoint and labels its source', () => {
    const r = resolveAgentFacingStorage(
      makeConfig({ type: 's3', endpoint: 'http://localhost:8333' }),
    );
    expect(r!.url).toBe('http://localhost:8333');
    expect(r!.source).toBe('KICI_STORAGE_ENDPOINT');
  });

  it('s3 with neither endpoint yields a null url (real AWS)', () => {
    const r = resolveAgentFacingStorage(makeConfig({ type: 's3', bucket: 'b' }));
    expect(r!.url).toBeNull();
  });

  it('filesystem uses fsBaseUrl when set', () => {
    const r = resolveAgentFacingStorage(
      makeConfig({ type: 'filesystem', fsBaseUrl: 'http://orch.local:10143' }),
    );
    expect(r).toEqual({
      url: 'http://orch.local:10143',
      source: 'KICI_STORAGE_FS_BASE_URL',
      fixEnvVar: 'KICI_STORAGE_FS_BASE_URL',
    });
  });

  it('filesystem defaults to loopback on the orchestrator port', () => {
    const r = resolveAgentFacingStorage(makeConfig({ type: 'filesystem' }, 10143));
    expect(r!.url).toBe('http://127.0.0.1:10143');
    expect(r!.fixEnvVar).toBe('KICI_STORAGE_FS_BASE_URL');
  });
});

describe('assertAgentReachableStorage', () => {
  it('throws on s3 loopback endpoint with a scaler', () => {
    expect(() =>
      assertAgentReachableStorage(
        makeConfig({ type: 's3', endpoint: 'http://localhost:8333' }),
        scalerCfg([CONTAINER]),
      ),
    ).toThrow(/KICI_STORAGE_EXTERNAL_ENDPOINT/);
  });

  it('throws on filesystem default loopback with a scaler', () => {
    expect(() =>
      assertAgentReachableStorage(makeConfig({ type: 'filesystem' }), scalerCfg([CONTAINER])),
    ).toThrow(/KICI_STORAGE_FS_BASE_URL/);
  });

  it('is a no-op when no scaler is configured', () => {
    expect(() =>
      assertAgentReachableStorage(
        makeConfig({ type: 's3', endpoint: 'http://localhost:8333' }),
        scalerCfg([]),
      ),
    ).not.toThrow();
  });

  it('is a no-op when scalerConfig is null', () => {
    expect(() =>
      assertAgentReachableStorage(
        makeConfig({ type: 's3', endpoint: 'http://localhost:8333' }),
        null,
      ),
    ).not.toThrow();
  });

  it('is a no-op for a routable external endpoint', () => {
    expect(() =>
      assertAgentReachableStorage(
        makeConfig({
          type: 's3',
          endpoint: 'http://localhost:8333',
          externalEndpoint: 'http://seaweed:8333',
        }),
        scalerCfg([CONTAINER]),
      ),
    ).not.toThrow();
  });

  it('is a no-op when storage is undefined', () => {
    expect(() =>
      assertAgentReachableStorage(makeConfig(undefined), scalerCfg([CONTAINER])),
    ).not.toThrow();
  });
});

describe('co-location by the scaler entry own orchestratorUrl', () => {
  const base = {
    endpointSource: 'KICI_STORAGE_FS_BASE_URL',
    fixEnvVar: 'KICI_STORAGE_FS_BASE_URL',
    agentFacingUrl: 'http://127.0.0.1:10143',
  };

  it('accepts a loopback storage URL for a scaler whose orchestratorUrl is loopback', () => {
    // The local dev plane's shape: bare-metal, but its agents connect to
    // ws://127.0.0.1, so they run on this machine and can reach loopback.
    expect(
      checkLoopbackAgentEndpoint({
        ...base,
        scalers: [{ type: BARE_METAL, orchestratorUrl: 'ws://127.0.0.1:10143/ws' }],
      }),
    ).toBeNull();
  });

  it('still flags a scaler whose orchestratorUrl is routable', () => {
    expect(
      checkLoopbackAgentEndpoint({
        ...base,
        scalers: [{ type: BARE_METAL, orchestratorUrl: 'ws://orch.internal:10143/ws' }],
      }),
    ).not.toBeNull();
  });

  it('falls back to the backend type when no orchestratorUrl is declared', () => {
    expect(checkLoopbackAgentEndpoint({ ...base, scalers: [{ type: BARE_METAL }] })).not.toBeNull();
  });

  it('flags the set when only one scaler is remote', () => {
    expect(
      checkLoopbackAgentEndpoint({
        ...base,
        scalers: [
          { type: BARE_METAL, orchestratorUrl: 'ws://127.0.0.1:10143/ws' },
          { type: CONTAINER },
        ],
      }),
    ).not.toBeNull();
  });

  it('assertAgentReachableStorage passes a loopback-orchestratorUrl plane', () => {
    expect(() =>
      assertAgentReachableStorage(
        makeConfig({ type: 'filesystem', fsBaseUrl: 'http://127.0.0.1:10143' }),
        scalerCfg([{ type: BARE_METAL, orchestratorUrl: 'ws://127.0.0.1:10143/ws' }]),
      ),
    ).not.toThrow();
  });
});

describe('assertAgentAuthBindSafe', () => {
  function authConfig(agentAuth: 'token' | 'none', host: string): AppConfig {
    return { agentAuth, host } as unknown as AppConfig;
  }

  it.each(['0.0.0.0', '::', '192.168.1.85', '::ffff:0.0.0.0', '::ffff:192.168.1.85'])(
    'refuses agentAuth=none on the bind %s',
    (host) => {
      expect(() => assertAgentAuthBindSafe(authConfig('none', host))).toThrow(
        /KICI_AGENT_AUTH=none/,
      );
    },
  );

  it('names both remediations, which are the operator recovery path', () => {
    expect(() => assertAgentAuthBindSafe(authConfig('none', '0.0.0.0'))).toThrow(
      /KICI_HOST=127\.0\.0\.1/,
    );
    expect(() => assertAgentAuthBindSafe(authConfig('none', '0.0.0.0'))).toThrow(
      /KICI_AGENT_AUTH=token/,
    );
  });

  it.each(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1', '[::ffff:127.0.0.1]'])(
    'permits agentAuth=none on %s',
    (host) => {
      expect(() => assertAgentAuthBindSafe(authConfig('none', host))).not.toThrow();
    },
  );

  it.each(['0.0.0.0', '::', '192.168.1.85', '127.0.0.1'])(
    'is a no-op on %s whenever agent auth is enabled',
    (host) => {
      expect(() => assertAgentAuthBindSafe(authConfig('token', host))).not.toThrow();
    },
  );
});
