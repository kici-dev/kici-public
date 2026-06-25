import { describe, it, expect } from 'vitest';
import { substituteScopePattern } from './scope-template.js';
import type { HostFacts } from './host-match.js';

const facts: HostFacts = {
  agentId: 'box-00002',
  host: 'box-00002.prod',
  labels: ['rack:r12', 'role:db'],
};

describe('substituteScopePattern', () => {
  it('substitutes ${agentId} and ${host}', () => {
    expect(substituteScopePattern('prod/hosts/${agentId}/**', facts)).toBe(
      'prod/hosts/box-00002/**',
    );
    expect(substituteScopePattern('h/${host}/x', facts)).toBe('h/box-00002.prod/x');
  });

  it('substitutes a ${label:NAME} value', () => {
    expect(substituteScopePattern('prod/racks/${label:rack}/**', facts)).toBe('prod/racks/r12/**');
  });

  it('returns null on a missing label (skip the binding for this host)', () => {
    expect(substituteScopePattern('prod/${label:zone}/**', facts)).toBeNull();
  });

  it('picks the lexicographic-first value for a multi-valued label', () => {
    const multi: HostFacts = { ...facts, labels: ['tier:z', 'tier:a', 'tier:m'] };
    expect(substituteScopePattern('t/${label:tier}/**', multi)).toBe('t/a/**');
  });

  it('returns null when a substituted value would inject a path separator or glob', () => {
    expect(substituteScopePattern('p/${agentId}/x', { ...facts, agentId: 'a/b' })).toBeNull();
    expect(substituteScopePattern('p/${host}/x', { ...facts, host: 'h*' })).toBeNull();
    expect(
      substituteScopePattern('p/${label:rack}/x', { ...facts, labels: ['rack:r?12'] }),
    ).toBeNull();
  });

  it('allows safe values with dots, dashes and underscores', () => {
    expect(substituteScopePattern('p/${host}/x', facts)).toBe('p/box-00002.prod/x');
    expect(substituteScopePattern('p/${agentId}/x', { ...facts, agentId: 'a_b-1.2' })).toBe(
      'p/a_b-1.2/x',
    );
  });

  it('passes through a pattern with no placeholders unchanged', () => {
    expect(substituteScopePattern('prod/shared/**', facts)).toBe('prod/shared/**');
  });
});
