import { describe, it, expect } from 'vitest';
import { matchScopePattern, resolveSecretsForEnvironment } from './scope-resolver.js';
import type { EnvironmentBinding, ScopedSecret } from './types.js';

describe('matchScopePattern', () => {
  it('matches exact scope', () => {
    expect(matchScopePattern('aws', 'aws')).toBe(true);
  });

  it('matches glob pattern aws/**', () => {
    expect(matchScopePattern('aws/prod', 'aws/**')).toBe(true);
  });

  it('does not match non-matching glob pattern', () => {
    expect(matchScopePattern('aws/prod', 'aws/staging/**')).toBe(false);
  });

  it('matches nested path against parent glob', () => {
    expect(matchScopePattern('aws/prod/db', 'aws/prod/**')).toBe(true);
  });

  it('does not match partial path without glob', () => {
    expect(matchScopePattern('aws/prod', 'aws')).toBe(false);
  });

  it('matches single-level wildcard', () => {
    expect(matchScopePattern('aws/prod', 'aws/*')).toBe(true);
  });

  it('single-level wildcard does not match nested', () => {
    expect(matchScopePattern('aws/prod/db', 'aws/*')).toBe(false);
  });
});

describe('resolveSecretsForEnvironment', () => {
  const makeBinding = (
    id: string,
    envId: string,
    scopePattern: string,
    hostPattern = '**',
  ): EnvironmentBinding => ({
    id,
    orgId: 'org1',
    environmentId: envId,
    scopePattern,
    hostPattern,
    createdAt: '2026-01-01',
  });

  const makeSecret = (
    id: string,
    scope: string,
    key: string,
    encryptedValue: string,
  ): ScopedSecret => ({
    id,
    orgId: 'org1',
    scope,
    key,
    encryptedValue,
    backendType: 'pg',
    keyVersion: 1,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  });

  const decryptFn = (s: ScopedSecret): string => `decrypted:${s.encryptedValue}`;

  it('returns empty record for empty bindings', () => {
    const result = resolveSecretsForEnvironment([], [], decryptFn);
    expect(result).toEqual({});
  });

  it('returns empty record for non-matching secrets', () => {
    const bindings = [makeBinding('b1', 'env1', 'aws/prod/**')];
    const secrets = [makeSecret('s1', 'gcp/staging', 'DB_HOST', 'enc1')];
    const result = resolveSecretsForEnvironment(bindings, secrets, decryptFn);
    expect(result).toEqual({});
  });

  it('resolves secrets matching binding scope pattern', () => {
    const bindings = [makeBinding('b1', 'env1', 'aws/**')];
    const secrets = [makeSecret('s1', 'aws/prod', 'DB_PASSWORD', 'enc1')];
    const result = resolveSecretsForEnvironment(bindings, secrets, decryptFn);
    expect(result).toEqual({ DB_PASSWORD: 'decrypted:enc1' });
  });

  it('longest path wins when two scopes provide same key', () => {
    const bindings = [
      makeBinding('b1', 'env1', 'aws/**'),
      makeBinding('b2', 'env1', 'aws/prod/**'),
    ];
    const secrets = [
      makeSecret('s1', 'aws', 'DB_PASSWORD', 'general'),
      makeSecret('s2', 'aws/prod', 'DB_PASSWORD', 'specific'),
    ];
    const result = resolveSecretsForEnvironment(bindings, secrets, decryptFn);
    expect(result).toEqual({ DB_PASSWORD: 'decrypted:specific' });
  });

  it('merges secrets from multiple scopes with different keys', () => {
    const bindings = [makeBinding('b1', 'env1', 'aws/**')];
    const secrets = [
      makeSecret('s1', 'aws/prod', 'DB_HOST', 'host1'),
      makeSecret('s2', 'aws/prod', 'DB_PORT', 'port1'),
    ];
    const result = resolveSecretsForEnvironment(bindings, secrets, decryptFn);
    expect(result).toEqual({
      DB_HOST: 'decrypted:host1',
      DB_PORT: 'decrypted:port1',
    });
  });

  it('uses segment count not string length for scope depth precedence', () => {
    const bindings = [makeBinding('b1', 'env1', '**')];
    const secrets = [
      // 'gcp/production' is 14 chars but only 2 segments
      makeSecret('s1', 'gcp/production', 'DB_HOST', 'shallow'),
      // 'aws/p/db' is 8 chars but 3 segments (more specific)
      makeSecret('s2', 'aws/p/db', 'DB_HOST', 'deep'),
    ];
    const result = resolveSecretsForEnvironment(bindings, secrets, decryptFn);
    // 3 segments > 2 segments, so aws/p/db should win despite shorter string
    expect(result).toEqual({ DB_HOST: 'decrypted:deep' });
  });

  it('exact scope match works in bindings', () => {
    const bindings = [makeBinding('b1', 'env1', 'aws/prod')];
    const secrets = [makeSecret('s1', 'aws/prod', 'API_KEY', 'key1')];
    const result = resolveSecretsForEnvironment(bindings, secrets, decryptFn);
    expect(result).toEqual({ API_KEY: 'decrypted:key1' });
  });
});

describe('matchScopePattern with prefixed scopes', () => {
  it('matches vault-prod:** against vault-prod:aws/prod', () => {
    expect(matchScopePattern('vault-prod:aws/prod', 'vault-prod:**')).toBe(true);
  });

  it('matches pg:aws/** against pg:aws/prod', () => {
    expect(matchScopePattern('pg:aws/prod', 'pg:aws/**')).toBe(true);
  });

  it('does not match pg:** against vault-prod:aws/prod', () => {
    expect(matchScopePattern('vault-prod:aws/prod', 'pg:**')).toBe(false);
  });

  it('matches pg:databases/** against pg:databases/staging', () => {
    expect(matchScopePattern('pg:databases/staging', 'pg:databases/**')).toBe(true);
  });

  it('matches exact prefixed scope', () => {
    expect(matchScopePattern('pg:aws/prod', 'pg:aws/prod')).toBe(true);
  });
});

describe('resolveSecretsForEnvironment with prefixed scopes', () => {
  const makeBinding = (
    id: string,
    envId: string,
    scopePattern: string,
    hostPattern = '**',
  ): EnvironmentBinding => ({
    id,
    orgId: 'org1',
    environmentId: envId,
    scopePattern,
    hostPattern,
    createdAt: '2026-01-01',
  });

  const makeSecret = (
    id: string,
    scope: string,
    key: string,
    encryptedValue: string,
  ): ScopedSecret => ({
    id,
    orgId: 'org1',
    scope,
    key,
    encryptedValue,
    backendType: 'pg',
    keyVersion: 1,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  });

  const decryptFn = (s: ScopedSecret): string => `decrypted:${s.encryptedValue}`;

  it('longest path wins after prefix strip — deeper path beats shallower across backends', () => {
    const bindings = [
      makeBinding('b1', 'env1', 'pg:**'),
      makeBinding('b2', 'env1', 'vault-prod:**'),
    ];
    const secrets = [
      makeSecret('s1', 'pg:aws/prod', 'DB_PASSWORD', 'pg-value'),
      makeSecret('s2', 'vault-prod:aws/prod/us-east', 'DB_PASSWORD', 'vault-value'),
    ];
    const result = resolveSecretsForEnvironment(bindings, secrets, decryptFn);
    // vault-prod:aws/prod/us-east has path depth 3 (aws/prod/us-east) vs pg:aws/prod depth 2
    expect(result).toEqual({ DB_PASSWORD: 'decrypted:vault-value' });
  });

  it('resolves prefixed secrets from multiple backends with different keys', () => {
    const bindings = [
      makeBinding('b1', 'env1', 'pg:**'),
      makeBinding('b2', 'env1', 'vault-prod:**'),
    ];
    const secrets = [
      makeSecret('s1', 'pg:aws/prod', 'DB_HOST', 'pg-host'),
      makeSecret('s2', 'vault-prod:aws/prod', 'API_KEY', 'vault-key'),
    ];
    const result = resolveSecretsForEnvironment(bindings, secrets, decryptFn);
    expect(result).toEqual({
      DB_HOST: 'decrypted:pg-host',
      API_KEY: 'decrypted:vault-key',
    });
  });

  it('same depth — first candidate wins (stable behavior)', () => {
    const bindings = [
      makeBinding('b1', 'env1', 'pg:**'),
      makeBinding('b2', 'env1', 'vault-prod:**'),
    ];
    const secrets = [
      makeSecret('s1', 'pg:aws/prod', 'DB_PASSWORD', 'pg-value'),
      makeSecret('s2', 'vault-prod:aws/prod', 'DB_PASSWORD', 'vault-value'),
    ];
    const result = resolveSecretsForEnvironment(bindings, secrets, decryptFn);
    // Same depth (2 segments after prefix strip), first encountered wins (stable)
    expect(result).toEqual({ DB_PASSWORD: 'decrypted:pg-value' });
  });
});

describe('resolveSecretsForEnvironment — per-host scoping', () => {
  const makeBinding = (
    id: string,
    scopePattern: string,
    hostPattern = '**',
  ): EnvironmentBinding => ({
    id,
    orgId: 'org1',
    environmentId: 'env1',
    scopePattern,
    hostPattern,
    createdAt: '2026-01-01',
  });

  const makeSecret = (id: string, scope: string, key: string, value: string): ScopedSecret => ({
    id,
    orgId: 'org1',
    scope,
    key,
    encryptedValue: value,
    backendType: 'pg',
    keyVersion: 1,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
  });

  const id = (s: ScopedSecret): string => s.encryptedValue;
  const f2 = { agentId: 'box-00002', host: 'box-00002', labels: ['role:db'] };
  const f3 = { agentId: 'box-00003', host: 'box-00003', labels: ['role:db'] };

  it('templated scope resolves each host its own subtree (one binding, N hosts)', () => {
    const bindings = [
      makeBinding('1', 'prod/shared/**'),
      makeBinding('2', 'prod/hosts/${agentId}/**'),
    ];
    const secrets = [
      makeSecret('s0', 'pg:prod/shared', 'REPL', 'shared'),
      makeSecret('s2', 'pg:prod/hosts/box-00002', 'WG', 'wg-for-2'),
      makeSecret('s3', 'pg:prod/hosts/box-00003', 'WG', 'wg-for-3'),
    ];
    const r2 = resolveSecretsForEnvironment(bindings, secrets, id, f2);
    const r3 = resolveSecretsForEnvironment(bindings, secrets, id, f3);
    expect(r2).toEqual({ REPL: 'shared', WG: 'wg-for-2' });
    expect(r3).toEqual({ REPL: 'shared', WG: 'wg-for-3' });
  });

  it('host_pattern gates which hosts a binding applies to', () => {
    const bindings = [makeBinding('1', 'prod/db/**', 'role:db')];
    const secrets = [makeSecret('s1', 'pg:prod/db', 'PG', 'pg-secret')];
    expect(resolveSecretsForEnvironment(bindings, secrets, id, f2).PG).toBe('pg-secret');
    const web = { agentId: 'web-1', host: 'web-1', labels: ['role:web'] };
    expect(resolveSecretsForEnvironment(bindings, secrets, id, web).PG).toBeUndefined();
  });

  it('a per-host binding overrides a fleet-wide one for a colliding key', () => {
    const bindings = [
      makeBinding('1', 'prod/shared/**', '**'),
      makeBinding('2', 'prod/hosts/box-00002/**', 'box-00002'),
    ];
    const secrets = [
      makeSecret('s1', 'pg:prod/shared', 'WG', 'shared'),
      makeSecret('s2', 'pg:prod/hosts/box-00002', 'WG', 'host2'),
    ];
    expect(resolveSecretsForEnvironment(bindings, secrets, id, f2).WG).toBe('host2');
  });

  it('without hostFacts, only ** bindings resolve and templated scopes are skipped', () => {
    const bindings = [
      makeBinding('1', 'prod/shared/**', '**'),
      makeBinding('2', 'prod/hosts/box-00002/**', 'box-00002'),
      makeBinding('3', 'prod/hosts/${agentId}/**', '**'),
    ];
    const secrets = [
      makeSecret('s1', 'pg:prod/shared', 'REPL', 'shared'),
      makeSecret('s2', 'pg:prod/hosts/box-00002', 'WG', 'host2'),
    ];
    const out = resolveSecretsForEnvironment(bindings, secrets, id);
    // The ** + non-templated binding contributes REPL; the host-gated and the
    // templated binding both resolve to nothing without host facts.
    expect(out).toEqual({ REPL: 'shared' });
  });

  it('skips a templated binding for a host whose label is missing', () => {
    const bindings = [makeBinding('1', 'prod/racks/${label:rack}/**')];
    const secrets = [makeSecret('s1', 'pg:prod/racks/r12', 'K', 'v')];
    // f2 has no rack label → binding contributes nothing.
    expect(resolveSecretsForEnvironment(bindings, secrets, id, f2)).toEqual({});
    const withRack = { ...f2, labels: ['rack:r12'] };
    expect(resolveSecretsForEnvironment(bindings, secrets, id, withRack).K).toBe('v');
  });
});
