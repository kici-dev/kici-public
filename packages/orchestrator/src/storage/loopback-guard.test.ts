import { describe, it, expect } from 'vitest';
import { ScalerBackendType } from '@kici-dev/engine';
import {
  isLoopbackHost,
  checkLoopbackAgentEndpoint,
  resolveAgentFacingStorage,
  assertAgentReachableStorage,
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
  ])('isLoopbackHost(%s) === %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
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
      scalerBackends: [CONTAINER],
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
      scalerBackends: [backend],
    });
    expect(drift).not.toBeNull();
  });

  it('passes a routable endpoint', () => {
    expect(
      checkLoopbackAgentEndpoint({
        ...base,
        agentFacingUrl: 'http://seaweedfs.internal:8333',
        scalerBackends: [CONTAINER],
      }),
    ).toBeNull();
  });

  it('passes when no scaler is configured (loopback is fine, agents co-located)', () => {
    expect(
      checkLoopbackAgentEndpoint({
        ...base,
        agentFacingUrl: 'http://localhost:8333',
        scalerBackends: [],
      }),
    ).toBeNull();
  });

  it('passes when agentFacingUrl is null (real AWS / no custom endpoint)', () => {
    expect(
      checkLoopbackAgentEndpoint({
        ...base,
        agentFacingUrl: null,
        scalerBackends: [CONTAINER],
      }),
    ).toBeNull();
  });

  it('passes when the URL is unparseable (cannot determine host — do not block)', () => {
    expect(
      checkLoopbackAgentEndpoint({
        ...base,
        agentFacingUrl: 'not a url',
        scalerBackends: [CONTAINER],
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
function scalerCfg(types: ScalerEntry['type'][]): ScalerConfig {
  return {
    globalMaxAgents: 50,
    scalers: types.map((type, i) => ({ name: `s${i}`, type }) as ScalerEntry),
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
