import { describe, expect, it } from 'vitest';
import { silentLogger, withSilentLogger } from './logger-mock.js';

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
