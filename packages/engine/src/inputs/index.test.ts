import { describe, it, expect } from 'vitest';
import * as inputs from './index.js';

describe('engine/inputs barrel', () => {
  it('exports the public surface', () => {
    for (const s of [
      'DispatchInputType',
      'InputDescriptor',
      'InputsDescriptorMapSchema',
      'extractInputDescriptor',
      'extractInputsDescriptorMap',
      'UnsupportedDispatchInputError',
      'buildZodObjectFromMap',
      'buildZodFromDescriptor',
      'coerceDispatchInputs',
      'parseInputPairs',
      'DispatchInputError',
    ]) {
      expect(inputs).toHaveProperty(s);
    }
  });
});
