import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readAgentVersion } from './version.js';

describe('readAgentVersion', () => {
  it('returns the agent package.json version', () => {
    // Resolve the real package version independently of the helper.
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const expected = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version;
    expect(readAgentVersion()).toBe(expected);
  });

  it('returns a non-empty semver-shaped string', () => {
    const v = readAgentVersion();
    expect(v).not.toBeNull();
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });
});
