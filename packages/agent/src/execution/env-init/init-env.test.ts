import { describe, it, expect } from 'vitest';
import { composeInitEnv } from './init-env.js';

describe('composeInitEnv', () => {
  it('lays the spec env over the job env and wins on a shared key', () => {
    const out = composeInitEnv({
      base: { HOME: '/home/node', SHARED: 'job' },
      specEnv: { SHARED: 'spec', PROBE: 'x' },
      protectedKeys: new Set(),
      platform: 'linux',
    });
    // fails-when: the spec env is dropped (the bug: PROBE missing, SHARED still 'job')
    expect(out.env).toMatchObject({ HOME: '/home/node', SHARED: 'spec', PROBE: 'x' });
    expect(out.reservedKeys).toEqual([]);
    expect(out.secretKeys).toEqual([]);
  });

  it('refuses KICI_ keys in any letter case and keeps the job value', () => {
    const out = composeInitEnv({
      base: { KICI_ENV: '/run/env-file' },
      specEnv: { KICI_ENV: '/tmp/hijack', kici_path: '/tmp/x', PROBE: 'x' },
      protectedKeys: new Set(),
      platform: 'linux',
    });
    // fails-when: a reserved key overrides the agent's KICI_ENV handoff file
    expect(out.env.KICI_ENV).toBe('/run/env-file');
    expect(out.env.kici_path).toBeUndefined();
    expect(out.reservedKeys).toEqual(['KICI_ENV', 'kici_path']);
    // breaks-if-wrong: an ordinary key beside a refused one still applies
    expect(out.env.PROBE).toBe('x');
  });

  it('refuses an operator secret key and keeps the operator value', () => {
    const out = composeInitEnv({
      base: { NPM_TOKEN: 'operator' },
      specEnv: { NPM_TOKEN: 'spec' },
      protectedKeys: new Set(['NPM_TOKEN']),
      platform: 'linux',
    });
    // fails-when: the protected set is not consulted
    expect(out.env.NPM_TOKEN).toBe('operator');
    expect(out.secretKeys).toEqual(['NPM_TOKEN']);
  });

  it('on Windows matches keys case-insensitively and leaves one PATH key', () => {
    const out = composeInitEnv({
      base: { Path: 'C:\\Windows', NPM_TOKEN: 'operator' },
      specEnv: { PATH: 'C:\\tools', npm_token: 'spec' },
      protectedKeys: new Set(['NPM_TOKEN']),
      platform: 'win32',
    });
    // fails-when: both `Path` and `PATH` reach the child and Windows picks either
    expect(Object.keys(out.env).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH']);
    expect(out.env.PATH).toBe('C:\\tools');
    expect(out.secretKeys).toEqual(['npm_token']);
  });

  it('on Linux keeps keys that differ only in letter case apart', () => {
    const out = composeInitEnv({
      base: { Path: 'job-mixed', NPM_TOKEN: 'operator' },
      specEnv: { PATH: '/spec/bin', npm_token: 'spec' },
      protectedKeys: new Set(['NPM_TOKEN']),
      platform: 'linux',
    });
    // breaks-if-wrong: the Windows case fold leaks onto a case-sensitive platform
    expect(out.env.Path).toBe('job-mixed');
    expect(out.env.PATH).toBe('/spec/bin');
    expect(out.env.npm_token).toBe('spec');
    expect(out.secretKeys).toEqual([]);
  });

  it('does not mutate the base object', () => {
    const base = { A: '1' };
    composeInitEnv({ base, specEnv: { A: '2' }, protectedKeys: new Set(), platform: 'linux' });
    // breaks-if-wrong: mutating process.env would leak one init's env into later inits and steps
    expect(base).toEqual({ A: '1' });
  });
});
