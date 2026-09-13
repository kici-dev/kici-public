import { describe, it, expect } from 'vitest';
import { parsePlatforms } from './agent-package.js';

describe('parsePlatforms', () => {
  it('defaults to the glibc-Linux bootstrap set', () => {
    expect(parsePlatforms(undefined)).toEqual(['linux-x64', 'linux-arm64']);
  });
  it('accepts a single platform', () => {
    expect(parsePlatforms('linux-arm64')).toEqual(['linux-arm64']);
  });
  it('accepts a CSV', () => {
    expect(parsePlatforms('linux-x64,linux-arm64')).toEqual(['linux-x64', 'linux-arm64']);
  });
  it('expands `all` to every supported platform', () => {
    expect(parsePlatforms('all')).toEqual(['linux-x64', 'linux-arm64']);
  });
  it('throws on an unsupported platform', () => {
    expect(() => parsePlatforms('darwin-arm64')).toThrow(/unsupported/i);
  });
});
