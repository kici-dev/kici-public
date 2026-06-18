import { describe, it, expect } from 'vitest';
import { serializeError, toErrorMessage } from './error.js';

describe('toErrorMessage', () => {
  it('returns Error.message for Error instances', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('falls back to String() for non-Error values', () => {
    expect(toErrorMessage('plain string')).toBe('plain string');
    expect(toErrorMessage(42)).toBe('42');
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage(undefined)).toBe('undefined');
  });
});

describe('serializeError', () => {
  it('captures Error message + name', () => {
    const err = new Error('something broke');
    err.name = 'CustomError';
    expect(serializeError(err)).toEqual({ message: 'something broke', name: 'CustomError' });
  });

  it('omits name when it is the default "Error"', () => {
    expect(serializeError(new Error('boom'))).toEqual({ message: 'boom' });
  });

  it('replaces empty message with a non-empty descriptor', () => {
    const out = serializeError(new Error(''));
    expect(out.message).toMatch(/^<Error with empty message>$/);
  });

  it('captures node-style .code on system errors', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const out = serializeError(err);
    expect(out.message).toBe('connect ECONNREFUSED');
    expect(out.code).toBe('ECONNREFUSED');
  });

  it('captures HTTP response status + statusText + trimmed body', () => {
    const err = Object.assign(new Error(''), {
      isVaultError: true,
      response: { status: 500, statusText: 'Internal Server Error', data: { errors: ['oops'] } },
    });
    const out = serializeError(err);
    expect(out.status).toBe(500);
    expect(out.statusText).toBe('Internal Server Error');
    expect(out.responseData).toEqual({ errors: ['oops'] });
    expect(out.message).toMatch(/<Error with empty message>/);
  });

  it('truncates oversized response bodies to keep logs readable', () => {
    const big = 'x'.repeat(2000);
    const err = Object.assign(new Error('boom'), { response: { status: 500, data: big } });
    const out = serializeError(err);
    expect(typeof out.responseData).toBe('string');
    expect((out.responseData as string).length).toBeLessThan(big.length);
    expect(out.responseData).toMatch(/…\(\+\d+ chars\)$/);
  });

  it('serializes plain (non-Error) thrown objects with empty message', () => {
    const out = serializeError({ isVaultError: true, response: { status: 502 } });
    expect(out.message).toMatch(/<object\{isVaultError,response\}>/);
    expect(out.status).toBe(502);
  });

  it('walks .cause chains', () => {
    const inner = Object.assign(new Error('inner'), { code: 'ECONNRESET' });
    const outer = new Error('outer');
    (outer as Error & { cause: unknown }).cause = inner;
    const out = serializeError(outer);
    expect(out.cause).toEqual({ message: 'inner', code: 'ECONNRESET' });
  });

  it('handles primitives + nullish gracefully', () => {
    expect(serializeError(undefined)).toEqual({ message: 'undefined' });
    expect(serializeError(null)).toEqual({ message: 'null' });
    expect(serializeError('plain')).toEqual({ message: 'plain' });
    expect(serializeError(42)).toEqual({ message: '42' });
  });
});
