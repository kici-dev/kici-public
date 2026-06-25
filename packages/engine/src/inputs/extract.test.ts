import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  extractInputDescriptor,
  extractInputsDescriptorMap,
  UnsupportedDispatchInputError,
} from './extract.js';

describe('extractInputDescriptor', () => {
  it('string optional with regex', () => {
    expect(extractInputDescriptor(z.string().regex(/^box-/).optional())).toMatchObject({
      type: 'string',
      optional: true,
      pattern: '^box-',
    });
  });
  it('string with min/max', () => {
    expect(extractInputDescriptor(z.string().min(1).max(20))).toMatchObject({
      type: 'string',
      min: 1,
      max: 20,
    });
  });
  it('boolean with default', () => {
    expect(extractInputDescriptor(z.boolean().default(false))).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });
  it('integer with bounds + default', () => {
    expect(extractInputDescriptor(z.number().int().min(0).max(10).default(3))).toMatchObject({
      type: 'integer',
      min: 0,
      max: 10,
      default: 3,
    });
  });
  it('plain number', () => {
    expect(extractInputDescriptor(z.number())).toMatchObject({ type: 'number' });
  });
  it('enum members', () => {
    expect(extractInputDescriptor(z.enum(['full', 'edge-only']).default('full'))).toMatchObject({
      type: 'enum',
      values: ['full', 'edge-only'],
      default: 'full',
    });
  });
  it('string literal', () => {
    expect(extractInputDescriptor(z.literal('only'))).toMatchObject({
      type: 'literal',
      literal: 'only',
    });
  });
  it('nullable', () => {
    expect(extractInputDescriptor(z.string().nullable())).toMatchObject({
      type: 'string',
      nullable: true,
    });
  });
  it('rejects z.object', () => {
    expect(() => extractInputDescriptor(z.object({ a: z.string() }))).toThrow(
      UnsupportedDispatchInputError,
    );
  });
  it('rejects z.array', () => {
    expect(() => extractInputDescriptor(z.array(z.string()))).toThrow(
      UnsupportedDispatchInputError,
    );
  });
  it('rejects z.union', () => {
    expect(() => extractInputDescriptor(z.union([z.string(), z.number()]))).toThrow(
      UnsupportedDispatchInputError,
    );
  });
  it('rejects .transform / .refine', () => {
    expect(() => extractInputDescriptor(z.string().transform((s) => s))).toThrow(
      UnsupportedDispatchInputError,
    );
    expect(() => extractInputDescriptor(z.string().refine(() => true))).toThrow(
      UnsupportedDispatchInputError,
    );
  });
  it('rejects a non-zod value', () => {
    expect(() => extractInputDescriptor({ not: 'zod' })).toThrow(UnsupportedDispatchInputError);
  });
  it('extractInputsDescriptorMap names the offending key', () => {
    expect(() => extractInputsDescriptorMap({ bad: z.array(z.string()) })).toThrow(/bad/);
  });
  it('extractInputsDescriptorMap extracts every key', () => {
    expect(
      extractInputsDescriptorMap({
        a: z.string(),
        b: z.boolean().default(true),
      }),
    ).toMatchObject({
      a: { type: 'string' },
      b: { type: 'boolean', default: true },
    });
  });
});

// _zod.def shape-guard: fails loudly on a Zod minor bump that moves internals.
describe('zod 4 def shape guard', () => {
  it('exposes _zod.def.type for each allowed constructor', () => {
    const types = [z.string(), z.number(), z.boolean(), z.enum(['a']), z.literal('x')].map(
      (s) => (s as unknown as { _zod: { def: { type: string } } })._zod.def.type,
    );
    expect(types).toEqual(['string', 'number', 'boolean', 'enum', 'literal']);
    expect(
      (z.string().optional() as unknown as { _zod: { def: { type: string } } })._zod.def.type,
    ).toBe('optional');
    expect(
      (z.string().default('x') as unknown as { _zod: { def: { type: string } } })._zod.def.type,
    ).toBe('default');
  });
});
