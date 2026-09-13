import { describe, expect, it } from 'vitest';
import { SourceOrigin } from './source-origin.js';

describe('SourceOrigin', () => {
  it('accepts the two brand values', () => {
    expect(SourceOrigin.parse('triggered')).toBe('triggered');
    expect(SourceOrigin.parse('run-remote')).toBe('run-remote');
  });
  it('rejects unknown brands', () => {
    expect(SourceOrigin.safeParse('local').success).toBe(false);
  });
  it('exposes enum accessors', () => {
    expect(SourceOrigin.enum.triggered).toBe('triggered');
    expect(SourceOrigin.enum['run-remote']).toBe('run-remote');
  });
});
