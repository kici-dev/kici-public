import { describe, it, expect } from 'vitest';
import { formatError, compilerError, isCompilerError } from './formatter.js';

describe('compilerError', () => {
  it('creates a CompilerError with code and message', () => {
    const err = compilerError('E001', 'File not found');
    expect(err).toEqual({
      code: 'E001',
      message: 'File not found',
      location: undefined,
      suggestion: undefined,
    });
  });

  it('includes location and suggestion when provided', () => {
    const err = compilerError('E102', 'Circular dependency', {
      location: { file: 'ci.ts', line: 15, column: 3 },
      suggestion: 'Remove the cycle',
    });
    expect(err.location).toEqual({ file: 'ci.ts', line: 15, column: 3 });
    expect(err.suggestion).toBe('Remove the cycle');
  });
});

describe('isCompilerError', () => {
  it('returns true for a valid CompilerError', () => {
    expect(isCompilerError(compilerError('E001', 'test'))).toBe(true);
  });

  it('returns true for codes with varying digit counts', () => {
    expect(isCompilerError({ code: 'E1', message: 'x' })).toBe(true);
    expect(isCompilerError({ code: 'E001', message: 'x' })).toBe(true);
    expect(isCompilerError({ code: 'E1234', message: 'x' })).toBe(true);
  });

  it('rejects Node.js system errors (ENOENT, EPERM, etc.)', () => {
    const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    expect(isCompilerError(enoent)).toBe(false);

    const eperm = Object.assign(new Error('permission denied'), { code: 'EPERM' });
    expect(isCompilerError(eperm)).toBe(false);

    const eacces = Object.assign(new Error('access denied'), { code: 'EACCES' });
    expect(isCompilerError(eacces)).toBe(false);
  });

  it('rejects Node.js ERR_ codes', () => {
    const err = Object.assign(new Error('module not found'), { code: 'ERR_MODULE_NOT_FOUND' });
    expect(isCompilerError(err)).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(isCompilerError(null)).toBe(false);
    expect(isCompilerError(undefined)).toBe(false);
    expect(isCompilerError('E001')).toBe(false);
    expect(isCompilerError(42)).toBe(false);
  });

  it('rejects objects without code or message', () => {
    expect(isCompilerError({ message: 'test' })).toBe(false);
    expect(isCompilerError({ code: 'E001' })).toBe(false);
  });

  it('rejects objects with non-string code', () => {
    expect(isCompilerError({ code: 1, message: 'test' })).toBe(false);
  });

  it('rejects codes not starting with E', () => {
    expect(isCompilerError({ code: 'W001', message: 'test' })).toBe(false);
  });
});

describe('formatError', () => {
  it('formats error without location', () => {
    const err = compilerError('E001', 'File not found');
    const output = formatError(err);
    expect(output).toContain('[E001]');
    expect(output).toContain('File not found');
  });

  it('formats error with location in GNU format', () => {
    const err = compilerError('E102', 'Circular dependency', {
      location: { file: 'ci.ts', line: 15, column: 3 },
    });
    const output = formatError(err);
    expect(output).toContain('ci.ts:15:3');
    expect(output).toContain('[E102]');
  });

  it('includes suggestion when present', () => {
    const err = compilerError('E001', 'Not found', {
      suggestion: 'Run kici init',
    });
    const output = formatError(err);
    expect(output).toContain('Suggestion: Run kici init');
  });
});
