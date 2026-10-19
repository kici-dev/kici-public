import { describe, expect, it } from 'vitest';
import { ConfigValidationError, isConfigValidationError } from './config-validation-error.js';

describe('ConfigValidationError', () => {
  it('formats one line per issue with the env var', () => {
    const err = new ConfigValidationError([
      { envVar: 'KICI_URL', field: 'url', message: 'not set (required)' },
      { envVar: 'KICI_N', field: 'n', message: 'Invalid input' },
    ]);
    expect(err.message).toBe(
      'Configuration validation failed:\n  - KICI_URL: not set (required)\n  - KICI_N: Invalid input',
    );
    expect(err.name).toBe('ConfigValidationError');
  });

  it('omits the name when the message already names the env var', () => {
    const err = new ConfigValidationError([
      { envVar: 'KICI_URL', field: 'url', message: 'KICI_URL is required in platform mode' },
    ]);
    expect(err.message).toBe(
      'Configuration validation failed:\n  - KICI_URL is required in platform mode',
    );
  });

  // fails-when: the omission is a plain substring test — KICI_PORT_X would hide KICI_PORT,
  // and field `n` would vanish inside "Invalid input".
  it('keeps the name when the message only contains it as part of a longer word', () => {
    const err = new ConfigValidationError([
      { envVar: 'KICI_PORT', field: 'port', message: 'conflicts with KICI_PORT_X' },
      { field: 'n', message: 'Invalid input' },
    ]);
    expect(err.message).toBe(
      'Configuration validation failed:\n  - KICI_PORT: conflicts with KICI_PORT_X\n  - n: Invalid input',
    );
  });

  it('falls back to the field path without an env var', () => {
    const err = new ConfigValidationError([
      { field: 'valkey.host', message: 'Required' },
      { field: '', message: 'Whole object invalid' },
    ]);
    expect(err.message).toBe(
      'Configuration validation failed:\n  - valkey.host: Required\n  - Whole object invalid',
    );
  });

  it('appends the hint as the last line', () => {
    const err = new ConfigValidationError(
      [{ envVar: 'KICI_URL', field: 'url', message: 'not set (required)' }],
      'See the docs.',
    );
    expect(err.message.split('\n').at(-1)).toBe('See the docs.');
  });

  it('isConfigValidationError matches by brand, not instanceof', () => {
    const foreign = Object.assign(new Error('x'), {
      [Symbol.for('kici.configValidationError')]: true,
      issues: [],
    });
    expect(isConfigValidationError(foreign)).toBe(true);
    expect(isConfigValidationError(new ConfigValidationError([]))).toBe(true);
    expect(isConfigValidationError(new Error('x'))).toBe(false);
    expect(isConfigValidationError({ message: 'x' })).toBe(false);
  });
});
