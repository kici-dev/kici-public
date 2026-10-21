import { describe, expect, it } from 'vitest';
import { PlatformAttachment } from '../db/repos/org-ids-repo.js';
import { resolveNewSourceOrg } from './source-org.js';

const attached = {
  platformAttachment: PlatformAttachment.enum.attached,
  attachedOrgId: 'org_A',
};
const pending = { platformAttachment: PlatformAttachment.enum.pending, attachedOrgId: null };
const none = { platformAttachment: PlatformAttachment.enum.none, attachedOrgId: null };

describe('resolveNewSourceOrg', () => {
  it('files a source with no org under the attached org', () => {
    // fails-when: the default ignores the attachment and stays __default__.
    expect(resolveNewSourceOrg({ requested: undefined, attachment: attached })).toEqual({
      ok: true,
      orgId: 'org_A',
    });
  });

  it('accepts the attached org itself', () => {
    expect(resolveNewSourceOrg({ requested: 'org_A', attachment: attached })).toEqual({
      ok: true,
      orgId: 'org_A',
    });
  });

  it('refuses another org with a 400 naming the attached org', () => {
    const result = resolveNewSourceOrg({ requested: 'org_B', attachment: attached });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.error).toContain(
      'orgId "org_B" does not match this orchestrator\'s Platform organization "org_A"',
    );
    expect(result.error).toContain('--org org_A');
  });

  it('refuses a pending attachment with no org (503)', () => {
    const result = resolveNewSourceOrg({ requested: undefined, attachment: pending });
    expect(result).toMatchObject({ ok: false, status: 503 });
    if (result.ok) return;
    expect(result.error).toContain('not authenticated with the Platform yet');
  });

  it('accepts an explicit org while the attachment is pending', () => {
    expect(resolveNewSourceOrg({ requested: 'org_B', attachment: pending })).toEqual({
      ok: true,
      orgId: 'org_B',
    });
  });

  it('keeps __default__ on an independent orchestrator', () => {
    // breaks-if-wrong: an independent orchestrator must behave as before.
    expect(resolveNewSourceOrg({ requested: undefined, attachment: none })).toEqual({
      ok: true,
      orgId: '__default__',
    });
  });

  it('accepts any explicit org on an independent orchestrator', () => {
    expect(resolveNewSourceOrg({ requested: 'org_B', attachment: none })).toEqual({
      ok: true,
      orgId: 'org_B',
    });
  });
});
