import { describe, it, expect } from 'vitest';
import {
  approverClauseSchema,
  approvalRequirementSchema,
  ApprovalDecision,
  HoldScope,
  TriggerSource,
} from './types.js';

describe('approval types', () => {
  it('approverClauseSchema accepts team and user clauses', () => {
    expect(approverClauseSchema.parse({ team: 'leads' })).toEqual({ team: 'leads' });
    expect(approverClauseSchema.parse({ user: 'cto' })).toEqual({ user: 'cto' });
  });

  it('approverClauseSchema rejects empty and malformed clauses', () => {
    expect(() => approverClauseSchema.parse({})).toThrow();
    expect(() => approverClauseSchema.parse({ team: 1 })).toThrow();
    expect(() => approverClauseSchema.parse({ team: '' })).toThrow();
  });

  it('approvalRequirementSchema parses clauses + expiresAt + reason', () => {
    const req = approvalRequirementSchema.parse({
      clauses: [{ team: 'leads' }, { user: 'cto' }],
      expiresAt: '2026-06-12T00:00:00.000Z',
      reason: 'deploy gate',
    });
    expect(req.clauses).toHaveLength(2);
    expect(req.reason).toBe('deploy gate');
  });

  it('HoldScope is exactly workflow|job|step', () => {
    expect(HoldScope.options).toEqual(['workflow', 'job', 'step']);
  });

  it('TriggerSource is exactly environment|explicit', () => {
    expect(TriggerSource.options).toEqual(['environment', 'explicit']);
  });

  it('ApprovalDecision is exactly approve|reject', () => {
    expect(ApprovalDecision.options).toEqual(['approve', 'reject']);
  });
});
