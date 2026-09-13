import { describe, it, expect } from 'vitest';
import {
  isInputSatisfiableFromDefaults,
  assertScheduleInputsSatisfiable,
  resolveScheduleInputs,
} from './schedule.js';
import type { InputDescriptorT, InputsDescriptorMap } from './descriptor.js';

const enumDefault: InputDescriptorT = {
  type: 'enum',
  values: ['full', 'quick'],
  default: 'full',
  optional: false,
  nullable: false,
};
const optionalNoDefault: InputDescriptorT = {
  type: 'string',
  optional: true,
  nullable: false,
};
const requiredNoDefault: InputDescriptorT = {
  type: 'string',
  optional: false,
  nullable: false,
};
const nullableNoDefault: InputDescriptorT = {
  type: 'string',
  optional: false,
  nullable: true,
};

describe('isInputSatisfiableFromDefaults', () => {
  it('true when a default is set', () => {
    expect(isInputSatisfiableFromDefaults(enumDefault)).toBe(true);
  });
  it('true when optional with no default', () => {
    expect(isInputSatisfiableFromDefaults(optionalNoDefault)).toBe(true);
  });
  it('false when required with no default', () => {
    expect(isInputSatisfiableFromDefaults(requiredNoDefault)).toBe(false);
  });
  it('false when nullable but neither default nor optional', () => {
    expect(isInputSatisfiableFromDefaults(nullableNoDefault)).toBe(false);
  });
});

describe('assertScheduleInputsSatisfiable', () => {
  it('passes for default/optional inputs', () => {
    expect(() =>
      assertScheduleInputsSatisfiable({ mode: enumDefault, note: optionalNoDefault }),
    ).not.toThrow();
  });
  it('throws naming the offending required input', () => {
    expect(() =>
      assertScheduleInputsSatisfiable({ mode: enumDefault, name: requiredNoDefault }),
    ).toThrow(/schedule input "name" must declare a \.default\(\) or be \.optional\(\)/);
  });
});

describe('resolveScheduleInputs', () => {
  it('returns undefined for an absent map', () => {
    expect(resolveScheduleInputs(undefined)).toBeUndefined();
  });
  it('returns undefined for an empty map', () => {
    expect(resolveScheduleInputs({})).toBeUndefined();
  });
  it('applies declared defaults', () => {
    expect(resolveScheduleInputs({ mode: enumDefault })).toEqual({ mode: 'full' });
  });
  it('omits an optional-no-default key (no value to resolve)', () => {
    const map: InputsDescriptorMap = { note: optionalNoDefault };
    expect(resolveScheduleInputs(map)).toBeUndefined();
  });
});
