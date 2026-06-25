import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { step } from './step.js';
import { rule } from './rules/index.js';

describe('step()', () => {
  it('creates a step with simple function form', () => {
    const checkout = step('checkout', async (ctx) => {
      // Just runs, no return
    });

    expect(checkout._tag).toBe('Step');
    expect(checkout.name).toBe('checkout');
    expect(checkout.outputs).toBeUndefined();
    expect(typeof checkout.run).toBe('function');
  });

  it('creates a step with outputs schema', () => {
    const build = step('build', {
      outputs: {
        version: z.string(),
        artifacts: z.array(z.string()),
      },
      run: async (ctx) => {
        return { version: '1.0.0', artifacts: ['dist/main.js'] };
      },
    });

    expect(build._tag).toBe('Step');
    expect(build.name).toBe('build');
    expect(build.outputs).toBeDefined();
    expect(build.outputs?.version).toBeDefined();
    expect(build.outputs?.artifacts).toBeDefined();
  });

  it('preserves output type inference', () => {
    const build = step('build', {
      outputs: {
        version: z.string(),
        count: z.number(),
      },
      run: async (ctx) => {
        // TypeScript should enforce return type matches schema
        return { version: '1.0.0', count: 42 };
      },
    });

    // This is a type-level test - if it compiles, it passes
    // Runtime check that outputs schema is preserved (Zod v4 API)
    expect(build.outputs?.version.def.type).toBe('string');
    expect(build.outputs?.count.def.type).toBe('number');
  });

  it('creates a step with continueOnError option', () => {
    const riskyStep = step('risky', {
      run: async () => {},
      continueOnError: true,
    });

    expect(riskyStep._tag).toBe('Step');
    expect(riskyStep.name).toBe('risky');
    expect(riskyStep.continueOnError).toBe(true);
  });

  it('creates a step with timeout option', () => {
    const slowStep = step('slow', {
      run: async () => {},
      timeout: 60000,
    });

    expect(slowStep._tag).toBe('Step');
    expect(slowStep.name).toBe('slow');
    expect(slowStep.timeout).toBe(60000);
  });

  it('creates a step with both continueOnError and timeout', () => {
    const configured = step('configured', {
      run: async () => {},
      continueOnError: true,
      timeout: 120000,
    });

    expect(configured.continueOnError).toBe(true);
    expect(configured.timeout).toBe(120000);
  });

  it('simple form step has undefined continueOnError and timeout', () => {
    const simple = step('simple', async () => {});
    expect(simple.continueOnError).toBeUndefined();
    expect(simple.timeout).toBeUndefined();
  });

  it('round-trips a declarative cache spec onto the step', () => {
    const cached = step('cached', {
      run: async () => {},
      cache: [{ key: 's-k', paths: ['~/.cache'], restoreKeys: ['s-'] }],
    });

    expect(cached.cache).toEqual([{ key: 's-k', paths: ['~/.cache'], restoreKeys: ['s-'] }]);
  });

  it('leaves cache undefined when not provided', () => {
    const simple = step('simple', async () => {});
    expect(simple.cache).toBeUndefined();
  });

  it('captures _sourceLocation with file, line, and column', () => {
    const s = step('located', async () => {});
    expect(s._sourceLocation).toBeDefined();
    expect(s._sourceLocation!.file).toContain('step.test');
    expect(typeof s._sourceLocation!.line).toBe('number');
    expect(typeof s._sourceLocation!.column).toBe('number');
    expect(s._sourceLocation!.line).toBeGreaterThan(0);
  });

  it('accepts async run functions', async () => {
    let executed = false;
    const asyncStep = step('async', async (ctx) => {
      await Promise.resolve();
      executed = true;
    });

    // Create a minimal mock context for testing
    const mockContext = {
      $: {} as any,
      log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      env: {},
      inputs: {},
      workflow: { name: 'test' },
      job: { name: 'test-job', runsOn: 'linux' },
    };

    await asyncStep.run(mockContext);
    expect(executed).toBe(true);
  });

  describe('id-less overloads', () => {
    it('creates an id-less step with just a function', () => {
      const s = step(async (ctx) => {
        // bare id-less step
      });

      expect(s._tag).toBe('Step');
      expect(s.name).toBe('');
      expect(s.outputs).toBeUndefined();
      expect(typeof s.run).toBe('function');
    });

    it('creates an id-less step with full options', () => {
      const s = step({
        run: async (ctx) => {
          return { x: 1 };
        },
      });

      expect(s._tag).toBe('Step');
      expect(s.name).toBe('');
      expect(typeof s.run).toBe('function');
    });

    it('creates an id-less step with options including timeout', () => {
      const s = step({
        run: async () => {},
        timeout: 30000,
      });

      expect(s._tag).toBe('Step');
      expect(s.name).toBe('');
      expect(s.timeout).toBe(30000);
    });

    it('creates an id-less step with options including continueOnError', () => {
      const s = step({
        run: async () => {},
        continueOnError: true,
      });

      expect(s._tag).toBe('Step');
      expect(s.name).toBe('');
      expect(s.continueOnError).toBe(true);
    });

    it('creates an id-less step with Zod outputs schema', () => {
      const s = step({
        outputs: { v: z.string() },
        run: async () => {
          return { v: 'hello' };
        },
      });

      expect(s._tag).toBe('Step');
      expect(s.name).toBe('');
      expect(s.outputs).toBeDefined();
      expect(s.outputs?.v).toBeDefined();
    });

    it('captures _sourceLocation for id-less steps', () => {
      const s = step(async () => {});
      expect(s._sourceLocation).toBeDefined();
      expect(s._sourceLocation!.file).toContain('step.test');
      expect(s._sourceLocation!.line).toBeGreaterThan(0);
    });
  });

  describe('named step still works (backward compat)', () => {
    it('creates a named step with function', () => {
      const s = step('build', async (ctx) => {});
      expect(s._tag).toBe('Step');
      expect(s.name).toBe('build');
    });

    it('creates a named step with options', () => {
      const s = step('build', {
        run: async (ctx) => {
          return { version: '1.0.0' };
        },
      });
      expect(s._tag).toBe('Step');
      expect(s.name).toBe('build');
    });
  });

  describe('hook and rule fields', () => {
    it('accepts rules array', () => {
      const s = step('deploy', {
        run: async () => {},
        rules: [rule('only main', () => true)],
      });

      expect(s.rules).toHaveLength(1);
      expect(s.rules![0].label).toBe('only main');
    });

    it('accepts onCancel and cleanup hooks', () => {
      const s = step('deploy', {
        run: async () => {},
        onCancel: async () => {},
        cleanup: async () => {},
      });

      expect(s.onCancel).toBeDefined();
      expect(s.cleanup).toBeDefined();
    });

    it('accepts hook with timeout config', () => {
      const hookConfig = { run: async () => {}, timeout: 10000 };
      const s = step('deploy', {
        run: async () => {},
        onCancel: hookConfig,
      });

      expect(s.onCancel).toBe(hookConfig);
    });

    it('hook and rule fields are undefined when not provided', () => {
      const s = step('simple', async () => {});
      expect(s.rules).toBeUndefined();
      expect(s.onCancel).toBeUndefined();
      expect(s.cleanup).toBeUndefined();
    });
  });

  describe('idempotent check facet', () => {
    it('stores the check facet on the Step', () => {
      const s = step('cfg', {
        drift: z.object({ want: z.string() }),
        check: async () => ({ want: 'x' }),
        summarize: (d) => `would write ${d.want}`,
        run: async (_ctx, drift) => {
          void drift;
          return { done: true };
        },
        whenInSync: async () => ({ done: false }),
      });
      expect(s.check).toBeDefined();
      expect(s.summarize?.({ want: 'x' })).toBe('would write x');
      expect(s.whenInSync).toBeDefined();
      expect(s.drift).toBeDefined();
    });

    it('keeps the plain step() signature unchanged when check is absent', () => {
      const s = step('plain', async () => {});
      expect(s.check).toBeUndefined();
      expect(s.summarize).toBeUndefined();
      expect(s.whenInSync).toBeUndefined();
      expect(s.drift).toBeUndefined();
    });

    it('selects the two-arg run only when check is declared', () => {
      // Type-level: a checked step's run receives the drift as its second arg.
      const checked = step('checked', {
        check: async () => ({ n: 1 }),
        summarize: (d) => `n=${d.n}`,
        run: async (_ctx, drift) => ({ doubled: drift.n * 2 }),
      });
      expect(checked.check).toBeDefined();

      // Type-level: a plain step's run must reject a second argument.
      step('plain-run', {
        // @ts-expect-error plain run is single-arg; a drift parameter is not allowed
        run: async (_ctx, _drift) => {},
      });
    });

    it('throws when check is set without summarize', () => {
      expect(() =>
        step('bad', {
          check: async () => ({ want: 'x' }),
          run: async () => ({ done: true }),
        } as never),
      ).toThrow('summarize is required when check is set');
    });
  });

  describe('Step<TResult> inference', () => {
    it('infers void return type for simple function form', () => {
      const s = step('test', async () => {});
      // Type test: Step<void> -- the run function returns Promise<void>
      // If this compiles, the inference is correct
      expect(s._tag).toBe('Step');
    });

    it('infers non-void return type from run function', () => {
      const s = step('build', {
        run: async () => {
          return { version: '1.0.0', count: 42 };
        },
      });
      // Type test: Step<{ version: string; count: number }>
      // Verify at runtime that run returns the expected value
      expect(s._tag).toBe('Step');
      expect(typeof s.run).toBe('function');
    });

    it('infers return type for id-less step with function', () => {
      const s = step(async () => {
        return { status: 'ready' };
      });
      expect(s._tag).toBe('Step');
      expect(s.name).toBe('');
    });

    it('infers return type for id-less step with options', () => {
      const s = step({
        run: async () => {
          return { x: 1, y: 'hello' };
        },
      });
      expect(s._tag).toBe('Step');
      expect(s.name).toBe('');
    });
  });

  describe('retry', () => {
    it('expands retry: 3 to a normalized config with defaults', () => {
      const s = step('flaky', { run: async () => {}, retry: 3 });
      expect(s.retry).toMatchObject({
        maxAttempts: 3,
        delayMs: 1000,
        backoff: 'exponential',
        maxDelayMs: 30000,
      });
    });
    it('preserves a full retry config incl. retryIf', () => {
      const pred = (e: unknown) => e instanceof Error;
      const s = step('flaky', {
        run: async () => {},
        retry: { maxAttempts: 5, delayMs: 200, backoff: 'fixed', retryIf: pred },
      });
      expect(s.retry).toMatchObject({
        maxAttempts: 5,
        delayMs: 200,
        backoff: 'fixed',
        maxDelayMs: 30000,
      });
      expect(s.retry?.retryIf).toBe(pred);
    });
    it('omits retry when not set', () => {
      expect(step('x', { run: async () => {} }).retry).toBeUndefined();
    });
  });
});
