import { describe, expect, it } from 'vitest';
import { provenanceSubjectIsPath, type AttestProvenanceOptions } from './provenance-types.js';

describe('provenance-types', () => {
  it('discriminates a path subject from a digest subject', () => {
    const a: AttestProvenanceOptions = { subject: { name: 'x', path: '/tmp/x' } };
    const b: AttestProvenanceOptions = {
      subject: { name: 'x', digest: { sha256: 'a'.repeat(64) } },
    };
    expect(provenanceSubjectIsPath(a.subject)).toBe(true);
    expect(provenanceSubjectIsPath(b.subject)).toBe(false);
  });
});
