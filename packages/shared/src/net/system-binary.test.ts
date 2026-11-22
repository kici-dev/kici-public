import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { makeTempDir } from '@kici-dev/test-support/tmp';

import { resolveSystemBinary, SYSTEM_BINARY_DIRS } from './system-binary.js';

describe('resolveSystemBinary', () => {
  it('finds a binary that is only in /usr/sbin when PATH leaves it out', () => {
    // fails-when: the resolver searches PATH alone — a non-root service whose
    // PATH is /usr/local/bin:/usr/bin:/bin spawns the bare name and gets ENOENT.
    const present = new Set(['/usr/sbin/nft']);
    expect(
      resolveSystemBinary('nft', {
        pathEnv: '/usr/local/bin:/usr/bin:/bin',
        isExecutable: (f) => present.has(f),
      }),
    ).toBe('/usr/sbin/nft');
  });

  it('prefers the PATH entry over the fallback directories', () => {
    // breaks-if-wrong: an operator who puts a wrapper earlier on PATH must keep it.
    const present = new Set(['/opt/tools/nft', '/usr/sbin/nft']);
    expect(
      resolveSystemBinary('nft', {
        pathEnv: '/opt/tools:/usr/bin',
        isExecutable: (f) => present.has(f),
      }),
    ).toBe('/opt/tools/nft');
  });

  it('returns the bare name when nothing is found, so the spawn still reports ENOENT', () => {
    expect(resolveSystemBinary('nft', { pathEnv: '/usr/bin', isExecutable: () => false })).toBe(
      'nft',
    );
  });

  it('returns a name that already holds a slash unchanged', () => {
    expect(resolveSystemBinary('/custom/nft', { isExecutable: () => false })).toBe('/custom/nft');
  });

  it('searches the fallback directories in order', () => {
    const seen: string[] = [];
    resolveSystemBinary('nft', {
      pathEnv: '',
      isExecutable: (f) => {
        seen.push(f);
        return false;
      },
    });
    expect(seen).toEqual(SYSTEM_BINARY_DIRS.map((d) => path.join(d, 'nft')));
  });

  it('accepts a real executable file and skips a non-executable one and a directory', () => {
    const dir = makeTempDir('system-binary-');
    const noexec = path.join(dir, 'noexec');
    const exec = path.join(dir, 'exec');
    mkdirSync(noexec);
    mkdirSync(exec);
    writeFileSync(path.join(noexec, 'tool'), '');
    chmodSync(path.join(noexec, 'tool'), 0o644);
    writeFileSync(path.join(exec, 'tool'), '#!/bin/sh\n');
    chmodSync(path.join(exec, 'tool'), 0o755);
    mkdirSync(path.join(dir, 'isdir', 'tool'), { recursive: true });
    const pathEnv = [noexec, path.join(dir, 'isdir'), exec].join(path.delimiter);
    expect(resolveSystemBinary('tool', { pathEnv })).toBe(path.join(exec, 'tool'));
  });
});
