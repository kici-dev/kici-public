import { describe, it, expect } from 'vitest';
import {
  installGateJobId,
  isSecurityHoldJobId,
  SECURITY_HOLD_JOB_IDS,
  WORKFLOW_MODIFICATION_JOB_ID,
} from './held-run-job-id.js';

describe('isSecurityHoldJobId', () => {
  it('recognises every sentinel in the map, including ones no arm writes today', () => {
    // The map keeps its historical members so a hold written by an earlier build
    // still resolves; a predicate that only knew today's `fork_pr` would leave
    // such a row's security check hanging.
    for (const sentinel of Object.values(SECURITY_HOLD_JOB_IDS)) {
      expect(isSecurityHoldJobId(sentinel)).toBe(true);
    }
    expect(isSecurityHoldJobId(WORKFLOW_MODIFICATION_JOB_ID)).toBe(true);
  });

  it('rejects the install-gate sentinel', () => {
    // The distinction the callers rest on: an install-gate hold posts no
    // `KiCI Security` check, so completing one for it would create a check run
    // on a commit that never had one.
    expect(isSecurityHoldJobId(installGateJobId('CI'))).toBe(false);
    expect(isSecurityHoldJobId(installGateJobId(''))).toBe(false);
  });

  it('rejects an ordinary expanded job name', () => {
    expect(isSecurityHoldJobId('build')).toBe(false);
    expect(isSecurityHoldJobId('build (18)')).toBe(false);
    expect(isSecurityHoldJobId('')).toBe(false);
  });
});
