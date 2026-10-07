import { describe, expect, it } from 'vitest';
import { safeJsonParse } from './json.js';

describe('safeJsonParse', () => {
  it('parses valid JSON, including a JSON null and a scalar', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse('"x"')).toBe('x');
    expect(safeJsonParse('null')).toBeNull();
  });

  // fails-when: invalid JSON throws, or yields undefined instead of null
  it.each(['{', 'not json', '', null, undefined])('returns null for %j', (raw) => {
    expect(safeJsonParse(raw)).toBeNull();
  });
});
