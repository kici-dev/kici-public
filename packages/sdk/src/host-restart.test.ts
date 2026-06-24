import { describe, it, expect } from 'vitest';
import { waitForHostAlive, restartHost } from './host-restart.js';
import type { StepContext } from './context.js';

describe('waitForHostAlive', () => {
  it('returns a Step that resolves once the probe succeeds', async () => {
    let calls = 0;
    const s = waitForHostAlive(
      () => (++calls >= 2 ? 'ready' : Promise.reject(new Error('not yet'))),
      { intervalMs: 1, timeoutMs: 1000 },
    );
    expect(s.name).toBe('wait-for-host-alive');
    const ctx = { log: { info: () => {} } } as unknown as StepContext;
    await s.run!(ctx);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('treats a falsy-but-defined probe result as ready (only null/undefined keep polling)', async () => {
    let calls = 0;
    const s = waitForHostAlive(
      () => {
        calls++;
        return false; // defined ⇒ ready on first attempt
      },
      { intervalMs: 1, timeoutMs: 1000 },
    );
    const ctx = { log: { info: () => {} } } as unknown as StepContext;
    await s.run!(ctx);
    expect(calls).toBe(1);
  });

  it('honors a custom name', () => {
    const s = waitForHostAlive(() => true, { name: 'svc-ready' });
    expect(s.name).toBe('svc-ready');
  });
});

describe('restartHost', () => {
  it('requests a reboot via ctx.kici.host.requestReboot and resolves', async () => {
    const calls: unknown[] = [];
    const ctx = {
      log: { info: () => {} },
      kici: {
        host: {
          requestReboot: async (o: unknown) => {
            calls.push(o);
          },
        },
      },
    } as unknown as StepContext;
    const s = restartHost({ deadlineMs: 600000 });
    expect(s.name).toBe('restart-host');
    await s.run!(ctx);
    expect(calls).toEqual([{ deadlineMs: 600000 }]);
  });

  it('passes deadlineMs: undefined when no options given', async () => {
    const calls: unknown[] = [];
    const ctx = {
      log: { info: () => {} },
      kici: { host: { requestReboot: async (o: unknown) => calls.push(o) } },
    } as unknown as StepContext;
    await restartHost().run!(ctx);
    expect(calls).toEqual([{ deadlineMs: undefined }]);
  });
});
