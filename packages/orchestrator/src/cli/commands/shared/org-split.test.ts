import { describe, expect, it } from 'vitest';
import { orgSplitNote } from './org-split.js';

describe('orgSplitNote', () => {
  it('names every foreign org, the attached org and the move command', () => {
    const note = orgSplitNote('org_A', ['__default__', 'org_B']);
    expect(note).toContain("'__default__', 'org_B'");
    expect(note).toContain("not under 'org_A'");
    expect(note).toContain('kici-admin source update <routingKey> --org org_A');
  });
});
