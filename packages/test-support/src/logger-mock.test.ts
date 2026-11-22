import { describe, expect, it } from 'vitest';
import { silentLogger, withPrefixedLogger, withSilentLogger } from './logger-mock.js';

describe('withPrefixedLogger', () => {
  it('returns the given logger for one prefix and the real one for the rest', () => {
    const real = {
      sha256: (s: string) => `h:${s}`,
      createLogger: (opts?: { prefix?: string }) => `real:${opts?.prefix ?? ''}`,
    };
    const logger = silentLogger();
    const mocked = withPrefixedLogger(real, 'runs-api', logger);
    // fails-when: the prefix is ignored, so the module's lines go to the real logger.
    expect(mocked.createLogger({ prefix: 'runs-api' } as never)).toBe(logger);
    // breaks-if-wrong: every other module keeps its real logger and the other exports stay.
    expect(mocked.createLogger({ prefix: 'other' } as never)).toBe('real:other');
    expect(mocked.sha256('x')).toBe('h:x');
  });
});

describe('withSilentLogger', () => {
  it('keeps every real export and replaces the logger', () => {
    const real = {
      sha256: (s: string) => `h:${s}`,
      createLogger: () => 'real',
      toErrorMessage: () => 'real',
    };
    const mocked = withSilentLogger(real);
    // fails-when: the body drops the real exports instead of spreading them.
    expect(mocked.sha256('x')).toBe('h:x');
    const log = mocked.createLogger();
    log.info('not printed');
    // fails-when: createLogger still returns the real logger.
    expect(log.info).toHaveBeenCalledWith('not printed');
  });

  it('renders error messages deterministically', () => {
    const mocked = withSilentLogger({});
    expect(mocked.toErrorMessage(new Error('boom'))).toBe('boom');
    expect(mocked.toErrorMessage(42)).toBe('42');
  });

  it('gives each createLogger call fresh mocks', () => {
    // fails-when: one logger instance is shared, so a call recorded in one
    // test leaks into the next.
    expect(silentLogger().warn).not.toBe(silentLogger().warn);
    const mocked = withSilentLogger({});
    expect(mocked.createLogger()).not.toBe(mocked.createLogger());
  });
});
