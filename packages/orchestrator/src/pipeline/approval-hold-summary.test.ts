import { describe, it, expect } from 'vitest';
import { summarizeApprovalClauses } from './processor.js';

describe('summarizeApprovalClauses', () => {
  it('names team and user clauses', () => {
    expect(summarizeApprovalClauses([{ team: 'leads' }, { user: 'cto' }])).toBe(
      'Awaiting approval: team leads, user cto',
    );
  });

  it('handles a single team clause', () => {
    expect(summarizeApprovalClauses([{ team: 'leads' }])).toBe('Awaiting approval: team leads');
  });

  it('falls back to a generic message when no clauses are present', () => {
    expect(summarizeApprovalClauses([])).toBe('Awaiting approval from an eligible reviewer');
  });
});
