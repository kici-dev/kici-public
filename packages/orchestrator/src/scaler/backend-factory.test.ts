import { describe, it, expect, vi } from 'vitest';
import { createScalerBackend, requiredToolsFor } from './backend-factory.js';
import type { BackendFactoryContext } from './backend-factory.js';
import type { ScalerEntry } from './types.js';
import { InMemoryIpAllocator } from './ip-allocator.js';

function fcEntry(overrides: Partial<ScalerEntry> = {}): ScalerEntry {
  return {
    name: 'fc-pool',
    type: 'firecracker',
    maxAgents: 2,
    maxConcurrentSpawns: 1,
    labelSets: [{ labels: ['linux', 'fc'], rootfsPath: '/srv/rootfs.ext4' }],
    firecrackerPath: '/usr/bin/firecracker',
    jailerPath: '/usr/bin/jailer',
    kernelPath: '/srv/vmlinux',
    uid: 1000,
    gid: 1000,
    requireSudo: true,
    ...overrides,
  } as ScalerEntry;
}

function ctx(overrides: Partial<BackendFactoryContext> = {}): BackendFactoryContext {
  return {
    scalerConfig: { version: 1, globalMaxAgents: 10, scalers: [] } as unknown as never,
    tokenStore: undefined,
    injectAgentToken: false,
    tokenTtlMs: 3_600_000,
    tokenTtlProvider: async () => 3_600_000,
    ipAllocator: (net) => new InMemoryIpAllocator(net),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    ...overrides,
  };
}

describe('createScalerBackend', () => {
  it('passes requireSudo through to the firecracker backend', async () => {
    const backend = await createScalerBackend(fcEntry(), ctx());
    expect(backend).not.toBeNull();
    // `requireSudo` is private; assert via the field the option drives.
    expect((backend as unknown as { requireSudo: boolean }).requireSudo).toBe(true);
  });

  it('leaves requireSudo off when the entry does not ask for it', async () => {
    const backend = await createScalerBackend(fcEntry({ requireSudo: undefined }), ctx());
    expect((backend as unknown as { requireSudo: boolean }).requireSudo).toBe(false);
  });

  it('returns null for an event scaler when the host supplies no emitter', async () => {
    const entry = fcEntry({
      name: 'evt',
      type: 'event',
      provisioningTargets: ['org/infra'],
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const backend = await createScalerBackend(entry, ctx({ logger: logger as never }));
    expect(backend).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('builds an event backend when an emitter and a state store are supplied', async () => {
    const entry = fcEntry({
      name: 'evt',
      type: 'event',
      provisioningTargets: ['org/infra'],
    });
    const backend = await createScalerBackend(
      entry,
      ctx({
        tokenStore: { createEphemeral: vi.fn() } as never,
        stateStore: {} as never,
        eventEmitterProvider: () =>
          ({ emitScalerScaleUp: vi.fn(), emitScalerScaleDown: vi.fn() }) as never,
      }),
    );
    expect(backend?.type).toBe('event');
  });

  it('returns null and warns for an unsupported scaler type', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const entry = fcEntry({ name: 'weird', type: 'kubernetes' as never });
    const backend = await createScalerBackend(entry, ctx({ logger: logger as never }));
    expect(backend).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('withholds the token store from a local backend when injection is off', async () => {
    const tokenStore = { createEphemeral: vi.fn() } as never;
    const backend = await createScalerBackend(
      fcEntry({ name: 'bm', type: 'bare-metal', labelSets: [{ labels: ['bm'] }] }),
      ctx({ tokenStore, injectAgentToken: false }),
    );
    expect((backend as unknown as { tokenStore?: unknown }).tokenStore).toBeUndefined();
  });

  it('passes the token store to a local backend when injection is on', async () => {
    const tokenStore = { createEphemeral: vi.fn() } as never;
    const backend = await createScalerBackend(
      fcEntry({ name: 'bm', type: 'bare-metal', labelSets: [{ labels: ['bm'] }] }),
      ctx({ tokenStore, injectAgentToken: true }),
    );
    expect((backend as unknown as { tokenStore?: unknown }).tokenStore).toBe(tokenStore);
  });
});

describe('requiredToolsFor', () => {
  it('collects tool requirements across mixed scaler types', () => {
    const tools = requiredToolsFor([
      fcEntry(),
      fcEntry({
        name: 'bm',
        type: 'bare-metal',
        labelSets: [{ labels: ['bm'], binaryPath: '/usr/local/bin/kici-agent' }],
      }),
    ]);
    expect(tools.length).toBeGreaterThan(0);
  });

  it('returns no requirements for an event scaler', () => {
    expect(
      requiredToolsFor([fcEntry({ name: 'evt', type: 'event', provisioningTargets: ['o/i'] })]),
    ).toEqual([]);
  });
});
