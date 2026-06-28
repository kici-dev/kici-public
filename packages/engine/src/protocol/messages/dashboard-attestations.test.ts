import { describe, expect, it } from 'vitest';
import {
  dashboardAttestationsListRequestSchema,
  dashboardAttestationsListResponseSchema,
  dashboardAttestationsApiResponseSchema,
  attestationVerifyStatusSchema,
  dashboardAttestationsListAllRequestSchema,
  dashboardAttestationsListAllResponseSchema,
  dashboardAttestationGetRequestSchema,
  dashboardAttestationGetResponseSchema,
} from './dashboard.js';
import { AccessLogTargetType } from './access-log.js';
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

describe('org-wide attestations browser protocol', () => {
  it('rejects an unknown verify status', () => {
    expect(attestationVerifyStatusSchema.safeParse('bogus').success).toBe(false);
    expect(attestationVerifyStatusSchema.safeParse('verified').success).toBe(true);
    expect(attestationVerifyStatusSchema.safeParse('unverifiable').success).toBe(true);
  });

  it('validates list.all request + response', () => {
    expect(
      dashboardAttestationsListAllRequestSchema.safeParse({
        type: 'dashboard.attestations.list.all',
        requestId: 'r1',
        actor: { type: 'user', sub: 'u1' },
        page: 1,
        filters: { digest: 'sha256:abc', status: 'verified' },
      }).success,
    ).toBe(true);
    expect(
      dashboardAttestationsListAllResponseSchema.safeParse({
        type: 'dashboard.attestations.list.all.response',
        requestId: 'r1',
        attestations: [],
        page: 1,
        pageSize: 25,
        total: 0,
      }).success,
    ).toBe(true);
  });

  it('defaults filters to an empty object', () => {
    const parsed = dashboardAttestationsListAllRequestSchema.parse({
      type: 'dashboard.attestations.list.all',
      requestId: 'r1',
      actor: { type: 'user', sub: 'u1' },
      page: 1,
    });
    expect(parsed.filters).toEqual({});
  });

  it('validates a summary row (metadata only, no bundle)', () => {
    const ok = dashboardAttestationsListAllResponseSchema.safeParse({
      type: 'dashboard.attestations.list.all.response',
      requestId: 'r1',
      attestations: [
        {
          id: 'a1',
          runId: 'run-1',
          jobId: 'job-1',
          jobName: 'build',
          subjectName: 'pkg',
          subjectDigest: 'sha256:' + 'a'.repeat(64),
          mode: 'kici',
          mediaType: KICI_PROVENANCE_BUNDLE_MEDIA_TYPE,
          createdAt: '2026-06-11T00:00:00.000Z',
          verifyStatus: 'verified',
          verifyReason: null,
          repository: 'owner/repo',
          workflow: '.kici/workflows/build.ts',
        },
      ],
      page: 1,
      pageSize: 25,
      total: 1,
    });
    expect(ok.success).toBe(true);
  });

  it('validates attestation.get request + response (nullable attestation)', () => {
    expect(
      dashboardAttestationGetRequestSchema.safeParse({
        type: 'dashboard.attestation.get',
        requestId: 'r2',
        actor: { type: 'user', sub: 'u1' },
        attestationId: 'a1',
      }).success,
    ).toBe(true);
    expect(
      dashboardAttestationGetResponseSchema.safeParse({
        type: 'dashboard.attestation.get.response',
        requestId: 'r2',
        attestation: null,
      }).success,
    ).toBe(true);
  });

  it('accepts the new attestation access-log target type', () => {
    expect(AccessLogTargetType.safeParse('attestation').success).toBe(true);
  });
});
