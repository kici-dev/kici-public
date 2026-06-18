import { describe, it, expect } from 'vitest';
import { LockFileParseError } from './lock-file-parse-error.js';

describe('LockFileParseError', () => {
  it('is an Error subclass carrying repo context', () => {
    const err = new LockFileParseError('owner/repo', 'refs/heads/main', 'bad JSON');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LockFileParseError);
    expect(err.name).toBe('LockFileParseError');
    expect(err.repoIdentifier).toBe('owner/repo');
    expect(err.ref).toBe('refs/heads/main');
    expect(err.message).toBe('bad JSON');
  });

  it('survives an instanceof check after being rethrown', () => {
    let caught: unknown;
    try {
      throw new LockFileParseError('a/b', 'main', 'x');
    } catch (e) {
      caught = e;
    }
    expect(caught instanceof LockFileParseError).toBe(true);
  });
});
