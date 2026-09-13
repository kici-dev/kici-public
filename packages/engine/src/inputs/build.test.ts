import { describe, it, expect } from 'vitest';
import { buildZodFromDescriptor, buildZodObjectFromMap } from './build.js';

describe('buildZodFromDescriptor', () => {
  it('coerces "true"/"false" correctly (NOT the z.coerce.boolean footgun)', () => {
    const b = buildZodFromDescriptor({ type: 'boolean', optional: false, nullable: false });
    expect(b.parse('true')).toBe(true);
    expect(b.parse('false')).toBe(false);
  });
  it('coerces numbers and enforces bounds', () => {
    const n = buildZodFromDescriptor({
      type: 'integer',
      optional: false,
      nullable: false,
      min: 0,
      max: 10,
    });
    expect(n.parse('3')).toBe(3);
    expect(n.safeParse('11').success).toBe(false);
    expect(n.safeParse('x').success).toBe(false);
  });
  it('validates enum membership', () => {
    const e = buildZodFromDescriptor({
      type: 'enum',
      optional: false,
      nullable: false,
      values: ['full', 'edge-only'],
    });
    expect(e.parse('full')).toBe('full');
    expect(e.safeParse('nope').success).toBe(false);
  });
  it('enforces a string regex', () => {
    const s = buildZodFromDescriptor({
      type: 'string',
      optional: false,
      nullable: false,
      pattern: '^box-',
    });
    expect(s.parse('box-1')).toBe('box-1');
    expect(s.safeParse('nope').success).toBe(false);
  });
  it('validates a literal', () => {
    const l = buildZodFromDescriptor({
      type: 'literal',
      optional: false,
      nullable: false,
      literal: 'only',
    });
    expect(l.parse('only')).toBe('only');
    expect(l.safeParse('other').success).toBe(false);
  });
});

describe('buildZodObjectFromMap', () => {
  it('applies default when key omitted', () => {
    const o = buildZodObjectFromMap({
      skipCveScan: { type: 'boolean', optional: false, nullable: false, default: false },
    });
    expect(o.parse({})).toEqual({ skipCveScan: false });
  });
  it('rejects unknown keys', () => {
    const o = buildZodObjectFromMap({ a: { type: 'string', optional: true, nullable: false } });
    expect(o.safeParse({ b: 'x' }).success).toBe(false);
  });
});
