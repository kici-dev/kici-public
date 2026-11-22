import { describe, expect, it } from 'vitest';
import {
  allLazyDeps,
  getDepMetadata,
  lazyDepAtMirrorPath,
  lazyDepFileName,
  lazyDepMirrorPath,
} from './lazy-deps.js';

describe('the lazy dependency registry', () => {
  it('returns shawl metadata for Windows', () => {
    const dep = getDepMetadata('shawl', 'win32', 'x64');
    expect(dep.name).toBe('shawl');
    expect(dep.archiveType).toBe('zip');
  });

  it('throws for an unknown dependency or variant', () => {
    expect(() => getDepMetadata('nonexistent')).toThrow('Unknown lazy dependency: nonexistent');
    expect(() => getDepMetadata('shawl', 'linux', 'x64')).toThrow('No shawl variant for linux-x64');
  });

  it('every variant carries a SHA-256 and an https URL with a file name', () => {
    expect(allLazyDeps().length).toBeGreaterThan(0);
    for (const dep of allLazyDeps()) {
      expect(dep.sha256, dep.name).toMatch(/^[0-9a-f]{64}$/);
      expect(dep.url, dep.name).toMatch(/^https:\/\//);
      expect(lazyDepFileName(dep), dep.name).toMatch(/^[\w.-]+$/);
    }
  });
});

describe('the mirror layout', () => {
  const shawl = getDepMetadata('shawl', 'win32', 'x64');

  it('names name/version/platform-arch/file', () => {
    expect(lazyDepMirrorPath(shawl)).toBe('shawl/1.9.0/win32-x64/shawl-v1.9.0-win64.zip');
  });

  it('a mirror path names its registry entry', () => {
    // breaks-if-wrong: every registered archive is reachable at its own mirror path
    for (const dep of allLazyDeps()) {
      const [name, version, variant, file] = lazyDepMirrorPath(dep).split('/');
      expect(lazyDepAtMirrorPath(name!, version!, variant!, file!)).toBe(dep);
    }
  });

  it('a path outside the registry names nothing', () => {
    // fails-when: a reader of mirror paths serves a file the registry does not list
    for (const [name, version, variant, file] of [
      ['shawl', '1.8.0', 'win32-x64', 'shawl-v1.9.0-win64.zip'],
      ['shawl', '1.9.0', 'win32-arm64', 'shawl-v1.9.0-win64.zip'],
      ['shawl', '1.9.0', 'win32-x64', 'shawl.exe'],
      ['shawl', '1.9.0', 'win32-x64', '..'],
      ['nope', '1.9.0', 'win32-x64', 'shawl-v1.9.0-win64.zip'],
      ['..', '..', '..', 'etc'],
      ['__proto__', '1.9.0', 'win32-x64', 'shawl-v1.9.0-win64.zip'],
      ['shawl', '1.9.0', '__proto__', 'shawl-v1.9.0-win64.zip'],
      ['constructor', '1.9.0', 'win32-x64', 'shawl-v1.9.0-win64.zip'],
    ] as const) {
      expect(
        lazyDepAtMirrorPath(name, version, variant, file),
        `${name}/${version}/${variant}/${file}`,
      ).toBe(undefined);
    }
  });
});
