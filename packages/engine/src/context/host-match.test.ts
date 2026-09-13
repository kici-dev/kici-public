import { describe, it, expect } from 'vitest';
import { matchHostPattern, hostSpecificity, type HostFacts } from './host-match.js';

const facts: HostFacts = {
  agentId: 'box-00002',
  host: 'box-00002.prod',
  labels: ['kici:host:box-00002', 'role:db'],
};

describe('matchHostPattern', () => {
  it('** matches everything', () => expect(matchHostPattern(facts, '**')).toBe(true));
  it('empty pattern matches everything', () => expect(matchHostPattern(facts, '')).toBe(true));
  it('exact agentId match', () => expect(matchHostPattern(facts, 'box-00002')).toBe(true));
  it('exact hostname match', () => expect(matchHostPattern(facts, 'box-00002.prod')).toBe(true));
  it('label match', () => expect(matchHostPattern(facts, 'role:db')).toBe(true));
  it('glob match against agentId', () => expect(matchHostPattern(facts, 'box-0000*')).toBe(true));
  it('regex match against agentId', () =>
    expect(matchHostPattern(facts, '/^box-0000[23]$/')).toBe(true));
  it('regex match against a label', () =>
    expect(matchHostPattern(facts, '/^role:db$/')).toBe(true));
  it('non-match', () => expect(matchHostPattern(facts, 'box-00009')).toBe(false));
  it('glob non-match', () => expect(matchHostPattern(facts, 'web-*')).toBe(false));
  it('regex non-match', () => expect(matchHostPattern(facts, '/^web-/')).toBe(false));
});

describe('matchHostPattern case handling', () => {
  const caseFacts: HostFacts = {
    agentId: 'Prod-01',
    host: 'Build-Box',
    labels: ['docker', 'gpu'],
  };

  it('matches a label case-insensitively', () => {
    expect(matchHostPattern(caseFacts, 'Docker')).toBe(true);
  });

  it('matches a label glob case-insensitively', () => {
    expect(matchHostPattern(caseFacts, 'DOCK*')).toBe(true);
  });

  it('matches a label regex case-insensitively', () => {
    expect(matchHostPattern(caseFacts, '/^DOCKER$/')).toBe(true);
  });

  // The security property: the agent id must NOT fold.
  it('keeps agentId matching case-sensitive', () => {
    expect(matchHostPattern(caseFacts, 'prod-01')).toBe(false);
    expect(matchHostPattern(caseFacts, 'Prod-01')).toBe(true);
  });

  it('matches a hostname case-insensitively', () => {
    const f: HostFacts = { agentId: 'a1', host: 'build-box-01', labels: [] };
    expect(matchHostPattern(f, 'Build-Box-01')).toBe(true);
    expect(matchHostPattern(f, 'BUILD-BOX-01')).toBe(true);
  });

  it('matches a mixed-case hostname the roster stored folded', () => {
    expect(matchHostPattern(caseFacts, 'build-box')).toBe(true);
    expect(matchHostPattern(caseFacts, 'Build-Box')).toBe(true);
  });

  it('matches a hostname glob case-insensitively', () => {
    const f: HostFacts = { agentId: 'a1', host: 'build-box-01', labels: [] };
    expect(matchHostPattern(f, 'BUILD-BOX-*')).toBe(true);
  });

  // The guard: when `host` falls back to the agent id, it must NOT fold. Without
  // it a secret bound to `prod-01` would reach an agent `PROD-01`.
  it('does not fold the host arm when it is the agent id fallback', () => {
    const f: HostFacts = { agentId: 'PROD-01', host: 'PROD-01', labels: [] };
    expect(matchHostPattern(f, 'prod-01')).toBe(false);
    expect(matchHostPattern(f, 'PROD-01')).toBe(true);
  });

  it('still matches nothing when the pattern matches no candidate', () => {
    expect(matchHostPattern(caseFacts, 'nope')).toBe(false);
  });
});

describe('hostSpecificity', () => {
  it('ranks exact > glob > **', () => {
    expect(hostSpecificity('box-00002')).toBeGreaterThan(hostSpecificity('box-*'));
    expect(hostSpecificity('box-*')).toBeGreaterThan(hostSpecificity('**'));
  });
  it('treats ** and empty as least specific (0)', () => {
    expect(hostSpecificity('**')).toBe(0);
    expect(hostSpecificity('')).toBe(0);
  });
  it('treats a regex as the same rank as a glob (1)', () => {
    expect(hostSpecificity('/^box-0000[23]$/')).toBe(hostSpecificity('box-*'));
  });
  it('treats a plain literal as exact (2)', () => {
    expect(hostSpecificity('box-00002')).toBe(2);
  });
});
