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
