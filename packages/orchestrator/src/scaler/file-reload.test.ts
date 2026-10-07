import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { ScalerReloadOutcome, type ScalerReloadPlan } from '@kici-dev/engine';
import type { Logger } from '@kici-dev/shared';

const add = vi.fn();
vi.mock('../metrics/prometheus.js', () => ({ scalerConfigReloadsTotal: { add } }));

const { createScalerFileReload, installScalerReloadSignal } = await import('./file-reload.js');
import type { ScalerConfig } from './types.js';
import type { ScalerReloadResult } from './manager.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const config = { version: 1, globalMaxAgents: 10, scalers: [] } as unknown as ScalerConfig;
const plan: ScalerReloadPlan = {
  added: [],
  updated: ['linux'],
  unchanged: [],
  retired: [],
  resurrected: [],
  global: [],
};

function metricResults(): string[] {
  return add.mock.calls.map((c) => (c[1] as { result: string }).result);
}

describe('createScalerFileReload', () => {
  beforeEach(() => add.mockClear());

  // fails-when: a load error reaches manager.reload, or is reported as applied
  it('refuses a file that does not load without calling the manager', async () => {
    const manager = { reload: vi.fn() };
    const reload = createScalerFileReload({
      manager,
      load: async () => {
        throw new Error('scalers.yaml: unexpected end of the stream');
      },
      logger,
    });

    expect(await reload()).toEqual({
      outcome: ScalerReloadOutcome.enum.rejected,
      errors: ['scalers.yaml: unexpected end of the stream'],
    });
    expect(manager.reload).not.toHaveBeenCalled();
    expect(metricResults()).toEqual(['attempted', 'failed']);
  });

  // fails-when: onApplied runs for a refused file
  it('reports the manager refusal and keeps the stored config', async () => {
    const onApplied = vi.fn();
    const reload = createScalerFileReload({
      manager: { reload: vi.fn(async () => ({ valid: false as const, errors: ['overlap'] })) },
      load: async () => config,
      onApplied,
      logger,
    });

    expect(await reload()).toEqual({
      outcome: ScalerReloadOutcome.enum.rejected,
      errors: ['overlap'],
    });
    expect(onApplied).not.toHaveBeenCalled();
    expect(metricResults()).toEqual(['attempted', 'failed']);
  });

  // breaks-if-wrong: a valid file still applies and refreshes the stored config
  it('applies a valid file and returns the plan', async () => {
    const onApplied = vi.fn();
    const reload = createScalerFileReload({
      manager: { reload: vi.fn(async () => ({ valid: true as const, plan })) },
      load: async () => config,
      onApplied,
      logger,
    });

    expect(await reload()).toEqual({ outcome: ScalerReloadOutcome.enum.applied, plan });
    expect(onApplied).toHaveBeenCalledExactlyOnceWith(config);
    expect(metricResults()).toEqual(['attempted', 'success']);
  });

  it('answers not-configured when the orchestrator runs no scaler config', async () => {
    const load = vi.fn();
    const reload = createScalerFileReload({ manager: null, load, logger });

    expect(await reload()).toEqual({ outcome: ScalerReloadOutcome.enum['not-configured'] });
    expect(load).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  // fails-when: two overlapping calls interleave, so the second reads the file
  // before the first finished applying
  it('runs overlapping calls one after the other, each with its own outcome', async () => {
    const events: string[] = [];
    let release!: () => void;
    const firstGate = new Promise<void>((r) => (release = r));
    let call = 0;
    const manager = {
      reload: vi.fn(async (): Promise<ScalerReloadResult> => {
        const n = ++call;
        events.push(`reload-start-${n}`);
        if (n === 1) await firstGate;
        events.push(`reload-end-${n}`);
        return n === 1 ? { valid: true, plan } : { valid: false, errors: ['second'] };
      }),
    };
    let loads = 0;
    const reload = createScalerFileReload({
      manager,
      load: async () => {
        events.push(`load-${++loads}`);
        return config;
      },
      logger,
    });

    const first = reload();
    const second = reload();
    await vi.waitFor(() => expect(events).toContain('reload-start-1'));
    expect(events).not.toContain('load-2');
    release();

    expect(await first).toEqual({ outcome: ScalerReloadOutcome.enum.applied, plan });
    expect(await second).toEqual({
      outcome: ScalerReloadOutcome.enum.rejected,
      errors: ['second'],
    });
    expect(events).toEqual([
      'load-1',
      'reload-start-1',
      'reload-end-1',
      'load-2',
      'reload-start-2',
      'reload-end-2',
    ]);
  });

  it('turns a throwing manager into a refusal, and the next call still runs', async () => {
    const manager = {
      reload: vi
        .fn<() => Promise<ScalerReloadResult>>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ valid: true, plan }),
    };
    const reload = createScalerFileReload({ manager, load: async () => config, logger });

    expect(await reload()).toEqual({
      outcome: ScalerReloadOutcome.enum.rejected,
      errors: ['boom'],
    });
    expect(await reload()).toEqual({ outcome: ScalerReloadOutcome.enum.applied, plan });
  });
});

describe('installScalerReloadSignal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reloads once for a burst of signals, after the debounce', async () => {
    const signals = new EventEmitter();
    const reload = vi.fn(async () => ({ outcome: ScalerReloadOutcome.enum.applied }));
    installScalerReloadSignal(reload, logger, signals);

    signals.emit('SIGHUP');
    await vi.advanceTimersByTimeAsync(200);
    signals.emit('SIGHUP');
    await vi.advanceTimersByTimeAsync(499);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('the disposer removes the listener and cancels a pending reload', async () => {
    const signals = new EventEmitter();
    const reload = vi.fn(async () => ({ outcome: ScalerReloadOutcome.enum.applied }));
    const dispose = installScalerReloadSignal(reload, logger, signals);

    signals.emit('SIGHUP');
    dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reload).not.toHaveBeenCalled();
    expect(signals.listenerCount('SIGHUP')).toBe(0);
  });

  // fails-when: no SIGHUP listener is installed on the real process, so
  // Node.js's default action terminates it on the signal
  // breaks-if-wrong: the disposer leaves no listener behind
  it('installs on and removes from the real process by default', () => {
    const before = process.listenerCount('SIGHUP');
    const dispose = installScalerReloadSignal(vi.fn(), logger);
    expect(process.listenerCount('SIGHUP')).toBe(before + 1);
    dispose();
    expect(process.listenerCount('SIGHUP')).toBe(before);
  });
});
