/**
 * The MCP transport validates a call against its `inputSchema` before the
 * handler runs, so an undeclared argument never reaches the handler: these
 * schemas are what make the hold disambiguators callable.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { approveRunToolSchema, rejectRunToolSchema } from './tool-schemas.js';

describe('approve/reject tool schemas accept the hold disambiguators', () => {
  it.each([
    ['approve_run', z.object(approveRunToolSchema), { runId: 'run-1' }],
    ['reject_run', z.object(rejectRunToolSchema), { runId: 'run-1', reason: 'no' }],
  ])('%s parses holdType and holdId', (_name, schema, base) => {
    const parsed = schema.parse({
      ...base,
      job: 'deploy',
      step: '2',
      holdType: 'security',
      holdId: 'hold-security',
    });
    expect(parsed).toMatchObject({ holdType: 'security', holdId: 'hold-security' });
  });

  it.each([
    ['approve_run', z.object(approveRunToolSchema), { runId: 'run-1' }],
    ['reject_run', z.object(rejectRunToolSchema), { runId: 'run-1', reason: 'no' }],
  ])('%s leaves both optional', (_name, schema, base) => {
    const parsed = schema.parse(base) as Record<string, unknown>;
    expect(parsed.holdType).toBeUndefined();
    expect(parsed.holdId).toBeUndefined();
  });
});
