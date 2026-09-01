import { describe, it, expect } from 'vitest';
import {
  resolveCredential,
  assertSecretName,
  type GitCredentialMap,
  type GitHubPermissions,
} from './git-types.js';

const map: GitCredentialMap = {
  default: { kind: 'token', tokenSecret: 'ci:DEFAULT_PAT' },
  forge: { kind: 'token', tokenSecret: 'ci:FORGE_PAT' },
};

describe('resolveCredential', () => {
  it('resolves a call-site name against the map', () => {
    expect(resolveCredential('forge', map)).toEqual({ kind: 'token', tokenSecret: 'ci:FORGE_PAT' });
  });

  it('falls back to `default` when a call names none', () => {
    expect(resolveCredential(undefined, map)).toEqual({
      kind: 'token',
      tokenSecret: 'ci:DEFAULT_PAT',
    });
  });

  it('returns undefined with no default, so the source credential applies', () => {
    expect(resolveCredential(undefined, { forge: map.forge! })).toBeUndefined();
  });

  it('returns undefined when there is no map at all', () => {
    expect(resolveCredential(undefined, undefined)).toBeUndefined();
  });

  it('accepts an inline ref at the call site for a genuine one-off', () => {
    const inline = { kind: 'token' as const, tokenValue: 'ONE_OFF' };
    expect(resolveCredential(inline, map)).toBe(inline);
  });

  it('throws naming the unknown credential rather than silently using the default', () => {
    expect(() => resolveCredential('typo', map)).toThrow(/typo/);
  });

  it('lists the known credentials so the typo is easy to fix', () => {
    expect(() => resolveCredential('typo', map)).toThrow(/default, forge/);
  });
});

describe('assertSecretName', () => {
  it.each([
    ['-----BEGIN RSA PRIVATE KEY-----\nMII...', 'privateKey'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'token'],
    ['ghs_abcdefghijklmnopqrstuvwxyz0123', 'token'],
    ['github_pat_11ABC', 'token'],
  ])('rejects secret material %s', (value, field) => {
    expect(() => assertSecretName(value, field)).toThrow(/name of a secret/i);
  });

  it('accepts an ordinary secret name', () => {
    expect(() => assertSecretName('ACME_APP_KEY', 'privateKey')).not.toThrow();
  });

  it('accepts a qualified secret reference', () => {
    expect(() => assertSecretName('ci:ACME_APP_KEY', 'privateKey')).not.toThrow();
  });
});

describe('permission typing', () => {
  it('allows an unknown permission key so a new github permission needs no sdk release', () => {
    const perms: GitHubPermissions = { contents: 'write', some_new_permission: 'write' };
    expect(perms.some_new_permission).toBe('write');
  });
});
