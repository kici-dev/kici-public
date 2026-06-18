import { describe, expect, it } from 'vitest';
import {
  KICI_PROVENANCE_AUDIENCE,
  KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
  kiciBundleSchema,
  provenanceStorageKey,
} from './bundle.js';

describe('kiciBundleSchema', () => {
  it('exposes the audience + media type constants', () => {
    expect(KICI_PROVENANCE_AUDIENCE).toBe('kici-provenance');
    expect(KICI_PROVENANCE_BUNDLE_MEDIA_TYPE).toBe(
      'application/vnd.kici.provenance.bundle+json;version=0.1',
    );
  });

  it('parses a valid bundle and rejects a wrong media type', () => {
    const bundle = {
      mediaType: KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
      dsseEnvelope: {
        payloadType: 't',
        payload: 'eA==',
        signatures: [{ keyid: 'k', sig: 'eA==' }],
      },
      verificationMaterial: {
        publicKey: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
        identityToken: 'eyJ.a.b',
      },
    };
    expect(kiciBundleSchema.parse(bundle).mediaType).toBe(KICI_PROVENANCE_BUNDLE_MEDIA_TYPE);
    expect(kiciBundleSchema.safeParse({ ...bundle, mediaType: 'x' }).success).toBe(false);
  });

  it('derives the storage key under the provenance/ prefix', () => {
    expect(provenanceStorageKey('run-1', 'job-1', 'abc')).toBe(
      'provenance/run-1/job-1/abc.kici.json',
    );
  });
});
