import { describe, it, expect } from 'vitest';
import { evaluateTextMatch, textMatchHasQuery, describeTextMatch } from './text-match.js';

describe('evaluateTextMatch', () => {
  it('passes an empty matcher', () => {
    expect(evaluateTextMatch('anything', {})).toEqual({ pass: true });
  });

  it('contains requires EVERY needle (AND)', () => {
    expect(
      evaluateTextMatch('feat: add release: notes', { contains: ['feat:', 'release:'] }).pass,
    ).toBe(true);
    expect(evaluateTextMatch('feat: add notes', { contains: ['feat:', 'release:'] }).pass).toBe(
      false,
    );
  });

  it('notContains passes only when NO needle is present', () => {
    expect(
      evaluateTextMatch('normal commit', { notContains: ['[skip ci]', '[ci skip]'] }).pass,
    ).toBe(true);
    expect(
      evaluateTextMatch('wip [ci skip]', { notContains: ['[skip ci]', '[ci skip]'] }).pass,
    ).toBe(false);
  });

  it('treats needles as literals, not patterns', () => {
    expect(evaluateTextMatch('literal .* here', { contains: ['.*'] }).pass).toBe(true);
    expect(evaluateTextMatch('no metachar', { contains: ['.*'] }).pass).toBe(false);
  });

  it('ignoreCase applies to literals only', () => {
    expect(evaluateTextMatch('FEAT: thing', { contains: ['feat:'], ignoreCase: true }).pass).toBe(
      true,
    );
    expect(evaluateTextMatch('FEAT: thing', { contains: ['feat:'] }).pass).toBe(false);
    // The regex keys keep their own casing rules — ignoreCase must NOT inject `i`.
    expect(evaluateTextMatch('FEAT: thing', { matches: ['/^feat:/'], ignoreCase: true }).pass).toBe(
      false,
    );
    expect(evaluateTextMatch('FEAT: thing', { matches: ['/^feat:/i'] }).pass).toBe(true);
  });

  it('matches requires EVERY regex; notMatches requires none', () => {
    expect(evaluateTextMatch('feat(api): x', { matches: ['/^feat/', '/\\(api\\)/'] }).pass).toBe(
      true,
    );
    expect(evaluateTextMatch('feat(web): x', { matches: ['/^feat/', '/\\(api\\)/'] }).pass).toBe(
      false,
    );
    expect(evaluateTextMatch('feat: x', { notMatches: ['/^chore\\(deps\\):/'] }).pass).toBe(true);
    expect(evaluateTextMatch('chore(deps): x', { notMatches: ['/^chore\\(deps\\):/'] }).pass).toBe(
      false,
    );
  });

  it('ANDs across keys', () => {
    const m = { contains: ['release:'], notContains: ['WIP'], matches: ['/^release:/'] };
    expect(evaluateTextMatch('release: v1', m).pass).toBe(true);
    expect(evaluateTextMatch('release: v1 WIP', m).pass).toBe(false);
  });

  it('matches the multi-line body with the m flag', () => {
    const text = 'feat: thing\n\nFixes: #42\n';
    expect(evaluateTextMatch(text, { matches: ['/^Fixes: #\\d+$/m'] }).pass).toBe(true);
  });

  it('is stateless across calls for a g-flagged pattern', () => {
    const m = { matches: ['/feat/g'] };
    expect(evaluateTextMatch('feat: one', m).pass).toBe(true);
    // A cached RegExp would carry lastIndex forward and fail the second call.
    expect(evaluateTextMatch('feat: one', m).pass).toBe(true);
  });

  it('reports an unsafe or invalid regex as indeterminate, never as a clean false', () => {
    const bad = evaluateTextMatch('x', { matches: ['/(a+)+$/'] });
    expect(bad.pass).toBe(false);
    expect(bad.indeterminate).toContain('regex');

    const broken = evaluateTextMatch('x', { matches: ['/([/'] });
    expect(broken.pass).toBe(false);
    expect(broken.indeterminate).toContain('regex');
  });

  it('treats an empty-string text as a real value', () => {
    expect(evaluateTextMatch('', { notContains: ['[skip ci]'] }).pass).toBe(true);
    expect(evaluateTextMatch('', { contains: ['x'] }).pass).toBe(false);
  });
});

describe('textMatchHasQuery', () => {
  it('is false for an empty matcher or one carrying only ignoreCase', () => {
    expect(textMatchHasQuery({})).toBe(false);
    expect(textMatchHasQuery({ ignoreCase: true })).toBe(false);
    expect(textMatchHasQuery({ contains: [] })).toBe(false);
  });

  it('is true when any query key carries an entry', () => {
    expect(textMatchHasQuery({ contains: ['a'] })).toBe(true);
    expect(textMatchHasQuery({ notMatches: ['/a/'] })).toBe(true);
  });
});

describe('describeTextMatch', () => {
  it('renders every populated key for the decision trace', () => {
    expect(describeTextMatch({ contains: ['a', 'b'], notMatches: ['/c/'] })).toBe(
      'contains: [a, b]; notMatches: [/c/]',
    );
  });
});
