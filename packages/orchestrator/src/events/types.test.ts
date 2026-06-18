import { describe, it, expect } from 'vitest';

import { parseFaultInjectionMap } from './types.js';

describe('parseFaultInjectionMap', () => {
  it('returns undefined when testMode is false (master switch off)', () => {
    expect(parseFaultInjectionMap(false, '{"test.x":1}')).toBeUndefined();
  });

  it('returns undefined when the raw value is absent', () => {
    expect(parseFaultInjectionMap(true, undefined)).toBeUndefined();
    expect(parseFaultInjectionMap(true, '')).toBeUndefined();
    expect(parseFaultInjectionMap(true, '   ')).toBeUndefined();
  });

  it('parses a well-formed JSON map', () => {
    expect(parseFaultInjectionMap(true, '{"test.fault":1,"test.dlq":99}')).toEqual({
      'test.fault': 1,
      'test.dlq': 99,
    });
  });

  it('rejects malformed JSON', () => {
    expect(parseFaultInjectionMap(true, '{not json')).toBeUndefined();
  });

  it('rejects non-object JSON', () => {
    expect(parseFaultInjectionMap(true, '"a string"')).toBeUndefined();
    expect(parseFaultInjectionMap(true, '[1, 2]')).toBeUndefined();
    expect(parseFaultInjectionMap(true, 'null')).toBeUndefined();
  });

  it('rejects entries with non-number values', () => {
    expect(parseFaultInjectionMap(true, '{"test":"oops"}')).toBeUndefined();
    expect(parseFaultInjectionMap(true, '{"test":true}')).toBeUndefined();
  });

  it('rejects entries with negative or non-finite numbers', () => {
    expect(parseFaultInjectionMap(true, '{"test":-1}')).toBeUndefined();
  });

  it('returns undefined for an empty object (no actual entries)', () => {
    expect(parseFaultInjectionMap(true, '{}')).toBeUndefined();
  });

  it('accepts zero as a valid budget (always succeed branch)', () => {
    expect(parseFaultInjectionMap(true, '{"test":0}')).toEqual({ test: 0 });
  });
});
