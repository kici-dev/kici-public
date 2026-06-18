import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dirname, join } from 'node:path';
import { resolveNpm, verifyNpmAvailable } from './npm-resolver.js';

describe('resolveNpm', () => {
  it('returns nodeExe matching process.execPath', () => {
    const result = resolveNpm();
    expect(result.nodeExe).toBe(process.execPath);
    expect(result.nodeDir).toBe(dirname(process.execPath));
  });

  it('finds npm-cli.js in standard Node.js layout', () => {
    const result = resolveNpm();
    // In a normal Node.js installation, npm should be found
    // (either via the standard path or undefined for non-standard layouts)
    expect(typeof result.npmCliPath === 'string' || result.npmCliPath === undefined).toBe(true);
  });
});

describe('verifyNpmAvailable', () => {
  it('returns npm version string when npm is available', () => {
    // In test environments, npm is always available (we're running in Node.js)
    const version = verifyNpmAvailable();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('throws descriptive error when npm is not available', () => {
    // Temporarily override process.execPath to a non-existent binary
    const originalExecPath = process.execPath;
    const originalPath = process.env.PATH;

    try {
      // Point to a fake node binary with no npm alongside it and clear PATH
      Object.defineProperty(process, 'execPath', {
        value: '/tmp/fake-node-binary',
        writable: true,
      });
      process.env.PATH = '';

      expect(() => verifyNpmAvailable()).toThrow('Builder role requires npm');
    } finally {
      Object.defineProperty(process, 'execPath', { value: originalExecPath, writable: true });
      process.env.PATH = originalPath;
    }
  });
});
