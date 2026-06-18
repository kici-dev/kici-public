import { describe, expect, it, vi } from 'vitest';
import { idempotent, idempotentStep } from './idempotent.js';
import type { StepContext, Logger } from './context.js';

interface Drift {
  reason: string;
}

interface ResourceId {
  id: string;
}

function makeCtx(): { ctx: StepContext; logged: string[] } {
  const logged: string[] = [];
  const log: Logger = {
    info: (msg: string) => logged.push(msg),
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  // Minimal StepContext stub — idempotentStep only reads ctx.log.info.
  const ctx = { log } as unknown as StepContext;
  return { ctx, logged };
}

describe('idempotent (generic helper)', () => {
  it('returns skipped + whenInSync value when check yields null', async () => {
    const whenInSync = vi.fn<() => Promise<ResourceId>>().mockResolvedValue({ id: 'existing-1' });
    const apply = vi.fn<(d: Drift) => Promise<ResourceId>>().mockResolvedValue({ id: 'new-1' });
    const result = await idempotent<Drift, ResourceId, ResourceId>({
      name: 'fetch-or-create',
      check: async () => null,
      apply,
      whenInSync,
      log: () => {},
    });
    expect(result.outcome).toBe('skipped');
    expect(result.drift).toBeNull();
    expect(result.result).toEqual({ id: 'existing-1' });
    expect(whenInSync).toHaveBeenCalledOnce();
    expect(apply).not.toHaveBeenCalled();
  });

  it('returns applied + apply return value when drift is detected', async () => {
    const drift: Drift = { reason: 'missing' };
    const apply = vi.fn<(d: Drift) => Promise<ResourceId>>().mockResolvedValue({ id: 'created-1' });
    const result = await idempotent<Drift, ResourceId, ResourceId>({
      name: 'fetch-or-create',
      check: async () => drift,
      apply,
      whenInSync: async () => ({ id: 'unused' }),
      log: () => {},
    });
    expect(result.outcome).toBe('applied');
    expect(result.drift).toEqual(drift);
    expect(result.result).toEqual({ id: 'created-1' });
    expect(apply).toHaveBeenCalledWith(drift);
  });

  it('defaults result to undefined on the applied branch when apply returns void', async () => {
    const drift: Drift = { reason: 'missing' };
    const apply = vi.fn<(d: Drift) => Promise<void>>().mockResolvedValue(undefined);
    const result = await idempotent<Drift>({
      check: async () => drift,
      apply,
      log: () => {},
    });
    expect(result.outcome).toBe('applied');
    expect(result.result).toBeUndefined();
  });

  it('defaults result to undefined on the skipped branch when whenInSync is not provided', async () => {
    const result = await idempotent<Drift>({
      check: async () => null,
      apply: async () => undefined,
      log: () => {},
    });
    expect(result.outcome).toBe('skipped');
    expect(result.result).toBeUndefined();
  });
});

describe('idempotentStep (Step factory)', () => {
  it('returns a Step object tagged correctly', () => {
    const s = idempotentStep<Drift>('ensure-resource', {
      check: async () => null,
      apply: async () => undefined,
    });
    expect(s._tag).toBe('Step');
    expect(s.name).toBe('ensure-resource');
    expect(typeof s.run).toBe('function');
  });

  it('wires ctx.log.info as the runner log sink', async () => {
    const { ctx, logged } = makeCtx();
    const s = idempotentStep<Drift>('ensure-resource', {
      check: async () => null,
      apply: async () => undefined,
    });
    await s.run(ctx);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.some((line) => line.includes('ensure-resource'))).toBe(true);
  });

  it('returns the typed IdempotentResult from the step run', async () => {
    const { ctx } = makeCtx();
    const drift: Drift = { reason: 'missing' };
    const s = idempotentStep<Drift, void, ResourceId>('create-resource', {
      check: async () => drift,
      apply: async () => ({ id: 'made-2' }),
    });
    const result = await s.run(ctx);
    expect(result.outcome).toBe('applied');
    expect(result.drift).toEqual(drift);
    expect(result.result).toEqual({ id: 'made-2' });
  });

  it('integrates with the step() factory (callable, has source-location field)', async () => {
    const s = idempotentStep<Drift, ResourceId>('fetch-or-create', {
      check: async () => null,
      apply: async () => undefined,
      whenInSync: async () => ({ id: 'existing-2' }),
    });
    expect(s._tag).toBe('Step');
    expect(s.name).toBe('fetch-or-create');
    // Source location is captured inside the SDK file; acceptable for v1.
    expect(s._sourceLocation).toBeDefined();
    const { ctx } = makeCtx();
    const result = await s.run(ctx);
    expect(result.outcome).toBe('skipped');
    expect(result.result).toEqual({ id: 'existing-2' });
  });
});
