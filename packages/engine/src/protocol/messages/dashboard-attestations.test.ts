import { describe, expect, it } from 'vitest';
import {
  dashboardAttestationsListRequestSchema,
  dashboardAttestationsListResponseSchema,
  dashboardAttestationsApiResponseSchema,
} from './dashboard.js';
import { KICI_PROVENANCE_BUNDLE_MEDIA_TYPE } from '../../provenance/bundle.js';
import { IN_TOTO_PAYLOAD_TYPE } from '../../provenance/bundle.js';

const validBundle = {
  mediaType: KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
  dsseEnvelope: {
    payloadType: IN_TOTO_PAYLOAD_TYPE,
    payload: 'eA==',
    signatures: [{ keyid: 'k', sig: 'eA==' }],
  },
  verificationMaterial: {
    publicKey: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
    identityToken: 'eyJ.a.b',
  },
};

describe('dashboard attestations protocol', () => {
  it('validates a list request', () => {
    const req = {
      type: 'dashboard.attestations.list',
      requestId: 'r1',
      actor: { type: 'user', sub: 'u1' },
      runId: 'run-1',
    };
    expect(dashboardAttestationsListRequestSchema.parse(req).runId).toBe('run-1');
  });

  it('rejects a list request with a wrong type', () => {
    const bad = {
      type: 'dashboard.step.logs',
      requestId: 'r1',
      actor: { type: 'user', sub: 'u1' },
      runId: 'run-1',
    };
    expect(dashboardAttestationsListRequestSchema.safeParse(bad).success).toBe(false);
  });

  it('validates a response with an inline bundle', () => {
    const res = {
      type: 'dashboard.attestations.list.response',
      requestId: 'r1',
      attestations: [
        {
          id: 'a1',
          jobId: 'job-1',
          jobName: 'publish',
          subjectName: 'pkg',
          subjectDigest: 'a'.repeat(64),
          mode: 'kici',
          mediaType: KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
          createdAt: '2026-06-11T00:00:00.000Z',
          bundle: validBundle,
        },
      ],
    };
    const parsed = dashboardAttestationsListResponseSchema.parse(res);
    expect(parsed.attestations).toHaveLength(1);
    expect(parsed.attestations[0].jobName).toBe('publish');
  });

  it('rejects a response whose attestation carries a malformed bundle', () => {
    const res = {
      type: 'dashboard.attestations.list.response',
      requestId: 'r1',
      attestations: [
        {
          id: 'a1',
          jobId: 'job-1',
          jobName: null,
          subjectName: 'pkg',
          subjectDigest: 'a'.repeat(64),
          mode: 'kici',
          mediaType: KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
          createdAt: '2026-06-11T00:00:00.000Z',
          bundle: { mediaType: KICI_PROVENANCE_BUNDLE_MEDIA_TYPE },
        },
      ],
    };
    expect(dashboardAttestationsListResponseSchema.safeParse(res).success).toBe(false);
  });

  it('validates the augmented REST API response (issuer configured)', () => {
    const api = {
      trustedIssuer: 'https://thinker1.dev.kici.dev/kici-stg',
      jwksUri: 'https://thinker1.dev.kici.dev/kici-stg/.well-known/jwks.json',
      attestations: [],
    };
    const parsed = dashboardAttestationsApiResponseSchema.parse(api);
    expect(parsed.trustedIssuer).toBe('https://thinker1.dev.kici.dev/kici-stg');
  });

  it('validates the augmented REST API response (issuer unconfigured)', () => {
    const api = { trustedIssuer: null, jwksUri: null, attestations: [] };
    expect(dashboardAttestationsApiResponseSchema.parse(api).jwksUri).toBeNull();
  });
});
