import { describe, expect, it, vi } from 'vitest';
import { waitFor, waitForStep, WaitForTimeoutError } from './wait-for.js';
import type { StepContext, Logger } from './context.js';

interface Value {
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
  const ctx = { log } as unknown as StepContext;
  return { ctx, logged };
}

describe('waitFor (generic helper)', () => {
  it('returns succeeded on the first attempt when check yields a value immediately', async () => {
    const value: Value = { id: 'first' };
    const result = await waitFor<Value>({
      name: 'first-hit',
      check: async () => value,
      intervalMs: 10,
      timeoutMs: 200,
      log: () => {},
    });
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;
    expect(result.attempts).toBe(1);
    expect(result.value).toEqual(value);
    expect(result.result).toBeUndefined();
  });

  it('polls until check yields a value after several null returns', async () => {
    let calls = 0;
    const result = await waitFor<Value>({
      name: 'eventual-hit',
      check: async () => {
        calls += 1;
        return calls >= 3 ? { id: 'late' } : null;
      },
      intervalMs: 5,
      timeoutMs: 500,
      log: () => {},
    });
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;
    expect(result.attempts).toBe(3);
    expect(result.value).toEqual({ id: 'late' });
  });

  it('threads onSuccess return value into result', async () => {
    const result = await waitFor<Value, string>({
      name: 'with-on-success',
      check: async () => ({ id: 'x' }),
      onSuccess: async (value) => `resolved-${value.id}`,
      intervalMs: 5,
      timeoutMs: 100,
      log: () => {},
    });
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;
    expect(result.result).toBe('resolved-x');
  });

  it('throws WaitForTimeoutError with stats when no onTimeout is supplied', async () => {
    // Node's setTimeout can fire a few ms early on Linux; assert with a small
    // tolerance band against the literal timeout.
    const TIMEOUT = 80;
    const TIMER_SLACK = 5;
    const before = Date.now();
    try {
      await waitFor<Value>({
        name: 'never-hits',
        check: async () => null,
        intervalMs: 10,
        timeoutMs: TIMEOUT,
        log: () => {},
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WaitForTimeoutError);
      if (!(err instanceof WaitForTimeoutError)) return;
      expect(err.name).toBe('WaitForTimeoutError');
      expect(err.stepName).toBe('never-hits');
      expect(err.attempts).toBeGreaterThan(0);
      expect(err.elapsedMs).toBeGreaterThanOrEqual(TIMEOUT - TIMER_SLACK);
      expect(err.elapsedMs).toBeLessThan(Date.now() - before + 200);
    }
  });

  it('returns timed-out + onTimeout result when deadline is exceeded', async () => {
    const TIMEOUT = 80;
    const TIMER_SLACK = 5;
    const result = await waitFor<Value, void, string>({
      name: 'graceful-timeout',
      check: async () => null,
      onTimeout: async ({ elapsedMs, attempts }) =>
        `gave-up-after-${attempts}-attempts-${elapsedMs > 0 ? 'with-time' : 'no-time'}`,
      intervalMs: 10,
      timeoutMs: TIMEOUT,
      log: () => {},
    });
    expect(result.outcome).toBe('timed-out');
    if (result.outcome !== 'timed-out') return;
    expect(result.attempts).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(TIMEOUT - TIMER_SLACK);
    expect(result.result).toContain('gave-up-after-');
  });

  it('swallows check() errors by default and keeps polling', async () => {
    let calls = 0;
    const result = await waitFor<Value>({
      name: 'flaky-check',
      check: async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        if (calls === 2) return null;
        return { id: 'ok' };
      },
      intervalMs: 5,
      timeoutMs: 500,
      log: () => {},
    });
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;
    expect(result.value).toEqual({ id: 'ok' });
    expect(result.attempts).toBe(3);
  });

  it('propagates check() errors when swallowErrors is false', async () => {
    let calls = 0;
    const err = new Error('hard fail');
    await expect(
      waitFor<Value>({
        name: 'no-swallow',
        check: async () => {
          calls += 1;
          throw err;
        },
        swallowErrors: false,
        intervalMs: 5,
        timeoutMs: 500,
        log: () => {},
      }),
    ).rejects.toBe(err);
    expect(calls).toBe(1);
  });

  it('respects initialDelayMs before the first check()', async () => {
    // Node's setTimeout can fire a few milliseconds early on some hosts, so
    // we assert against a tolerance band rather than the literal delay value.
    const INITIAL_DELAY = 80;
    const TIMER_SLACK = 5;
    const start = Date.now();
    const result = await waitFor<Value>({
      name: 'with-initial-delay',
      check: async () => ({ id: 'after-delay' }),
      initialDelayMs: INITIAL_DELAY,
      intervalMs: 5,
      timeoutMs: 1000,
      log: () => {},
    });
    const elapsed = Date.now() - start;
    expect(result.outcome).toBe('succeeded');
    expect(elapsed).toBeGreaterThanOrEqual(INITIAL_DELAY - TIMER_SLACK);
    if (result.outcome !== 'succeeded') return;
    expect(result.elapsedMs).toBeGreaterThanOrEqual(INITIAL_DELAY - TIMER_SLACK);
  });
});

describe('waitForStep (Step factory)', () => {
  it('returns a Step object tagged correctly with the call-site location captured', () => {
    const s = waitForStep<Value>('await-resource', {
      check: async () => ({ id: 'x' }),
      intervalMs: 5,
      timeoutMs: 100,
    });
    expect(s._tag).toBe('Step');
    expect(s.name).toBe('await-resource');
    expect(typeof s.run).toBe('function');
    expect(s._sourceLocation).toBeDefined();
  });

  it('wires ctx.log.info as the runner log sink', async () => {
    const { ctx, logged } = makeCtx();
    const s = waitForStep<Value>('await-resource', {
      check: async () => ({ id: 'x' }),
      intervalMs: 5,
      timeoutMs: 100,
    });
    await s.run(ctx);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.some((line) => line.includes('await-resource'))).toBe(true);
  });

  it('propagates the typed WaitForResult from the step run', async () => {
    const { ctx } = makeCtx();
    const onSuccess = vi.fn<(v: Value) => Promise<string>>().mockResolvedValue('done');
    const s = waitForStep<Value, string>('await-resource-typed', {
      check: async () => ({ id: 'first' }),
      onSuccess,
      intervalMs: 5,
      timeoutMs: 100,
    });
    const result = await s.run(ctx);
    expect(result.outcome).toBe('succeeded');
    if (result.outcome !== 'succeeded') return;
    expect(result.value).toEqual({ id: 'first' });
    expect(result.result).toBe('done');
    expect(onSuccess).toHaveBeenCalledOnce();
  });
});
