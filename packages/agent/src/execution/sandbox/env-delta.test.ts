import { describe, it, expect, vi } from 'vitest';
import { applyEnvDelta, type EnvDelta } from './env-delta.js';

function emptyDelta(): EnvDelta {
  return { env: {}, pathPrepends: [] };
}

describe('applyEnvDelta', () => {
  it('sets env keys on the target and reports them as applied', () => {
    const target: NodeJS.ProcessEnv = {};
    const result = applyEnvDelta(
      { env: { FOO: 'bar', BAZ: 'qux' }, pathPrepends: [] },
      { operatorSecretKeys: new Set(), target },
    );
    expect(target.FOO).toBe('bar');
    expect(target.BAZ).toBe('qux');
    expect(result.appliedKeys.sort()).toEqual(['BAZ', 'FOO']);
    expect(result.rejectedKeys).toEqual([]);
  });

  it('rejects keys that collide with an operator secret and leaves the target untouched', () => {
    const target: NodeJS.ProcessEnv = { SECRET: 'operator-value' };
    const onReject = vi.fn();
    const result = applyEnvDelta(
      { env: { SECRET: 'attacker-value', SAFE: 'ok' }, pathPrepends: [] },
      { operatorSecretKeys: new Set(['SECRET']), target, onReject },
    );
    expect(target.SECRET).toBe('operator-value');
    expect(target.SAFE).toBe('ok');
    expect(result.appliedKeys).toEqual(['SAFE']);
    expect(result.rejectedKeys).toEqual(['SECRET']);
    expect(onReject).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledWith('SECRET');
  });

  it('prepends paths so the first array entry ends up first on PATH', () => {
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const result = applyEnvDelta(
      { env: {}, pathPrepends: ['/a', '/b'] },
      { operatorSecretKeys: new Set(), target },
    );
    expect(target.PATH).toBe('/a:/b:/usr/bin');
    expect(result.appliedPaths).toEqual(['/a', '/b']);
  });

  it('initializes PATH when the target has none', () => {
    const target: NodeJS.ProcessEnv = {};
    applyEnvDelta({ env: {}, pathPrepends: ['/only'] }, { operatorSecretKeys: new Set(), target });
    expect(target.PATH).toBe('/only');
  });

  it('defaults target to process.env when omitted', () => {
    const key = `KICI_TEST_${Date.now()}`;
    applyEnvDelta({ env: { [key]: 'v' }, pathPrepends: [] }, { operatorSecretKeys: new Set() });
    expect(process.env[key]).toBe('v');
    delete process.env[key];
  });

  it('applies env keys in insertion order (last-write-wins handled by the delta builder)', () => {
    const target: NodeJS.ProcessEnv = {};
    const result = applyEnvDelta(
      { env: { A: '1', B: '2' }, pathPrepends: [] },
      { operatorSecretKeys: new Set(), target },
    );
    expect(result.appliedKeys).toEqual(['A', 'B']);
    expect(target).toMatchObject({ A: '1', B: '2' });
  });
});

describe('applyEnvDelta PATH separator', () => {
  it('joins PATH with ";" when pathSeparator is ";" (Windows)', () => {
    const target: NodeJS.ProcessEnv = { PATH: 'C:\\existing' };
    applyEnvDelta(
      { env: {}, pathPrepends: ['C:\\a', 'C:\\b'] },
      { operatorSecretKeys: new Set(), target, pathSeparator: ';' },
    );
    expect(target.PATH).toBe('C:\\a;C:\\b;C:\\existing');
  });

  it('joins PATH with ":" by default (posix)', () => {
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    applyEnvDelta(
      { env: {}, pathPrepends: ['/a', '/b'] },
      { operatorSecretKeys: new Set(), target, pathSeparator: ':' },
    );
    expect(target.PATH).toBe('/a:/b:/usr/bin');
  });
});

describe('applyEnvDelta single-dir addPath mapping', () => {
  it('addPath(dir) maps to pathPrepends:[dir] and prepends correctly across calls', () => {
    const target: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    applyEnvDelta({ env: {}, pathPrepends: ['/a'] }, { operatorSecretKeys: new Set(), target });
    applyEnvDelta({ env: {}, pathPrepends: ['/b'] }, { operatorSecretKeys: new Set(), target });
    // Second call's dir lands further left -- matches the legacy addPath behavior.
    expect(target.PATH).toBe('/b:/a:/usr/bin');
  });

  it('setEnv(key,value) maps to env:{[key]:value} and respects the operator guard', () => {
    const target: NodeJS.ProcessEnv = {};
    const onReject = vi.fn();
    applyEnvDelta(
      { env: { OP: 'x' }, pathPrepends: [] },
      { operatorSecretKeys: new Set(['OP']), target, onReject },
    );
    expect(target.OP).toBeUndefined();
    expect(onReject).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledWith('OP');
  });
});
