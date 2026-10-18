import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { sshFileListOption } from './ssh-option.js';

describe('sshFileListOption', () => {
  // fails-when: the inner double quotes are dropped — ssh would then read
  // `/tmp/a` and `b/known_hosts` as two files.
  it('quotes a path with a space as one ssh file', () => {
    expect(sshFileListOption('UserKnownHostsFile', ['/tmp/a b/known_hosts'])).toBe(
      `-o 'UserKnownHostsFile="/tmp/a b/known_hosts"'`,
    );
  });

  // breaks-if-wrong: a space-free list must still name each file, in order.
  it('lists several files in order', () => {
    expect(sshFileListOption('UserKnownHostsFile', ['/k/known_hosts', '~/.ssh/known_hosts'])).toBe(
      `-o 'UserKnownHostsFile="/k/known_hosts" "~/.ssh/known_hosts"'`,
    );
  });

  it('refuses a double quote', () => {
    expect(() => sshFileListOption('UserKnownHostsFile', ['/tmp/a"b'])).toThrow(/double quote/);
  });

  it('survives sh word splitting as one argument', () => {
    const opt = sshFileListOption('UserKnownHostsFile', ['/tmp/a b/known_hosts']);
    const out = execFileSync('sh', ['-c', `printf '%s\\n' ${opt}`], { encoding: 'utf8' });
    expect(out.split('\n').filter(Boolean)).toEqual([
      '-o',
      'UserKnownHostsFile="/tmp/a b/known_hosts"',
    ]);
  });

  it('keeps a single quote in a path inside one sh argument', () => {
    const opt = sshFileListOption('UserKnownHostsFile', ["/tmp/o'brien/kh"]);
    const out = execFileSync('sh', ['-c', `printf '%s\\n' ${opt}`], { encoding: 'utf8' });
    expect(out.split('\n').filter(Boolean)).toEqual(['-o', `UserKnownHostsFile="/tmp/o'brien/kh"`]);
  });
});
