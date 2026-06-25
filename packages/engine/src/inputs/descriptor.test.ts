import { describe, it, expect } from 'vitest';
import { DispatchInputType, InputDescriptor, InputsDescriptorMapSchema } from './descriptor.js';

describe('InputDescriptor', () => {
  it('accepts a full enum descriptor', () => {
    const d = InputDescriptor.parse({
      type: 'enum',
      values: ['full', 'edge-only'],
      default: 'full',
    });
    expect(d.optional).toBe(false);
    expect(d.values).toEqual(['full', 'edge-only']);
  });
  it('lists exactly the supported types', () => {
    expect(DispatchInputType.options).toEqual([
      'string',
      'number',
      'integer',
      'boolean',
      'enum',
      'literal',
    ]);
  });
  it('round-trips a descriptor map through JSON', () => {
    const map = { skipCveScan: { type: 'boolean' as const, default: false } };
    expect(InputsDescriptorMapSchema.parse(JSON.parse(JSON.stringify(map)))).toMatchObject(map);
  });
});
